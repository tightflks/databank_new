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
