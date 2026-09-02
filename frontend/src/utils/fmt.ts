export function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00Z' : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const MONEY = /PRICE|^\$|LOAN|INCOME/;

export function fmtValue(field: string, v: string) {
  if (!v) return '—';
  const n = Number(v);
  if (Number.isNaN(n) || /DATE|ZIP|PHONE|PARCEL|SQUARE|DISTRICT|NUMBER|LANDLOT/.test(field)) return v;
  if (MONEY.test(field)) return '$' + Math.round(n).toLocaleString('en-US');
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
