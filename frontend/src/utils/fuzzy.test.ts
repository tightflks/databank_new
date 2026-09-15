import { describe, it, expect } from 'vitest';
import { tokenMatches, wordsOf, allowedTypos, canonicalText, searchTokens } from './fuzzy';

const rec = 'cielo@vinings/windwood apartments austell cobb berkadia';
const words = wordsOf(rec);

describe('fuzzy search', () => {
  it('matches exact substrings as before', () => {
    expect(tokenMatches('windwood', rec, words)).toBe(true);
    expect(tokenMatches('cobb', rec, words)).toBe(true);
  });

  it('tolerates one typo in short words and two in long ones', () => {
    expect(tokenMatches('austel', rec, words)).toBe(true);
    expect(tokenMatches('ostell', rec, words)).toBe(true);
    expect(tokenMatches('windwod', rec, words)).toBe(true);
    expect(tokenMatches('apartmnets', rec, words)).toBe(true);
    expect(tokenMatches('vinnings', rec, words)).toBe(true);
  });

  it('matches a misspelled prefix of a longer word', () => {
    expect(tokenMatches('berkadea', rec, words)).toBe(true);
    expect(tokenMatches('apartmen', rec, words)).toBe(true);
  });

  it('does not fuzz very short tokens or unrelated words', () => {
    expect(allowedTypos('cob')).toBe(0);
    expect(tokenMatches('cab', rec, words)).toBe(false);
    expect(tokenMatches('marietta', rec, words)).toBe(false);
    expect(tokenMatches('xyzqwerty', rec, words)).toBe(false);
  });
});

describe('address abbreviations and filler words', () => {
  it('treats "road" and "rd." as the same word', () => {
    const rec = canonicalText('1898 SPRING RD. SMYRNA COBB');
    expect(searchTokens('1898 spring road smyrna').every(t => rec.includes(t))).toBe(true);
    expect(searchTokens('1898 spring rd. smyrna').every(t => rec.includes(t))).toBe(true);
  });

  it('drops "the" so "the mason augusta" finds MASON AUGUSTA', () => {
    expect(searchTokens('the mason augusta')).toEqual(['mason', 'augusta']);
    expect(searchTokens('the')).toEqual(['the']);
  });
});
