// Suggestions of known people while typing a name or an email.
import { api } from './api.js';
import { clear, h } from './ui.js';

// Shows, under an input, the known accounts of one kind ('students' or
// 'teachers') that match what has been typed. Nothing is shown while the
// input is empty. Choosing one calls onPick({ id, name, email }).
// `exclude()` returns emails that should not be offered (already added).
// Returns the list element, which the caller places right under the input.
export function emailSuggestions(input, people, { onPick, exclude = () => [] }) {
  const list = h('ul', { class: 'suggestion-list', hidden: true });
  let timer = null;
  let latest = '';

  const hide = () => { clear(list); list.hidden = true; };

  function show(found) {
    const skip = new Set(exclude().map((email) => email.toLowerCase()));
    const offered = found.filter((person) => !skip.has(person.email.toLowerCase()));
    if (offered.length === 0) return hide();
    clear(list).append(...offered.map((person) => {
      const button = h('button', { type: 'button' }, h('strong', {}, person.name), h('span', { class: 'muted' }, person.email));
      button.addEventListener('click', () => { hide(); onPick(person); });
      return h('li', {}, button);
    }));
    list.hidden = false;
    return undefined;
  }

  input.addEventListener('input', () => {
    const query = input.value.trim();
    latest = query;
    clearTimeout(timer);
    if (!query) return hide();
    timer = setTimeout(async () => {
      try {
        const found = await api.get(`/api/${people}/suggest?q=${encodeURIComponent(query)}`);
        if (latest === query) show(found); // Ignore answers to older searches.
      } catch {
        hide(); // Suggestions are a convenience; typing the full email still works.
      }
    }, 150);
    return undefined;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !list.hidden) { event.stopPropagation(); hide(); }
  });

  return list;
}
