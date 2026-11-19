// Thin REST client. Sends the session cookie and the CSRF token.

let csrfToken = '';

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || "S'ha produït un error inesperat.");
    this.status = status;
    this.code = body && body.code;
    this.details = body && body.details;
  }
}

async function request(method, url, body) {
  const options = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (method !== 'GET') options.headers['X-CSRF-Token'] = csrfToken;
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new ApiError(0, { message: "No s'ha pogut connectar amb el servidor." });
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    // The session ended elsewhere: go back to the login screen.
    if (response.status === 401 && url !== '/api/session') window.location.reload();
    throw new ApiError(response.status, data && data.error);
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  patch: (url, body = {}) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
};

export async function loadSession() {
  const session = await request('GET', '/api/session');
  csrfToken = session.csrf_token;
  return session;
}

export function setCsrfToken(token) {
  csrfToken = token;
}
