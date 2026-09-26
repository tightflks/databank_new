import { isSensitiveColumn, stripSensitiveColumns } from './columns';

describe('sensitive columns', () => {
  it('catches the variants the Apartments file uses', () => {
    for (const h of ['ONSITE PHONE', 'O PHONE2\\FAX', '$ EQUITY', '% EQUITY', '$ DOWNPAYMENT', '% DOWNPAYMENT', '$ UNDERLYING',
      '$ PURCHASE NOTE', 'FORECLOSURE PRICE', 'LOAN DUE DATE', 'C LOAN DUE DATE', 'LOAN2 START DATE', 'O REP', 'S STREET NAME']) {
      expect([h, isSensitiveColumn(h)]).toEqual([h, true]);
    }
  });
  it('keeps every column the search and results table read', () => {
    for (const h of ['P NAME', 'P STREET NAME', 'P CITY', 'P ZIP', 'COUNTY', 'OWNER', 'TAX OWNER', 'SELLER', 'SELLER\\FORECLOSEE',
      'ATTENTION', 'OWNER2\\ATTENTION', '$ LOAN', 'PERMANENT LOAN', 'LENDER', 'BROKER', 'SALE PRICE', 'SALE DATE', 'LAND SALE DATE',
      'INSIDER DATE', 'PREVIOUS INSIDER DATE 1', '# ACRES', '# SQ FT BUILT', 'UNITS COMPLETED:', 'M1', 'M10', 'PARCEL', 'YEAR BUILT']) {
      expect([h, isSensitiveColumn(h)]).toEqual([h, false]);
    }
  });
  it('drops the columns from every row', () => {
    expect(stripSensitiveColumns([['P NAME', 'O PHONE', 'SALE PRICE'], ['A', '555', '1']])).toEqual([['P NAME', 'SALE PRICE'], ['A', '1']]);
  });
});
