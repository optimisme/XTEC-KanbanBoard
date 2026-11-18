import { badRequest } from '../utils/errors.js';

// Small input validators. Each returns the cleaned value or throws a 400.

export function id(value, field = 'id') {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`El camp «${field}» no és vàlid.`);
  return n;
}

export function optionalId(value, field) {
  return value === null || value === undefined || value === '' ? null : id(value, field);
}

export function idArray(value, field, { min = 0 } = {}) {
  if (!Array.isArray(value)) throw badRequest(`El camp «${field}» ha de ser una llista.`);
  const ids = [...new Set(value.map((v) => id(v, field)))];
  if (ids.length < min) throw badRequest(`Cal indicar almenys ${min} element(s) a «${field}».`);
  return ids;
}

export function text(value, field, { min = 1, max = 255, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw badRequest(`El camp «${field}» és obligatori.`);
    return '';
  }
  if (typeof value !== 'string') throw badRequest(`El camp «${field}» ha de ser text.`);
  const cleaned = value.trim();
  if (cleaned.length < (required ? min : 0)) throw badRequest(`El camp «${field}» és obligatori.`);
  if (cleaned.length > max) throw badRequest(`El camp «${field}» no pot superar ${max} caràcters.`);
  return cleaned;
}

export function email(value, field = 'correu') {
  const cleaned = text(value, field, { max: 255 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) throw badRequest(`El camp «${field}» ha de ser un correu vàlid.`);
  return cleaned;
}

export function oneOf(value, field, allowed) {
  if (!allowed.includes(value)) throw badRequest(`El valor de «${field}» no és vàlid.`);
  return value;
}

export function color(value, field = 'color') {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw badRequest(`El camp «${field}» ha de ser un color hexadecimal (#rrggbb).`);
  }
  return value.toLowerCase();
}

export function academicYear(value) {
  const cleaned = text(value, 'curs acadèmic', { max: 9 });
  if (!/^\d{4}-(\d{2}|\d{4})$/.test(cleaned)) {
    throw badRequest('El curs acadèmic ha de tenir el format 2026-2027.');
  }
  return cleaned;
}

export function httpUrl(value, field = 'url', { max = 1000 } = {}) {
  const cleaned = text(value, field, { max });
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw badRequest(`El camp «${field}» ha de ser una URL vàlida.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw badRequest(`El camp «${field}» ha de ser una URL http o https.`);
  }
  return parsed.href;
}

const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}\/?$/;

// Returns a normalized repository URL, or null to clear it.
export function githubRepoUrl(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const cleaned = String(value).trim().replace(/\.git$/, '').replace(/\/$/, '');
  if (cleaned.length > 500 || !GITHUB_REPO.test(cleaned)) {
    throw badRequest('La URL ha de ser un repositori de GitHub (https://github.com/usuari/repositori).');
  }
  return cleaned;
}
