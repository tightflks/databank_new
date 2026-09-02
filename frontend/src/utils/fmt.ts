export function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00Z' : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Reflex stores every name in capitals. Words that stay upper-case when re-cased for display.
const KEEP_UPPER = new Set([
  'LLC', 'LP', 'LLP', 'LLLP', 'INC', 'CO', 'CORP', 'LTD', 'PLC', 'REIT', 'TIC', 'DBA', 'FKA', 'AKA', 'ETAL', 'TR',
  'NE', 'NW', 'SE', 'SW', 'N', 'S', 'E', 'W', 'GA', 'US', 'USA', 'UK', 'PO', 'HWY', 'I', 'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX',
]);
const SMALL = new Set(['of', 'at', 'the', 'and', 'on', 'in', 'by', 'for', 'de', 'la']);

export function titleCase(s: string | null | undefined): string {
  if (!s) return '';
  if (s !== s.toUpperCase()) return s; // already mixed case: someone typed it that way
  return s
    .toLowerCase()
    .replace(/[a-z0-9][a-z0-9'&]*/g, (w, i) => {
      const up = w.toUpperCase();
      if (/^\d+(st|nd|rd|th)$/.test(w)) return w;
      if (KEEP_UPPER.has(up) || /^\d/.test(w) || /^[a-z]\d/.test(w)) return up;
      if (i > 0 && SMALL.has(w)) return w;
      return w[0].toUpperCase() + w.slice(1);
    })
    .replace(/\b(Mc)([a-z])/g, (_, a, b) => a + b.toUpperCase())
    .replace(/\b(O|D)'([a-z])/g, (_, a, b) => `${a}'${b.toUpperCase()}`);
}

const MONEY = /PRICE|^\$|LOAN|INCOME/;

export function fmtValue(field: string, v: string) {
  if (!v) return '—';
  const n = Number(v);
  if (Number.isNaN(n) || /DATE|ZIP|PHONE|PARCEL|SQUARE|DISTRICT|NUMBER|LANDLOT/.test(field)) return v;
  if (MONEY.test(field)) return '$' + Math.round(n).toLocaleString('en-US');
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
