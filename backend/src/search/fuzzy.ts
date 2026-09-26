// Copied from frontend/src/utils/fuzzy.ts so server-side search matches exactly what the search screen did.
// Typo-tolerant token matching for the manual search box.
// A token matches a record when it is a substring of any value (exact),
// or when a word in the record is within a small edit distance of it.

function editDistanceAtMost(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

export function allowedTypos(token: string): number {
  if (token.length < 4) return 0;
  return token.length <= 5 ? 1 : 2;
}

export function fuzzyWordMatch(token: string, words: string[]): boolean {
  const max = allowedTypos(token);
  if (max === 0) return false;
  for (const w of words) {
    if (w.startsWith(token)) return true;
    if (editDistanceAtMost(token, w, max)) return true;
    if (w.length > token.length + max && editDistanceAtMost(token, w.slice(0, token.length), max)) return true;
  }
  return false;
}

export function tokenMatches(token: string, haystack: string, words: string[]): boolean {
  return haystack.includes(token) || fuzzyWordMatch(token, words);
}

export function wordsOf(text: string): string[] {
  return text.split(/[^a-z0-9]+/).filter(w => w.length >= 3);
}

// USPS-style abbreviations so "spring road" finds "SPRING RD." and vice versa.
const STREET_ABBR: Record<string, string> = {
  road: 'rd', street: 'st', drive: 'dr', avenue: 'ave', boulevard: 'blvd', parkway: 'pkwy',
  highway: 'hwy', lane: 'ln', court: 'ct', circle: 'cir', place: 'pl', trail: 'trl', terrace: 'ter',
  square: 'sq', point: 'pt', pointe: 'pt', ridge: 'rdg', crossing: 'xing', expressway: 'expy',
  freeway: 'fwy', center: 'ctr', centre: 'ctr', mount: 'mt', north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw', saint: 'st', fort: 'ft',
  // Researcher notes abbreviate property types ("LAND FOR THE APTS")
  apartment: 'apts', apartments: 'apts', apt: 'apts', acres: 'acs', acre: 'acs', approximately: 'approx',
};

// Filler words customers type in property names ("the mason augusta") that the records omit.
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'at', 'in', 'on', 'and', '&']);

export function canonicalText(text: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z0-9@/-]+/)
    .filter(Boolean)
    .map(w => STREET_ABBR[w] ?? w)
    .join(' ');
}

export function searchTokens(query: string): string[] {
  const all = canonicalText(query).split(' ').filter(Boolean);
  const kept = all.filter(t => !STOP_WORDS.has(t));
  return kept.length ? kept : all;
}
