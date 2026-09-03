import { describe, it, expect } from 'vitest';
import { parseComments } from './comments';

const BLAKE =
  "BERKADIA(P.VETTER,A.MAYS,J.MACMANUS,M.WHITE,I.SHAW)BROKERED 5/25/23, ZEVULON CAPTL TO ZAVALA CAPTL;LAST SOLD:4/26/22($14MIL($70,000/UT); 200 UTS,BLT 1973; 12.32 ACS;94%OCCUP;NO INFO:CAP RATE,NOI,NOR EXPENSES; PRICE:$19.6MIL($98,000/UT);$4.912MIL EQTY+NEW BRIDGE LN:$14.688MIL,3Y; LENDER:BANCORP BANK;DDBK16136,PG1871;COBB ASSESSORS ESTIM 2022 VALUE: $10.543MIL($52,715/SF),WHICH IS APRX 54% OF THE $19.6MIL SALE PRICE ON 5/25/23,SHOWN ABOVE; OTHER PREVIOUS SALES:9/9/19($11.25MIL($56,250/ UT);ALSO 3/6/17($5.425MIL($27,125/ UT).";

const byLabel = (text: string) => Object.fromEntries(parseComments(text).map((f) => [f.label, f.value]));

describe('parseComments', () => {
  it('returns nothing for empty text', () => {
    expect(parseComments('')).toEqual([]);
  });

  it('extracts the main facts from a Reflex comment', () => {
    const f = byLabel(BLAKE);
    expect(f.Broker).toBe('BERKADIA(P.VETTER, A.MAYS, J.MACMANUS, M.WHITE, I.SHAW)');
    expect(f.Sale).toBe('5/25/23 — ZEVULON CAPTL → ZAVALA CAPTL');
    expect(f.Price).toBe('$19.6M ($98,000/unit)');
    expect(f['Last sold']).toBe('4/26/22 — $14M ($70,000/unit)');
    expect(f.Size).toBe('200 units, built 1973');
    expect(f.Acres).toBe('12.32');
    expect(f.Occupancy).toBe('94%');
    expect(f.Lender).toBe('BANCORP BANK');
    expect(f['Deed book']).toBe('16136 p. 1871');
    expect(f['Assessed value']).toContain('$10.543M');
    expect(f['Previous sales']).toBe('9/9/19 — $11.25M ($56,250/unit) · 3/6/17 — $5.425M ($27,125/unit)');
  });

  it('does not treat "we aren\'t certain who brokered" as a broker name', () => {
    const f = byLabel("WE AREN'T CERTAIN WHO BROKERED 8/10/26,BLACKSTONE TO POST INVESTMENT;PRICE:$42MIL($182,609/UT);");
    expect(f.Broker).toBe('Unknown');
    expect(f.Sale).toBe('8/10/26 — BLACKSTONE → POST INVESTMENT');
  });
});
