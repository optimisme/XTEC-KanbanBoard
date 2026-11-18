// Application error carrying an HTTP status, a stable code and a Catalan,
// user-facing message.
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'validation_error', message, details);
export const unauthenticated = () => new HttpError(401, 'unauthenticated', 'Cal iniciar sessió.');
export const forbidden = (message = 'No tens permís per fer aquesta acció.') =>
  new HttpError(403, 'forbidden', message);
export const notFound = (message = "No s'ha trobat el recurs.") => new HttpError(404, 'not_found', message);
export const conflict = (message, code = 'conflict') => new HttpError(409, code, message);
