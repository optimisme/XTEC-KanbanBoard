// Suggestions of known people while typing an email.
import { api } from './api.js';
import { h } from './ui.js';

let counter = 0;

// Connects an email input to a list of known accounts of one role ('students'
// or 'teachers'). Returns the <datalist> element, which the caller must place
// somewhere in the page next to the input.
export function emailSuggestions(input, people) {
  const list = h('datalist', { id: `people-${people}-${(counter += 1)}` });
  input.setAttribute('list', list.id);
  let timer = null;
  let lastQuery = '';

  input.addEventListener('input', () => {
    const query = input.value.trim();
    clearTimeout(timer);
    if (query.length < 2) return list.replaceChildren();
    // Picking a suggestion fills the whole email: nothing more to look up.
    if ([...list.options].some((option) => option.value === query)) return undefined;
    timer = setTimeout(async () => {
      lastQuery = query;
      try {
        const found = await api.get(`/api/${people}/suggest?q=${encodeURIComponent(query)}`);
        if (lastQuery !== query) return; // A newer search is on its way.
        list.replaceChildren(...found.map((person) => h('option', { value: person.email, label: `${person.name} · ${person.email}` })));
      } catch {
        list.replaceChildren(); // Suggestions are a convenience; typing the email still works.
      }
    }, 200);
    return undefined;
  });
  return list;
}
