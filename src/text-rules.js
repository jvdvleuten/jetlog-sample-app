// The text rules of Jetlog, checked here before a request is sent, so the pilot gets
// an answer on the page instead of a 422. Jetlog checks the same rules again.
// See "Text Jetlog cannot store" and "Limits" in PARTNER_API.md.

// Characters per field, counted the way Jetlog counts: by what a person sees as one
// character, not by UTF-16 unit.
export const LIMITS = {
  importText: 255, // flight_number, from and to on the import route
  remarks: 1000,
  summary: 500,
  proposalText: 2000, // any text value in a proposal operation
};

// Control characters, bidi controls and zero-width characters. A proposal refuses
// them in codes and numbers. The import route stores them, so this sample removes
// them from the codes it sends.
const HIDDEN = /[\x00-\x1F\x7F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export class TextRuleError extends Error {}

export function removeHiddenCharacters(text) {
  return text.replace(HIDDEN, '');
}

// Jetlog refuses NUL and text that is not valid UTF-8 in every field. A lone
// surrogate is the JavaScript form of invalid UTF-8: it cannot be encoded.
export function isStorable(text) {
  return !text.includes('\u0000') && text.isWellFormed();
}

export function characterCount(text) {
  let count = 0;
  for (const _ of new Intl.Segmenter().segment(text)) count += 1;
  return count;
}

// Throws a TextRuleError that names the field, when the text cannot be stored.
export function requireStorable(label, text) {
  if (!isStorable(text)) {
    throw new TextRuleError(`${label} must not contain the NUL character (U+0000) or a broken character.`);
  }
}

export function requireMaxLength(label, text, max) {
  if (characterCount(text) > max) {
    throw new TextRuleError(`${label} must have at most ${max} characters.`);
  }
}
