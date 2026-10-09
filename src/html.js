// A tiny template tag that escapes every value you put into a page. Text from
// Jetlog (remarks, error descriptions) is not trusted, so nothing reaches the page
// without going through here. Wrap markup you wrote yourself in raw().

class Safe {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const raw = (text) => new Safe(text);

function render(value) {
  if (value instanceof Safe) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, index) => {
    out += render(value) + strings[index + 1];
  });
  return new Safe(out);
}
