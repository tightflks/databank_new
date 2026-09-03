import { useEffect, useState } from 'react';
import axios from 'axios';
import { Loader2, AlertCircle, X, ExternalLink, Clock, FileSpreadsheet } from 'lucide-react';

// Property Search over the Dropbox archive of weekly Reflex files.
//   Properties   — one record per property across every synced week: current
//                  owner and sale, plus the trail of owners, sales and every
//                  field change, week by week (from /api/dropbox/properties).
//   Weekly files — the raw rows of any one week's CSV, any file in that zip
//                  (APTS, APTS2, IND3…), from /api/dropbox/rows.

import { fmtDate, fmtValue } from './utils/fmt';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');
const CSV_ROOT = '/GrooveSolutions/Databank/_archive/_csv';

type Database = { id: string; label: string; type: string; note?: string; latestWeek: string | null; rows: number | null; weeks: number; firstWeek: string | null; path: string | null };
type Week = { week: string; zip: string; size: number; synced_at: string; files: Record<string, number> };
type Summary = { weeks: number; firstWeek: string | null; latestWeek: string | null; databases: Database[]; all: Week[] };

type Rows = { type: string; week: string; columns: string[]; total: number; page: number; pageSize: number; rows: string[][] };

type Event = [string, string, string, string]; // [week, field, from, to]; field "*" = removed / restored
type Property = {
  id: string; name: string; address: string; city: string; county: string; parcel: string;
  first: string; last: string; seen: number; removed: boolean;
  owner: string; saleDate: string; salePrice: string; size: string;
  changes: number; sales: number; owners: number;
};
type PropertyList = { type: string; weeks: number; firstWeek: string | null; latestWeek: string | null; properties: number; current: number; total: number; page: number; pageSize: number; items: Property[] };
type PropertyDetail = Property & { type: string; weeks: number; fields: string[]; current: Record<string, string>; events: Event[] };

// ---------- formatting ----------

// Web link to a synced CSV in the Dropbox UI, from its path under the account root.
function dropboxLink(path: string) {
  const i = path.lastIndexOf('/');
  return `https://www.dropbox.com/home${path.slice(0, i)}?preview=${encodeURIComponent(path.slice(i + 1))}`;
}

function errorMessage(e: unknown): string {
  if (axios.isAxiosError(e)) return e.response?.data?.error || e.message;
  return e instanceof Error ? e.message : 'Request failed';
}

// ---------- shared bits ----------

function ErrorNote({ title, message }: { title: string; message: string }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 text-red-800">
      <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
      <div><span className="font-semibold">{title}</span> {message}</div>
    </div>
  );
}

function Pager({ page, pages, loading, onPage }: { page: number; pages: number; loading: boolean; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between mt-4 text-sm text-gray-600">
      <button className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 disabled:opacity-40" onClick={() => onPage(page - 1)} disabled={page === 0 || loading}>← Prev</button>
      <span>Page {page + 1} of {pages}</span>
      <button className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 disabled:opacity-40" onClick={() => onPage(page + 1)} disabled={page + 1 >= pages || loading}>Next →</button>
    </div>
  );
}

const TH = 'px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap';
const TD = 'px-3 py-2 text-sm text-gray-800 whitespace-nowrap max-w-xs overflow-hidden text-ellipsis';

// ---------- Properties: one record per property, with history ----------

const OWNER_FIELDS = ['TAX OWNER', 'OWNER'];
const SALE_FIELDS = ['SALE DATE', 'SALE PRICE', 'SELLER\\FORECLOSEE', 'SELLER', 'BROKER', 'LENDER', '$ LOAN'];
const HEADLINE = new Set([...OWNER_FIELDS, ...SALE_FIELDS, 'P NAME', 'UNITS COMPLETED:', '# SQ FT BUILT', '# ACRES', 'INSIDER DATE']);

// Values a field has held, oldest first, from the change log plus today's value.
function trail(p: PropertyDetail, field: string): { week: string; value: string }[] {
  const evs = p.events.filter((e) => e[1] === field);
  const out: { week: string; value: string }[] = [];
  if (evs.length) out.push({ week: p.first, value: evs[0][2] });
  else if (p.current[field]) out.push({ week: p.first, value: p.current[field] });
  for (const e of evs) out.push({ week: e[0], value: e[3] });
  return out.filter((x, i, a) => x.value && (i === 0 || x.value !== a[i - 1].value));
}

