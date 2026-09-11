import { ASK_QUESTIONS, fixCentury } from './dropbox';

describe('fixCentury', () => {
  it('moves two-digit-year typos into the 2000s', () => {
    expect(fixCentury('1921-03-23')).toBe('2021-03-23');
    expect(fixCentury('1914-11-05')).toBe('2014-11-05');
  });
  it('leaves genuine 1950+ dates alone', () => {
    expect(fixCentury('1982-09-02')).toBe('1982-09-02');
    expect(fixCentury('2024-01-05')).toBe('2024-01-05');
    expect(fixCentury('')).toBe('');
  });
});

describe('ASK_QUESTIONS', () => {
  it('includes sold_once for "sold and never resold" questions', () => {
    expect(ASK_QUESTIONS).toContain('sold_once');
  });
});
