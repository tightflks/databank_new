import { useEffect, useState } from 'react';
import axios from 'axios';
import { Loader2, AlertCircle, X, FileDown } from 'lucide-react';
import { fmtDate, titleCase } from './utils/fmt';
import { downloadReportPdf } from './utils/reportPdf';

// Customer-readable report for one property (Ask AI "Report" button). Plain
// words, no Reflex field names: what it is, who owns it, who owned it before,
// every sale on record. "Download PDF" renders the same facts server-side.

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

type Report = {
  id: string; type: string; name: string; formerNames: string[]; address: string; city: string; county: string; zip: string; parcel: string;
  removed: boolean; first: string; last: string; weeks: number;
  facts: { label: string; value: string }[];
  owner: string; ownerTrail: { week: string; value: string }[];
  saleList: { week: string; date: string; price: string; seller: string; buyer: string }[];
  loan: string; lender: string; broker: string; comments: string;
};

const money = (v: string) => { const n = Number(v); return v && !Number.isNaN(n) ? '$' + Math.round(n).toLocaleString('en-US') : v || '—'; };
const num = (v: string) => { const n = Number(v); return v && !Number.isNaN(n) ? n.toLocaleString('en-US') : v || '—'; };

export function PropertyReport({ type, id, onClose }: { type: string; id: string; onClose: () => void }) {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setR(null);
    setError(null);
    axios
      .get<Report>(`${API_URL}/api/dropbox/report`, { params: { type, id }, signal: ctrl.signal })
      .then((res) => setR(res.data))
      .catch((e: unknown) => {
        if (axios.isCancel(e)) return;
        setError(axios.isAxiosError(e) ? e.response?.data?.error || e.message : 'Request failed');
      });
    return () => ctrl.abort();
  }, [type, id]);

  const downloadPdf = async () => {
    if (downloading || !r) return;
    setDownloading(true);
    try {
      await downloadReportPdf(type, id, r.name);
    } catch (e) {
      console.error('PDF failed:', e);
      alert('Could not build the PDF. Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  if (error) {
    return (
      <div className="m-4 bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 text-red-800">
        <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" /><div><span className="font-semibold">Couldn't load the report.</span> {error}</div>
      </div>
    );
  }
  if (!r) return <div className="flex items-center gap-2 text-gray-500 py-6 justify-center"><Loader2 className="w-5 h-5 animate-spin" /> Preparing the report…</div>;

  const sales = [...r.saleList].reverse();
  const owners = [...r.ownerTrail].reverse();
  const last = r.saleList[r.saleList.length - 1];
  const where = [titleCase(r.address), titleCase(r.city), r.county ? `${titleCase(r.county)} County` : '', r.zip].filter(Boolean).join(', ');
  const sameOwner = !!last && !!last.buyer && last.buyer.toUpperCase() === last.seller.toUpperCase();
  const lede = last
    ? <>
        {sameOwner
          ? <><b>{titleCase(r.name)}</b> was last recorded on <b>{fmtDate(last.date)}</b>{last.price ? <> at <b>{money(last.price)}</b></> : null}, staying with <b>{titleCase(last.buyer)}</b> (a transfer or refinancing, not a change of owner).</>
          : <><b>{titleCase(r.name)}</b> last sold on <b>{fmtDate(last.date)}</b>{last.price ? <> for <b>{money(last.price)}</b></> : ' (price not on record)'}{last.buyer ? <> to <b>{titleCase(last.buyer)}</b></> : null}{last.seller ? <>, purchased from {titleCase(last.seller)}</> : null}.</>}
        {r.saleList.length > 1 ? ` Databank has ${r.saleList.length} sales on record for this property.` : ''}
        {owners.length > 1 ? ` It has had ${owners.length} owners since Databank started tracking it in ${fmtDate(r.first)}.` : ''}
      </>
    : <><b>{titleCase(r.name)}</b> is owned by <b>{titleCase(r.owner) || 'an unrecorded owner'}</b>. Databank has no sale on record for it.</>;

  return (
    <div className="m-4 bg-white rounded-2xl shadow-lg border border-blue-100 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-2xl font-bold text-gray-900">
            {titleCase(r.name) || '(unnamed property)'}
            {r.removed && <span className="ml-2 align-middle text-xs font-medium text-amber-800 bg-amber-100 rounded-full px-2 py-0.5">no longer on the current list</span>}
          </h3>
          <p className="text-sm text-gray-600">{where}{r.parcel && <> · Parcel {r.parcel}</>}</p>
          {r.formerNames.length > 0 && <p className="text-xs text-gray-500">Formerly known as {r.formerNames.map(titleCase).join(', ')}</p>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={downloadPdf} disabled={downloading} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50">
            {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />} Download PDF
          </button>
          <button className="p-2 rounded-lg hover:bg-gray-100 text-gray-500" onClick={onClose} aria-label="Close"><X className="w-5 h-5" /></button>
        </div>
      </div>

      <p className="mt-4 bg-blue-50 border-l-4 border-blue-700 rounded-r-lg px-4 py-3 text-base text-gray-900 leading-relaxed">{lede}</p>

      {r.facts.length > 0 && (
        <>
          <h4 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-blue-900 border-b border-gray-200 pb-1">About the property</h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
            {r.facts.map((f) => (
              <div key={f.label}><div className="text-[11px] uppercase tracking-wide text-gray-500">{f.label}</div><div className="font-semibold">{/price/i.test(f.label) ? money(f.value) : /built/i.test(f.label) ? f.value : num(f.value)}</div></div>
            ))}
          </div>
        </>
      )}

      <h4 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-blue-900 border-b border-gray-200 pb-1">Ownership</h4>
      <p className="text-sm"><span className="text-gray-500">Current owner:</span> <b>{titleCase(r.owner) || '—'}</b></p>
      {owners.length > 1 && (
        <ol className="mt-2 space-y-1 text-sm">
          {owners.map((o, i) => (
            <li key={i} className="flex gap-3"><span className="w-28 flex-shrink-0 text-gray-500">{i === owners.length - 1 ? `by ${fmtDate(o.week)}` : fmtDate(o.week)}</span><span>{titleCase(o.value)}</span></li>
          ))}
        </ol>
      )}

      <h4 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-blue-900 border-b border-gray-200 pb-1">Sales on record</h4>
      {sales.length === 0 ? <p className="text-sm text-gray-500">No sale recorded.</p> : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wide text-gray-500"><th className="py-1 pr-3">Date</th><th className="py-1 pr-3">Price</th><th className="py-1 pr-3">Buyer</th><th className="py-1">Seller</th></tr></thead>
          <tbody className="divide-y divide-gray-100">
            {sales.map((s, i) => (
              <tr key={i}><td className="py-1.5 pr-3 whitespace-nowrap">{s.date}</td><td className="py-1.5 pr-3 whitespace-nowrap font-medium">{money(s.price)}</td><td className="py-1.5 pr-3">{titleCase(s.buyer) || '—'}</td><td className="py-1.5">{titleCase(s.seller) || '—'}</td></tr>
            ))}
          </tbody>
        </table>
      )}

      {(r.loan || r.lender || r.broker) && (
        <>
          <h4 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-blue-900 border-b border-gray-200 pb-1">Financing &amp; brokerage</h4>
          <p className="text-sm">
            {r.loan && <><span className="text-gray-500">Loan:</span> <b>{money(r.loan)}</b>{'  '}</>}
            {r.lender && <><span className="text-gray-500 ml-3">Lender:</span> {titleCase(r.lender)}</>}
            {r.broker && <><span className="text-gray-500 ml-3">Broker:</span> {titleCase(r.broker)}</>}
          </p>
        </>
      )}

      {r.comments && (
        <>
          <h4 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-blue-900 border-b border-gray-200 pb-1">Research notes</h4>
          <p className="text-sm text-gray-700 whitespace-pre-line">{r.comments}</p>
        </>
      )}

      <p className="mt-6 pt-2 border-t border-gray-200 text-xs text-gray-500">Source: Databank Atlanta weekly research files, {fmtDate(r.first)} – {fmtDate(r.last)} ({r.weeks} weekly files).</p>
    </div>
  );
}