export function Detail({ type, id, onClose }: { type: string; id: string; onClose: () => void }) {
  const [p, setP] = useState<PropertyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setP(null);
    setError(null);
    axios
      .get<PropertyDetail>(`${API_URL}/api/dropbox/properties`, { params: { type, id }, signal: ctrl.signal })
      .then((res) => setP(res.data))
      .catch((e: unknown) => {
        if (axios.isCancel(e)) return;
        setError(errorMessage(e));
      });
    return () => ctrl.abort();
  }, [type, id]);

  if (error) return <ErrorNote title="Couldn't load the property." message={error} />;
  if (!p) {
    return (
      <div className="flex items-center gap-2 text-gray-500 py-6 justify-center"><Loader2 className="w-5 h-5 animate-spin" /> Loading history…</div>
    );
  }

  const owners = trail(p, p.current['TAX OWNER'] !== undefined || p.events.some((e) => e[1] === 'TAX OWNER') ? 'TAX OWNER' : 'OWNER');
  const saleDates = trail(p, 'SALE DATE');
  const salePrices = trail(p, 'SALE PRICE');
  const byWeek = new Map<string, Event[]>();
  for (const e of p.events) {
    if (!all && !HEADLINE.has(e[1]) && e[1] !== '*') continue;
    const list = byWeek.get(e[0]) ?? [];
    list.push(e);
    byWeek.set(e[0], list);
  }
  const weeks = Array.from(byWeek.keys()).sort().reverse();
  const sizeField = p.current['UNITS COMPLETED:'] ? 'UNITS COMPLETED:' : p.current['# SQ FT BUILT'] ? '# SQ FT BUILT' : '# ACRES';

  return (
    <div className="bg-white rounded-2xl shadow-lg border border-indigo-100 p-6 mb-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-2xl font-bold text-gray-900">{p.name || '(unnamed)'}</h3>
          <p className="text-sm text-gray-500">
            {[p.address, p.city, p.county].filter(Boolean).join(' · ')}
            {p.parcel && <> · parcel <code className="bg-gray-100 px-1 rounded">{p.parcel}</code></>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`px-3 py-1 rounded-full text-xs font-semibold ${p.removed ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}>
            {p.removed ? `Dropped ${fmtDate(p.last)}` : 'In the current file'}
          </span>
          <button className="p-2 rounded-lg hover:bg-gray-100 text-gray-500" onClick={onClose} aria-label="Close"><X className="w-5 h-5" /></button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-blue-50 rounded-xl p-4">
          <div className="text-2xl font-bold text-gray-900">{fmtValue(sizeField, p.current[sizeField] ?? '')}</div>
          <div className="text-xs text-gray-600">{sizeField === 'UNITS COMPLETED:' ? 'Units' : sizeField === '# SQ FT BUILT' ? 'SF built' : 'Acres'}</div>
        </div>
        <div className="bg-green-50 rounded-xl p-4">
          <div className="text-2xl font-bold text-gray-900">{fmtValue('SALE PRICE', p.salePrice)}</div>
          <div className="text-xs text-gray-600">Last sale · {fmtDate(p.saleDate)}</div>
        </div>
        <div className="bg-purple-50 rounded-xl p-4">
          <div className="text-2xl font-bold text-gray-900">{owners.length}</div>
          <div className="text-xs text-gray-600">Owner{owners.length === 1 ? '' : 's'} on record since {fmtDate(p.first)}</div>
        </div>
        <div className="bg-orange-50 rounded-xl p-4">
          <div className="text-2xl font-bold text-gray-900">{p.seen}</div>
          <div className="text-xs text-gray-600">Weekly files it appears in · of {p.weeks}</div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6 mb-6">
        <div>
          <h4 className="font-semibold text-gray-800 mb-2">Owners</h4>
          <ol className="space-y-1 text-sm">
            {owners.map((o, i) => (
              <li key={i}><span className="font-mono text-xs text-gray-500 mr-2">{i === 0 ? `by ${fmtDate(o.week)}` : fmtDate(o.week)}</span>{o.value}</li>
            ))}
            {owners.length === 0 && <li className="text-gray-400">No owner recorded.</li>}
          </ol>
        </div>
        <div>
          <h4 className="font-semibold text-gray-800 mb-2">Sales</h4>
          <ol className="space-y-1 text-sm">
            {saleDates.map((s, i) => (
              <li key={i}>
                <span className="font-mono text-xs text-gray-500 mr-2">{s.value}</span>
                {fmtValue('SALE PRICE', salePrices[i]?.value ?? (i === saleDates.length - 1 ? p.salePrice : ''))}
                {i === 0 && saleDates.length > 1 ? <span className="text-xs text-gray-400 ml-1">(on file when tracking began)</span> : null}
              </li>
            ))}
            {saleDates.length === 0 && <li className="text-gray-400">No sale recorded.</li>}
          </ol>
        </div>
      </div>

      <div className="flex items-center justify-between mb-2">
        <h4 className="font-semibold text-gray-800 flex items-center gap-2"><Clock className="w-4 h-4" /> What changed, week by week</h4>
        <label className="text-sm text-gray-600 flex items-center gap-2">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> every field ({p.changes.toLocaleString('en-US')} changes)
        </label>
      </div>
      {weeks.length === 0 ? (
        <p className="text-sm text-gray-400">Nothing on the headline fields has changed since {fmtDate(p.first)}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <tbody className="divide-y divide-gray-100">
              {weeks.map((w) =>
                (byWeek.get(w) ?? []).map((e, i) => (
                  <tr key={w + i}>
                    {i === 0 ? <td className="px-3 py-1.5 font-mono text-xs text-gray-500 align-top whitespace-nowrap" rowSpan={byWeek.get(w)?.length}>{fmtDate(w)}</td> : null}
                    {e[1] === '*' ? (
                      <td colSpan={3} className="px-3 py-1.5 italic text-gray-500">{e[3] === 'removed' ? 'Dropped from the weekly file' : 'Back in the weekly file'}</td>
                    ) : (
                      <>
                        <td className={`px-3 py-1.5 whitespace-nowrap ${HEADLINE.has(e[1]) ? 'font-semibold text-gray-800' : 'text-gray-600'}`}>{e[1]}</td>
                        <td className="px-3 py-1.5 text-gray-400 line-through">{fmtValue(e[1], e[2])}</td>
                        <td className="px-3 py-1.5 text-gray-900">{fmtValue(e[1], e[3])}</td>
                      </>
                    )}
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}

      <details className="mt-4">
        <summary className="text-sm text-gray-600 cursor-pointer">Full current record · {Object.keys(p.current).length} fields</summary>
        <dl className="grid md:grid-cols-2 gap-x-6 gap-y-1 mt-3 text-sm">
          {p.fields.map((f) =>
            p.current[f] ? (
              <div key={f} className="flex justify-between gap-4 border-b border-gray-50 py-1">
                <dt className="text-gray-500">{f}</dt>
                <dd className="text-gray-900 text-right">{fmtValue(f, p.current[f])}</dd>
              </div>
            ) : null,
          )}
        </dl>
      </details>
    </div>
  );
}

function Properties({ type, label, initialQuery = '' }: { type: string; label: string; initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [term, setTerm] = useState(initialQuery);
  const [page, setPage] = useState(0);
  const [removed, setRemoved] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [data, setData] = useState<PropertyList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setTerm(q); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    axios
      .get<PropertyList>(`${API_URL}/api/dropbox/properties`, { params: { type, q: term, page, removed: removed ? '1' : '0' }, signal: ctrl.signal })
      .then((res) => { setData(res.data); setLoading(false); })
      .catch((e: unknown) => {
        if (axios.isCancel(e)) return;
        setError(errorMessage(e));
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [type, term, page, removed]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <input
          className="flex-1 min-w-[280px] px-4 py-3 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={`Search ${label} — name, street, city, owner, past owner, parcel…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="text-sm text-gray-600 flex items-center gap-2">
          <input type="checkbox" checked={removed} onChange={(e) => setRemoved(e.target.checked)} /> include dropped
        </label>
        <span className="text-sm text-gray-500">
          {loading ? 'Loading…' : data ? `${data.total.toLocaleString('en-US')} of ${data.current.toLocaleString('en-US')} properties · tracked over ${data.weeks} weeks, ${fmtDate(data.firstWeek)} → ${fmtDate(data.latestWeek)}` : ''}
        </span>
      </div>
      {error && <ErrorNote title="Couldn't load properties." message={error} />}
      {open && <Detail type={type} id={open} onClose={() => setOpen(null)} />}
      {data && (
        <>
          <div className="overflow-x-auto rounded-xl border border-gray-100">
            <table className="min-w-full divide-y divide-gray-100">
              <thead className="bg-gray-50">
                <tr>
                  {['Property', 'Address', 'City', 'County', 'Size', 'Owner', 'Last sale', 'Price', 'Sales', 'Owners', 'Since'].map((h) => <th key={h} className={TH}>{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {data.items.map((p) => (
                  <tr
                    key={p.id}
                    className={`cursor-pointer hover:bg-blue-50 ${open === p.id ? 'bg-blue-50' : ''} ${p.removed ? 'text-gray-400 italic' : ''}`}
                    onClick={() => setOpen(open === p.id ? null : p.id)}
                  >
                    <td className={`${TD} font-medium`} title={p.name}>{p.name || '(unnamed)'}</td>
                    <td className={TD}>{p.address}</td>
                    <td className={TD}>{p.city}</td>
                    <td className={TD}>{p.county}</td>
                    <td className={TD}>{p.size}</td>
                    <td className={TD} title={p.owner}>{p.owner}</td>
                    <td className={`${TD} font-mono text-xs`}>{p.saleDate}</td>
                    <td className={TD}>{fmtValue('SALE PRICE', p.salePrice)}</td>
                    <td className={TD}>{p.sales}</td>
                    <td className={TD}>{p.owners}</td>
                    <td className={`${TD} font-mono text-xs`}>{p.first.slice(0, 7)}</td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr><td colSpan={11} className="px-3 py-8 text-center text-gray-400">No properties match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager page={page} pages={pages} loading={loading} onPage={setPage} />
        </>
      )}
    </div>
  );
}

// ---------- Weekly files: raw rows of one CSV ----------

const KEY_COLUMNS = ['P NAME', 'P STREET NUMBER', 'P STREET NAME', 'P CITY', 'COUNTY', 'PARCEL', 'UNITS COMPLETED:', 'SF LAND', 'SALE DATE', 'SALE PRICE', '$ UNIT', 'PRICE PER SF BUILDING', 'TAX OWNER'];
const SHORT: Record<string, string> = {
  'P NAME': 'Property', 'P STREET NUMBER': 'No.', 'P STREET NAME': 'Street', 'P CITY': 'City', COUNTY: 'County', PARCEL: 'Parcel',
  'UNITS COMPLETED:': 'Units', 'SF LAND': 'SF Land', 'SALE DATE': 'Sale Date', 'SALE PRICE': 'Price', '$ UNIT': '$ / Unit', 'PRICE PER SF BUILDING': '$ / SF', 'TAX OWNER': 'Owner',
};

function WeeklyRows({ type, week, label }: { type: string; week: string; label: string }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(0);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [data, setData] = useState<Rows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setTerm(q); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setOpen(null);
    axios
      .get<Rows>(`${API_URL}/api/dropbox/rows`, { params: { type, week, q: term, page }, signal: ctrl.signal })
      .then((res) => { setData(res.data); setLoading(false); })
      .catch((e: unknown) => {
        if (axios.isCancel(e)) return;
        setError(errorMessage(e));
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [type, week, term, page]);

  const allCols = data?.columns ?? [];
  const cols = all ? allCols : allCols.filter((c) => KEY_COLUMNS.includes(c));
  const idx = cols.map((c) => allCols.indexOf(c));
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const path = `${CSV_ROOT}/${week}/${type}.csv`;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <input
          className="flex-1 min-w-[280px] px-4 py-3 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={`Search ${label} — name, street, city, owner, parcel…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="text-sm text-gray-600 flex items-center gap-2">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> all columns
        </label>
        <span className="text-sm text-gray-500 flex items-center gap-1">
          {loading ? 'Loading…' : data ? `${data.total.toLocaleString('en-US')} rows · ` : ''}
          {data && !loading && (
            <a className="text-blue-600 hover:underline inline-flex items-center gap-1" href={dropboxLink(path)} target="_blank" rel="noreferrer">
              {type}.csv <ExternalLink className="w-3 h-3" />
            </a>
          )}
          {data && !loading ? ` · ${fmtDate(week)}` : ''}
        </span>
      </div>
      {error && <ErrorNote title="Couldn't load rows." message={error} />}
      {data && (
        <>
          <div className="overflow-x-auto rounded-xl border border-gray-100">
            <table className="min-w-full divide-y divide-gray-100">
              <thead className="bg-gray-50">
                <tr>{cols.map((c) => <th key={c} className={TH}>{all ? c : SHORT[c] ?? c}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {data.rows.map((r, i) => (
                  <tr key={i} className={`cursor-pointer hover:bg-blue-50 ${open === i ? 'bg-blue-50' : ''}`} onClick={() => setOpen(open === i ? null : i)}>
                    {idx.map((j, k) => <td key={k} className={TD} title={r[j]}>{fmtValue(cols[k], r[j]) === '—' ? '' : fmtValue(cols[k], r[j])}</td>)}
                  </tr>
                ))}
                {data.rows.length === 0 && (
                  <tr><td colSpan={Math.max(1, cols.length)} className="px-3 py-8 text-center text-gray-400">No rows match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {open !== null && data.rows[open] && (
            <div className="bg-gray-50 rounded-xl p-4 mt-4">
              <p className="text-xs text-gray-500 mb-2">Full record · click the row again to close</p>
              <dl className="grid md:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                {data.columns.map((c, j) =>
                  data.rows[open][j] ? (
                    <div key={c} className="flex justify-between gap-4 border-b border-gray-100 py-1">
                      <dt className="text-gray-500">{c}</dt>
                      <dd className="text-gray-900 text-right">{fmtValue(c, data.rows[open][j])}</dd>
                    </div>
                  ) : null,
                )}
              </dl>
            </div>
          )}
          <Pager page={page} pages={pages} loading={loading} onPage={setPage} />
        </>
      )}
    </div>
  );
}

// ---------- the view ----------

// `fixedMode` pins the view: User View shows only property history; the admin's Weekly files tab only the CSVs.
export default function PropertyHistory({ databaseType, fixedMode, initialQuery }: { databaseType: string; fixedMode?: 'history' | 'weekly'; initialQuery?: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'history' | 'weekly'>(fixedMode ?? 'history');
  const [week, setWeek] = useState<string | null>(null); // null = newest synced
  const [file, setFile] = useState<string | null>(null); // null = the chosen database's base file

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    axios
      .get<Summary>(`${API_URL}/api/dropbox/summary`, { signal: ctrl.signal })
      .then((res) => { setSummary(res.data); setLoading(false); })
      .catch((e: unknown) => {
        if (axios.isCancel(e)) return;
        setError(errorMessage(e));
        setLoading(false);
      });
    return () => ctrl.abort();
  }, []);

  useEffect(() => { setFile(null); }, [databaseType]);

  if (loading) {
    return <div className="flex items-center justify-center gap-2 text-gray-500 py-16"><Loader2 className="w-6 h-6 animate-spin" /> Reaching Dropbox…</div>;
  }
  if (error) return <ErrorNote title="Couldn't reach Dropbox." message={error} />;
  if (!summary) return null;

  const db = summary.databases.find((d) => d.id === databaseType);
  const wk = summary.all.find((w) => w.week === week) ?? summary.all[0];
  if (!db || !wk) return <p className="text-gray-400 text-center py-16">Nothing synced yet.</p>;

  const type = file && file in wk.files ? file : db.type in wk.files ? db.type : Object.keys(wk.files)[0];
  const files = Object.keys(wk.files).sort();

  return (
    <div className="bg-white rounded-2xl shadow-lg p-6">
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {!fixedMode && (
          <>
            <button
              onClick={() => setMode('history')}
              className={`px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 ${mode === 'history' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              <Clock className="w-4 h-4" /> Properties · with history
            </button>
            <button
              onClick={() => setMode('weekly')}
              className={`px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 ${mode === 'weekly' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              <FileSpreadsheet className="w-4 h-4" /> Weekly files · one week, one CSV
            </button>
          </>
        )}
        {fixedMode === 'weekly' && <span className="text-sm font-semibold text-gray-700 flex items-center gap-2"><FileSpreadsheet className="w-4 h-4" /> Weekly files · one week, one CSV</span>}
        <span className="text-sm text-gray-500 ml-auto">{summary.weeks} weeks synced · latest {fmtDate(summary.latestWeek)}</span>
      </div>

      {mode === 'history' ? (
        <Properties key={`${db.type}/${initialQuery ?? ''}`} type={db.type} label={db.label} initialQuery={initialQuery} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4 text-sm text-gray-600">
            <label className="flex items-center gap-2">
              Week
              <select className="px-3 py-2 rounded-lg border border-gray-200" value={wk.week} onChange={(e) => setWeek(e.target.value)}>
                {summary.all.map((w) => <option key={w.week} value={w.week}>{fmtDate(w.week)} · {w.zip}</option>)}
              </select>
            </label>
            <span className="ml-2">Files in this zip:</span>
            {files.map((f) => (
              <button
                key={f}
                onClick={() => setFile(f)}
                title={`${f}.csv`}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${f === type ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
              >
                {f} <span className="opacity-70">{wk.files[f].toLocaleString('en-US')}</span>
              </button>
            ))}
          </div>
          <WeeklyRows key={`${wk.week}/${type}`} type={type} week={wk.week} label={type === db.type ? db.label : type} />
        </>
      )}
    </div>
  );
}
