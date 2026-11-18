import * as client from 'openid-client';
import config from '../config/index.js';
import { HttpError } from '../utils/errors.js';

let discovered = null;

// Provider metadata is discovered on the first login and then reused.
async function getConfiguration() {
  if (!config.oidc.configured) {
    throw new HttpError(503, 'oidc_not_configured', "L'autenticació institucional no està configurada.");
  }
  if (!discovered) {
    discovered = client.discovery(new URL(config.oidc.issuer), config.oidc.clientId, config.oidc.clientSecret);
    discovered.catch(() => {
      discovered = null;
    });
  }
  return discovered;
}

// Starts the authorization code flow (with PKCE, state and nonce). The
// returned "pending" object must be kept in the server-side session.
export async function beginLogin() {
  const configuration = await getConfiguration();
  const pending = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier: client.randomPKCECodeVerifier(),
  };
  const parameters = {
    redirect_uri: config.oidc.callbackUrl,
    scope: 'openid email profile',
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(pending.codeVerifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  };
  // Hint only: the domain is enforced on the verified claims after login.
  if (config.oidc.provider === 'google' && config.allowedEmailDomains.length === 1) {
    parameters.hd = config.allowedEmailDomains[0];
  }
  return { url: client.buildAuthorizationUrl(configuration, parameters).href, pending };
}

// Exchanges the callback for tokens, validates state, nonce and the ID token,
// and returns the verified identity.
export async function completeLogin(queryString, pending) {
  const configuration = await getConfiguration();
  const currentUrl = new URL(config.oidc.callbackUrl);
  currentUrl.search = queryString;

  const tokens = await client.authorizationCodeGrant(configuration, currentUrl, {
    pkceCodeVerifier: pending.codeVerifier,
    expectedState: pending.state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });
  return identityFromClaims(tokens.claims());
}

export function identityFromClaims(claims) {
  const base = { issuer: claims.iss, subject: claims.sub, name: claims.name || '' };

  if (config.oidc.provider === 'microsoft') {
    // Entra ID work accounts: the UPN is controlled by the tenant, and the
    // issuer is tenant-specific (enforced in config). The optional "email"
    // claim is only trusted when Entra marks its domain as verified.
    const upn = claims.preferred_username;
    const email = upn || (claims.xms_edov === true || claims.email_verified === true ? claims.email : null);
    return { ...base, email, emailVerified: Boolean(email) };
  }

  // Google Workspace: when present, the hosted domain must be an allowed one.
  const hostedDomainOk = !claims.hd || config.allowedEmailDomains.includes(String(claims.hd).toLowerCase());
  return { ...base, email: claims.email, emailVerified: claims.email_verified === true && hostedDomainOk };
}
