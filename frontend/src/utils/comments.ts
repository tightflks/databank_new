// Reflex COMMENTS (M1..M10) are one run of shorthand:
//   "BERKADIA(P.VETTER)BROKERED 5/25/23, ZEVULON CAPTL TO ZAVALA CAPTL;LAST SOLD:4/26/22($14MIL($70,000/UT);
//    200 UTS,BLT 1973; 12.32 ACS;94%OCCUP; PRICE:$19.6MIL($98,000/UT); LENDER:BANCORP BANK;DDBK16136,PG1871;
//    COBB ASSESSORS ESTIM 2022 VALUE: $10.543MIL(...); OTHER PREVIOUS SALES:9/9/19($11.25MIL(...);ALSO 3/6/17(...)."
// Pull out the facts that follow a stable pattern; the free text is always shown alongside.

export interface CommentFact {
  label: string;
  value: string;
}

const DATE = String.raw`\d{1,2}/\d{1,2}/\d{2,4}`;
const MONEY = String.raw`\$\s?[\d,.]+\s?(?:MIL|M|K)?`;

function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/(\D)\s*,\s*/g, '$1, ')
    .replace(/(\d)\s*,\s+(\d)/g, '$1,$2')
    .replace(/[;,.\s]+$/, '')
    .trim();
}

// "$14MIL($70,000/UT)" -> "$14M ($70,000/unit)"
function money(s: string): string {
  let v = tidy(s)
    .replace(/\$\s+/g, '$')
    .replace(/(\d)\s?MIL\b/gi, '$1M')
    .replace(/\(\$?\(?\$/, ' ($')
    .replace(/\/\s?(UT|UNIT|UNITS)\b/gi, '/unit')
    .replace(/\/\s?SF\b/gi, '/SF')
    .replace(/\)+$/, '');
  const open = (v.match(/\(/g) || []).length;
  const close = (v.match(/\)/g) || []).length;
  if (open > close) v += ')'.repeat(open - close);
  return v;
}

export function parseComments(text: string): CommentFact[] {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const facts: CommentFact[] = [];
  const add = (label: string, value: string | undefined) => {
    const v = value ? tidy(value) : '';
    if (v && !facts.some((f) => f.label === label)) facts.push({ label, value: v });
  };

  const broker = t.match(/^([A-Z0-9&.' -]+(?:\([^)]*\))?)\s*\*?BROKERED\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (broker && !/\b(WHO|KNOW|CERTAIN|DON'T)\b/i.test(broker[1])) add('Broker', broker[1].replace(/\*/g, ''));
  else if (/^NO BROKER|;\s*NO BROKER/i.test(t)) add('Broker', 'None');
  else if (/^(WE )?(DON'T|DO NOT|AREN'T|ARE NOT) (KNOW|CERTAIN)[^;]*BROKER/i.test(t)) add('Broker', 'Unknown');

  const deal = t.match(new RegExp(String.raw`(${DATE})(?:\s+FORECLOSURE|\s+SALE)?[,:\s]+([^;]+?)\s+TO\s+([^;]+?)(?:;|$)`, 'i'));
  if (deal) {
    const foreclosure = /FORECLOSURE/i.test(t.slice(0, deal.index! + deal[0].length));
    add(foreclosure ? 'Foreclosure' : 'Sale', `${deal[1]} — ${tidy(deal[2])} → ${tidy(deal[3])}`);
  }

  const price = t.match(new RegExp(String.raw`(?:PRICE|FORECLOS\$)\s*:\s*(${MONEY}\s*\([^;]*?\))`, 'i'));
  if (price) add(/FORECLOS/i.test(price[0]) ? 'Foreclosure amount' : 'Price', money(price[1]));

  const last = t.match(new RegExp(String.raw`(?:LAST (?:TIME THIS(?: PROPERTY)?(?: HAD)? )?SOLD|LAST SALE(?: OF THIS)?|THIS HAD LAST SOLD)\s*\*?:?\s*(${DATE})\s*\((${MONEY}[^;]*?)\)?;`, 'i'));
  if (last) add('Last sold', `${last[1]} — ${money(last[2])}`);

  const units = t.match(/(\d[\d,]*)\s*\*?\s*(UTS|UNITS)\b/i);
  const built = t.match(/BLT\s*(\d{4}(?:\s?-\s?\d{2,4})?)/i);
  const size = [units && `${units[1].replace(/,/g, '')} units`, built && `built ${built[1]}`].filter(Boolean).join(', ');
  if (size) add('Size', size);

  const acres = t.match(/([\d.]+)\s*ACS?\b/i);
  if (acres) add('Acres', acres[1]);

  const occ = t.match(/(\d{1,3})\s*%\s*OCCUP/i);
  if (occ) add('Occupancy', `${occ[1]}%`);
  const cap = t.match(/CAP RATE\s*:\s*([\d.]+%)/i);
  if (cap) add('Cap rate', cap[1]);

  const loan = t.match(new RegExp(String.raw`(?:NEW|ASUMP|ASSUMP|ORIG|BRIDGE)\s*(?:LOAN|LN)\s*:?\s*(${MONEY})(?:[^;]*?(?:DUE(?: DATE)?\s*:?\s*(${DATE}|\d{1,2}/\d{1,2}/\d{4})|,\s*(\d+Y)))?`, 'i'));
  if (loan) add('Loan', [money(loan[1]), loan[2] ? `due ${loan[2]}` : loan[3] ? `${loan[3].replace('Y', '-year')}` : ''].filter(Boolean).join(', '));

  const lender = t.match(/LENDER\s*:\s*([^;]+)/i);
  if (lender && !/NONE/i.test(lender[1])) add('Lender', lender[1]);

  const deed = t.match(/D?DBK\s*([\w?]+)\s*,\s*PG?\s*([\w?]+)/i);
  if (deed && !deed[1].includes('?')) add('Deed book', `${deed[1]} p. ${deed[2]}`);

  const assess = t.match(new RegExp(String.raw`([A-Z]+)\s+ASSESS?O?RS?\s+EST\w*\s+(\d{4})\s+VAL\w*\s*:?\s*(${MONEY}(?:\s*\([^)]*\)?)?)`, 'i'));
  if (assess) add('Assessed value', `${money(assess[3])} (${assess[1].charAt(0) + assess[1].slice(1).toLowerCase()} County, ${assess[2]})`);

  const prev = [...t.matchAll(new RegExp(String.raw`(?:OTHER PREVIOUS SALES|ALSO(?: SOLD)?|& (?:HAD )?SOLD|& SALE|HAD SOLD)\s*:?\s*(${DATE})\s*\((${MONEY}[^;)]*)`, 'gi'))]
    .map((m) => `${m[1]} — ${money(m[2] + ')')}`);
  if (prev.length) add('Previous sales', prev.join(' · '));

  return facts;
}
