import * as XLSX from 'xlsx';
import { ASK_QUESTIONS, excelToCsv, fixCentury, isTestRecord, parseCsv } from './dropbox';

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

describe('excelToCsv', () => {
  // Shaped like a Reflex Excel export: a title row, a blank first column, real date cells.
  const workbook = (bookType: XLSX.BookType) => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['IND'],
      ['', 'P NAME', 'P CITY', 'SALE DATE', 'SALE PRICE', 'M1'],
      ['', 'CROSSGATE, BLDG 2', 'PORT WENTWORTH', new Date('2024-03-08T00:00:00Z'), 1399900, 'line one\nsaid "sold"'],
      [],
      ['', 'BISHOP ST', 'ATLANTA', '', 17.464000000000002, ''],
    ], { cellDates: true, dateNF: 'mm/dd/yyyy' });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'IND');
    return XLSX.write(wb, { type: 'buffer', bookType }) as Buffer;
  };

  it.each(['xlsx', 'biff8'] as XLSX.BookType[])('turns a %s export into the weekly CSV shape', (bookType) => {
    const out = excelToCsv(workbook(bookType))!;
    expect(out.rows).toBe(2);
    expect(parseCsv(out.csv)).toEqual([
      ['P NAME', 'P CITY', 'SALE DATE', 'SALE PRICE', 'M1'],
      ['CROSSGATE, BLDG 2', 'PORT WENTWORTH', '2024-03-08', '1399900', 'line one\nsaid "sold"'],
      ['BISHOP ST', 'ATLANTA', '', '17.464000000000002', ''],
    ]);
  });

  it('returns null when there is no P NAME header', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['something else']]), 'S');
    expect(excelToCsv(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))).toBeNull();
  });
});
