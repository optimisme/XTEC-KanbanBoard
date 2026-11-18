import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const sanitizeOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote',
    'ul', 'ol', 'li', 'strong', 'em', 'del', 'code', 'pre', 'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'rel', 'target'],
    img: ['src', 'alt', 'title'],
    code: ['class'],
    th: ['align'],
    td: ['align'],
    input: ['type', 'checked', 'disabled'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }),
    // Only the read-only checkboxes of task lists are allowed.
    input: (tagName, attribs) => ({
      tagName,
      attribs: { type: 'checkbox', disabled: 'disabled', ...(attribs.checked !== undefined ? { checked: 'checked' } : {}) },
    }),
  },
};

// Renders Markdown to HTML that is safe to inject into the page.
export function renderMarkdown(markdown) {
  if (!markdown) return '';
  const html = marked.parse(String(markdown), { gfm: true, async: false });
  return sanitizeHtml(html, sanitizeOptions);
}
