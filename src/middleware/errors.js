import config from '../config/index.js';
import { HttpError } from '../utils/errors.js';

export function apiNotFound(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: "No s'ha trobat el recurs." } });
}

// Every error leaves the API as { error: { code, message, details? } }.
// Unexpected errors are logged and never leak internals to the client.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let status = 500;
  let body = { code: 'internal_error', message: "S'ha produït un error inesperat." };

  if (err instanceof HttpError) {
    status = err.status;
    body = { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
  } else if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    status = err.status || 400;
    body = { code: 'validation_error', message: 'La petició no és vàlida.' };
  } else {
    if (!config.isTest) console.error(err);
  }

  if (res.headersSent) return;
  res.status(status).json({ error: body });
}
