import path from 'node:path';

// Load the env file before reading anything. Tests use their own file so they
// can never pick up the development or production database by accident.
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
try {
  process.loadEnvFile(path.resolve(process.cwd(), envFile));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const env = process.env;
const nodeEnv = env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

const errors = [];

function required(name) {
  const value = (env[name] || '').trim();
  if (!value) errors.push(`${name} is required`);
  return value;
}

function optional(name, fallback = '') {
  const value = (env[name] || '').trim();
  return value || fallback;
}

function integer(name, fallback) {
  const raw = optional(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) errors.push(`${name} must be a positive integer`);
  return value;
}

const devAuthEnabled = optional('DEV_AUTH_ENABLED', 'false').toLowerCase() === 'true';
if (devAuthEnabled && isProduction) {
  errors.push('DEV_AUTH_ENABLED must not be "true" when NODE_ENV=production');
}

const oidc = {
  provider: optional('OIDC_PROVIDER', 'google').toLowerCase(),
  issuer: optional('OIDC_ISSUER'),
  clientId: optional('OIDC_CLIENT_ID'),
  clientSecret: optional('OIDC_CLIENT_SECRET'),
  callbackUrl: optional('OIDC_CALLBACK_URL'),
};
oidc.configured = Boolean(oidc.issuer && oidc.clientId && oidc.clientSecret && oidc.callbackUrl);
// The callback route is mounted on the path of the registered redirect URI.
oidc.callbackPath = '/auth/callback';
if (oidc.callbackUrl) {
  try {
    oidc.callbackPath = new URL(oidc.callbackUrl).pathname;
  } catch {
    errors.push('OIDC_CALLBACK_URL must be a valid URL');
  }
  if (!oidc.callbackPath.startsWith('/auth/')) errors.push('OIDC_CALLBACK_URL path must start with /auth/');
}

if (!['google', 'microsoft'].includes(oidc.provider)) {
  errors.push('OIDC_PROVIDER must be "google" or "microsoft"');
}
if (isProduction && !oidc.configured) {
  errors.push('OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_CALLBACK_URL are required in production');
}
// Optional local administrator account (username + password from .env).
const adminLogin = { username: optional('ADMIN_USERNAME'), password: env.ADMIN_PASSWORD || '' };
adminLogin.enabled = Boolean(adminLogin.username && adminLogin.password);
if ((adminLogin.username || adminLogin.password) && !adminLogin.enabled) {
  errors.push('ADMIN_USERNAME and ADMIN_PASSWORD must be set together (or both left empty)');
}
if (adminLogin.username && !/^[A-Za-z0-9._-]{1,50}$/.test(adminLogin.username)) {
  errors.push('ADMIN_USERNAME may only contain letters, numbers, dots, dashes and underscores');
}
if (isProduction && adminLogin.enabled) {
  // A guessable administrator password on a public server is never acceptable.
  const weak =
    adminLogin.password.length < 12 ||
    adminLogin.password.toLowerCase().includes(adminLogin.username.toLowerCase()) ||
    /^(password|contrasenya|123456|qwerty)/i.test(adminLogin.password);
  if (weak) {
    errors.push('ADMIN_PASSWORD is too weak for production: use at least 12 characters and do not include the username');
  }
}

if (!isProduction && !oidc.configured && !devAuthEnabled && !adminLogin.enabled) {
  errors.push('Configure the OIDC_* variables or set DEV_AUTH_ENABLED=true for local development');
}
if (oidc.provider === 'microsoft' && /\/(common|organizations|consumers)\//.test(oidc.issuer)) {
  // A multi-tenant issuer would accept accounts from any organisation.
  errors.push('OIDC_ISSUER must be tenant-specific for Microsoft Entra ID');
}

const sessionSecret = required('SESSION_SECRET');
if (sessionSecret && sessionSecret.length < 32) {
  errors.push('SESSION_SECRET must be at least 32 characters long');
}

const config = {
  nodeEnv,
  isProduction,
  isTest,
  port: integer('PORT', 3000),
  appUrl: required('APP_URL').replace(/\/+$/, ''),
  db: {
    host: required('DB_HOST'),
    port: integer('DB_PORT', 3306),
    name: required('DB_NAME'),
    user: required('DB_USER'),
    password: env.DB_PASSWORD || '',
  },
  oidc,
  adminLogin,
  // One or more institutional domains, comma separated.
  allowedEmailDomains: required('ALLOWED_EMAIL_DOMAIN')
    .toLowerCase()
    .split(',')
    .map((d) => d.trim().replace(/^@/, ''))
    .filter(Boolean),
  initialAdminEmail: optional('INITIAL_ADMIN_EMAIL').toLowerCase(),
  sessionSecret,
  devAuthEnabled: devAuthEnabled && !isProduction,
};

if (isTest && config.db.name && !config.db.name.endsWith('_test')) {
  errors.push('In test mode DB_NAME must end with "_test" to protect real data');
}

if (errors.length > 0) {
  console.error('Invalid configuration:\n' + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}

export default config;
