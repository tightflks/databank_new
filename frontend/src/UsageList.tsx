import { useEffect, useState } from 'react';
import axios from 'axios';
import { Loader2, AlertCircle, Users, Search, MessageSquare, Download, FileText, Clock } from 'lucide-react';

// Admin "Usage" tab: what customers actually do on the site, from the server-side
// usage log (nothing third-party). Our own admin traffic is left out by default.

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

type Summary = {
  days: number;
  includeAdmin: boolean;
  firstEvent: string | null;
  visitors: number;
  exportedRows: number;
  totals: Record<string, number>;
  byDay: { day: string; visitors: number; events: number }[];
  byDatabase: { database_type: string; n: number }[];
  topSearches: { detail: string; n: number }[];
  topQuestions: { detail: string; n: number }[];
  topProperties: { detail: string; n: number }[];
  recent: { id: number; kind: string; database_type: string | null; detail: string | null; rows: number | null; visitor: string | null; created_date: string }[];
};

const KIND_LABEL: Record<string, string> = {
  page_view: 'Page view', search: 'Quick find', ask: 'Ask Databank', export: 'Excel export',
  report: 'One-page report', pdf: 'PDF download', history: 'Property History',
};

const n = (v: number) => v.toLocaleString('en-US');
const when = (s: string) => new Date(s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function Stat({ icon: Icon, label, value, sub }: { icon: typeof Users; label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-xl shadow-md p-4">
      <div className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wide"><Icon className="w-4 h-4" />{label}</div>
      <div className="text-2xl font-bold text-gray-900 mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function TopList({ title, rows, empty }: { title: string; rows: { detail: string; n: number }[]; empty: string }) {
  return (
    <div className="bg-white rounded-xl shadow-md p-4">
      <h3 className="font-semibold text-gray-800 mb-3">{title}</h3>
      {rows.length === 0 ? <p className="text-sm text-gray-400">{empty}</p> : (
        <ol className="space-y-1.5 text-sm">
          {rows.map((r) => (
            <li key={r.detail} className="flex justify-between gap-3">
              <span className="text-gray-700 truncate">{r.detail}</span>
              <span className="text-gray-500 tabular-nums flex-shrink-0">{n(r.n)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default function UsageList() {
  const [days, setDays] = useState(30);
  const [includeAdmin, setIncludeAdmin] = useState(false);
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    axios
      .get<Summary>(`${API_URL}/api/usage/summary`, { params: { days, admin: includeAdmin ? 1 : 0 }, signal: ctrl.signal })
      .then((r) => setData(r.data))
      .catch((e: unknown) => {
        if (axios.isCancel(e)) return;
        setError(axios.isAxiosError(e) ? e.response?.data?.error || e.message : 'Request failed');
      });
    return () => ctrl.abort();
  }, [days, includeAdmin]);

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 text-red-800">
        <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" /><div><span className="font-semibold">Could not load usage.</span> {error}</div>
      </div>
    );
  }
  if (!data) return <div className="flex justify-center py-16 text-gray-500"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  const t = data.totals;
  const maxDay = Math.max(1, ...data.byDay.map((d) => d.events));
  const dbTotal = data.byDatabase.reduce((s, d) => s + d.n, 0) || 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Site usage</h2>
          <p className="text-sm text-gray-500">
            {data.firstEvent ? `Logged since ${when(data.firstEvent)}.` : 'Nothing logged yet.'} Counted on our server; no third-party analytics.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <div className="inline-flex rounded-lg bg-white shadow-sm p-0.5">
            {[7, 30, 90, 365].map((d) => (
              <button key={d} onClick={() => setDays(d)} className={`px-3 py-1.5 rounded-md ${days === d ? 'bg-[#0b1f5c] text-white' : 'text-gray-600 hover:bg-gray-100'}`}>
                {d === 365 ? '1 year' : `${d} days`}
              </button>
            ))}
          </div>
          <label className="inline-flex items-center gap-1.5 text-gray-600 ml-2">
            <input type="checkbox" checked={includeAdmin} onChange={(e) => setIncludeAdmin(e.target.checked)} />
            Include our admin activity
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat icon={Users} label="Visitors" value={n(data.visitors)} sub="distinct browsers" />
        <Stat icon={Search} label="Quick finds" value={n(t.search || 0)} />
        <Stat icon={MessageSquare} label="Ask Databank" value={n(t.ask || 0)} sub="questions" />
        <Stat icon={Download} label="Excel exports" value={n(t.export || 0)} sub={`${n(data.exportedRows)} records exported`} />
        <Stat icon={FileText} label="Reports & PDFs" value={n((t.report || 0) + (t.pdf || 0))} sub={`${n(t.report || 0)} reports · ${n(t.pdf || 0)} PDFs`} />
        <Stat icon={Clock} label="Property History" value={n(t.history || 0)} sub="properties opened" />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow-md p-4 lg:col-span-2">
          <h3 className="font-semibold text-gray-800 mb-3">Activity by day</h3>
          {data.byDay.length === 0 ? <p className="text-sm text-gray-400">No activity in this period.</p> : (
            <div className="flex items-end gap-1 h-36">
              {data.byDay.map((d) => (
                <div key={d.day} className="flex-1 flex flex-col items-center justify-end h-full" title={`${d.day}: ${d.events} actions, ${d.visitors} visitors`}>
                  <div className="w-full bg-[#0b1f5c]/80 rounded-t" style={{ height: `${Math.max(2, (d.events / maxDay) * 100)}%` }} />
                </div>
              ))}
            </div>
          )}
          {data.byDay.length > 0 && (
            <div className="flex justify-between text-xs text-gray-400 mt-1"><span>{data.byDay[0].day}</span><span>{data.byDay[data.byDay.length - 1].day}</span></div>
          )}
        </div>
        <div className="bg-white rounded-xl shadow-md p-4">
          <h3 className="font-semibold text-gray-800 mb-3">By database</h3>
          {data.byDatabase.length === 0 ? <p className="text-sm text-gray-400">Nothing yet.</p> : (
            <ul className="space-y-2 text-sm">
              {data.byDatabase.map((d) => (
                <li key={d.database_type}>
                  <div className="flex justify-between"><span className="capitalize text-gray-700">{d.database_type}</span><span className="text-gray-500 tabular-nums">{n(d.n)}</span></div>
                  <div className="h-1.5 bg-gray-100 rounded mt-1"><div className="h-1.5 bg-[#0b1f5c]/70 rounded" style={{ width: `${(d.n / dbTotal) * 100}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <TopList title="Most-typed searches" rows={data.topSearches} empty="No searches yet." />
        <TopList title="Most-asked questions" rows={data.topQuestions} empty="No questions yet." />
        <TopList title="Most-opened reports" rows={data.topProperties} empty="No reports opened yet." />
      </div>

      <div className="bg-white rounded-xl shadow-md overflow-hidden">
        <h3 className="font-semibold text-gray-800 px-4 pt-4 pb-2">Latest activity</h3>
        {data.recent.length === 0 ? <p className="text-sm text-gray-400 px-4 pb-4">Nothing yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr><th className="text-left px-4 py-2">When</th><th className="text-left px-4 py-2">Action</th><th className="text-left px-4 py-2">Database</th><th className="text-left px-4 py-2">Detail</th><th className="text-right px-4 py-2">Records</th><th className="text-left px-4 py-2">Visitor</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.recent.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2 whitespace-nowrap text-gray-500">{when(r.created_date)}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-gray-800">{KIND_LABEL[r.kind] || r.kind}</td>
                    <td className="px-4 py-2 capitalize text-gray-600">{r.database_type || ''}</td>
                    <td className="px-4 py-2 text-gray-700 max-w-md truncate" title={r.detail || ''}>{r.detail || ''}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-600">{r.rows == null ? '' : n(r.rows)}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-400">{r.visitor ? r.visitor.slice(0, 8) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
