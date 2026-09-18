import { ASK_QUESTIONS, fixCentury, isTestRecord } from './dropbox';

describe('isTestRecord', () => {
  it("drops Reflex's all-ones test record, as text or as a number", () => {
    expect(isTestRecord('1111111111111111111111')).toBe(true);
    expect(isTestRecord(1.1111111111111111e21)).toBe(true);
    expect(isTestRecord('1.1111111111111116e+30')).toBe(true);
  });
  it('keeps real names, including numeric-looking ones', () => {
    expect(isTestRecord('7 Brew Coffee')).toBe(false);
    expect(isTestRecord('1010 Midtown')).toBe(false);
    expect(isTestRecord(1234)).toBe(false);
    expect(isTestRecord('')).toBe(false);
  });
});

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
