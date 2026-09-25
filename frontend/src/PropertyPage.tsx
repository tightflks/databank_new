import { useEffect, useState } from 'react';
import axios from 'axios';
import { Loader2, AlertCircle, Link2, Flag, Download } from 'lucide-react';
import { titleCase } from './utils/fmt';
import { downloadReportPdf } from './utils/reportPdf';
import { trackUsage } from './utils/usage';
import PropertyPhoto from './PropertyPhoto';

// The full-page property view (its own URL, /property/:type/:id) — replaces the old pop-up
// modal per the Sep 24 feedback: "I don't like opening new tabs... if you can make this full
// size" and "each property should have its own address (URL) so a broker can email a link."

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

type Report = {
  id: string; type: string; name: string; formerNames: string[]; address: string; city: string; county: string; zip: string; parcel: string;
  removed: boolean; first: string; last: string; weeks: number;
  facts: { label: string; value: string }[];
  owner: string; ownerTrail: { week: string; value: string }[];
  saleList: { week: string; date: string; price: string; seller: string; buyer: string }[];
  loan: string; lender: string; broker: string; comments: string;
  contacts: { label: string; value: string }[];
  allFields: { label: string; value: string }[];
};

const money = (v: string) => { const n = Number(v); return v && !Number.isNaN(n) ? '$' + Math.round(n).toLocaleString('en-US') : v || '—'; };
const num = (v: string) => { const n = Number(v); return v && !Number.isNaN(n) ? n.toLocaleString('en-US') : v || '—'; };

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-db-border rounded-xl px-4 py-3">
      <div className="text-xs text-db-muted">{label}</div>
      <div className="text-xl font-semibold text-db-ink num">{value}</div>
    </div>
  );
}

function SectionCard({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <div id={id} className="bg-white border border-db-border rounded-xl p-6 sm:p-7 flex flex-col gap-4 scroll-mt-20">
      <h2 className="text-xs font-bold uppercase tracking-wider text-db-navy m-0">{title}</h2>
      {children}
    </div>
  );
}

export default function PropertyPage({ type, id, onBack, admin }: { type: string; id: string; onBack: () => void; admin: boolean }) {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [notesAi, setNotesAi] = useState<{ cleaned: string; summary: string } | null>(null);
  const [notesAiLoading, setNotesAiLoading] = useState(false);
  const [notesAiError, setNotesAiError] = useState<string | null>(null);

  const fetchNotesAi = async () => {
    setNotesAiLoading(true);
    setNotesAiError(null);
    try {
      const { data } = await axios.get(`${API_URL}/api/dropbox/report/notes-ai`, { params: { type, id } });
      if (data.cleaned) setNotesAi(data);
      else setNotesAiError("Couldn't build a cleaned-up version for this one — the original above is still complete.");
    } catch {
      setNotesAiError("Couldn't build a cleaned-up version right now — the original above is still complete.");
    } finally {
      setNotesAiLoading(false);
    }
  };

  useEffect(() => {
    const ctrl = new AbortController();
    setR(null);
    setError(null);
    setNotesAi(null);
    setNotesAiError(null);
    axios
      .get<Report>(`${API_URL}/api/dropbox/report`, { params: { type, id }, signal: ctrl.signal })
      .then((res) => { setR(res.data); trackUsage('report', { detail: res.data.name || id, database_type: type.toLowerCase() }); })
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

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    trackUsage('page_view', { detail: 'copy_property_link' });
  };

  if (error) {
    return (
      <div className="min-h-screen bg-db-cream flex items-center justify-center p-6">
        <div className="max-w-md bg-white border border-red-200 rounded-xl p-6 flex items-start gap-3 text-red-800">
          <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-semibold mb-1">Couldn't load this property.</p>
            <p className="text-sm">{error}</p>
            <button onClick={onBack} className="mt-3 text-sm font-semibold text-db-navy">← Back to search</button>
          </div>
        </div>
      </div>
    );
  }
  if (!r) {
    return (
      <div className="min-h-screen bg-db-cream flex items-center justify-center gap-2 text-db-muted">
        <Loader2 className="w-5 h-5 animate-spin" /> Preparing the report…
      </div>
    );
  }

  const sales = [...r.saleList].reverse();
  const owners = [...r.ownerTrail].reverse();
  const last = r.saleList[r.saleList.length - 1];
  const where = [titleCase(r.address), titleCase(r.city), r.county ? `${titleCase(r.county)} County` : '', r.zip].filter(Boolean).join(', ');
  const sameOwner = !!last && !!last.buyer && last.buyer.toUpperCase() === last.seller.toUpperCase();

  const factValue = (f: { label: string; value: string }) => (/price/i.test(f.label) ? money(f.value) : /built/i.test(f.label) ? f.value : num(f.value));
  const heroFacts = r.facts.slice(0, 6);

  return (
    <div className="min-h-screen bg-db-cream font-sans text-db-text">
      <header className="h-16 bg-db-navy text-white flex items-center justify-between px-4 sm:px-8">
        <button onClick={onBack} className="flex items-center gap-2 text-white/90 hover:text-white text-sm font-semibold">
          <span aria-hidden>←</span> Back to results
        </button>
        <a href="/" className="flex items-center gap-2 text-white font-bold tracking-wide text-base">DATABANK</a>
      </header>

      <div className="max-w-6xl mx-auto px-4 sm:px-8 pt-6 flex flex-wrap gap-3 justify-end">
        <button onClick={copyLink} className="inline-flex items-center gap-1.5 border border-db-borderStrong bg-white px-3.5 py-2 rounded-lg text-sm font-semibold text-db-text hover:bg-gray-50">
          <Link2 className="w-4 h-4" /> Copy link
        </button>
        <button className="inline-flex items-center gap-1.5 border border-db-borderStrong bg-white px-3.5 py-2 rounded-lg text-sm font-semibold text-db-text hover:bg-gray-50">
          <Flag className="w-4 h-4" /> Report a data issue
        </button>
        <button onClick={downloadPdf} disabled={downloading} className="inline-flex items-center gap-1.5 bg-db-green text-white px-4 py-2 rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-50">
          {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Export to Excel
        </button>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-8 pt-6 grid md:grid-cols-2 gap-8">
        <PropertyPhoto name={r.name} address={r.address} city={r.city} zip={r.zip} databaseType={type.toLowerCase()} admin={admin} />
        <div className="flex flex-col gap-3">
          <div className="flex gap-2 flex-wrap">
            <span className="text-xs font-semibold bg-db-tint text-db-navy px-2.5 py-1 rounded-full">{r.type}</span>
            {last && <span className="text-xs font-semibold bg-db-tint text-db-navy px-2.5 py-1 rounded-full num">Sold {last.date}</span>}
            {r.removed && <span className="text-xs font-semibold bg-amber-100 text-amber-800 px-2.5 py-1 rounded-full">No longer on the current list</span>}
          </div>
          <h1 className="font-serif font-semibold text-3xl sm:text-4xl leading-tight text-db-ink m-0">{titleCase(r.name) || '(unnamed property)'}</h1>
          {r.formerNames.length > 0 && (
            <div className="text-sm text-db-subtle">Formerly {r.formerNames.map(titleCase).join(' · ')}</div>
          )}
          <div className="text-sm text-db-subtle">{where}{r.parcel && <> · Parcel {r.parcel}</>}</div>
          {heroFacts.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2">
              {heroFacts.map((f) => <StatTile key={f.label} label={f.label} value={factValue(f)} />)}
            </div>
          )}
        </div>
      </div>

      <nav aria-label="Sections" className="max-w-6xl mx-auto px-4 sm:px-8 mt-7 flex gap-1 border-b border-db-borderStrong text-sm font-semibold overflow-x-auto">
        <a href="#transaction" className="text-db-navy px-4 py-3 border-b-2 border-db-navy whitespace-nowrap">Transaction</a>
        <a href="#ownership" className="text-db-subtle px-4 py-3 whitespace-nowrap hover:text-db-navy">Ownership &amp; Contacts</a>
        <a href="#notes" className="text-db-subtle px-4 py-3 whitespace-nowrap hover:text-db-navy">Research Notes</a>
        <a href="#all" className="text-db-subtle px-4 py-3 whitespace-nowrap hover:text-db-navy">Every field on record</a>
      </nav>

      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-6 grid md:grid-cols-2 gap-6">
        <SectionCard id="transaction" title="Transaction">
          {last ? (
            <p className="text-sm leading-relaxed">
              {sameOwner
                ? <><b>{titleCase(r.name)}</b> was last recorded on <b className="num">{last.date}</b>{last.price ? <> at <b className="num">{money(last.price)}</b></> : null}, staying with <b>{titleCase(last.buyer)}</b> (a transfer or refinancing, not a change of owner).</>
                : <><b>{titleCase(r.name)}</b> last sold on <b className="num">{last.date}</b>{last.price ? <> for <b className="num">{money(last.price)}</b></> : ' (price not on record)'}{last.buyer ? <> to <b>{titleCase(last.buyer)}</b></> : null}{last.seller ? <>, purchased from {titleCase(last.seller)}</> : null}.</>}
              {r.saleList.length > 1 ? ` Databank has ${r.saleList.length} sales on record for this property.` : ''}
            </p>
          ) : <p className="text-sm text-db-muted">No sale on record for this property.</p>}
          {sales.length > 0 && (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-db-muted"><th className="py-1 pr-3 font-semibold">Date</th><th className="py-1 pr-3 font-semibold">Price</th><th className="py-1 pr-3 font-semibold">Buyer</th><th className="py-1 font-semibold">Seller</th></tr></thead>
              <tbody className="divide-y divide-db-border">
                {sales.map((s, i) => (
                  <tr key={i}><td className="py-1.5 pr-3 whitespace-nowrap num">{s.date}</td><td className="py-1.5 pr-3 whitespace-nowrap font-semibold num">{money(s.price)}</td><td className="py-1.5 pr-3">{titleCase(s.buyer) || '—'}</td><td className="py-1.5">{titleCase(s.seller) || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {(r.loan || r.lender || r.broker) && (
            <div className="pt-3 border-t border-db-border text-sm flex flex-wrap gap-x-6 gap-y-1">
              {r.loan && <span><span className="text-db-muted">Loan:</span> <b className="num">{money(r.loan)}</b></span>}
              {r.lender && <span><span className="text-db-muted">Lender:</span> {titleCase(r.lender)}</span>}
              {r.broker && <span><span className="text-db-muted">Broker:</span> {titleCase(r.broker)}</span>}
            </div>
          )}
        </SectionCard>

        <SectionCard id="ownership" title="Ownership & Contacts">
          <p className="text-sm"><span className="text-db-muted">Current owner:</span> <b>{titleCase(r.owner) || '—'}</b></p>
          {owners.length > 1 && (
            <ol className="space-y-1 text-sm">
              {owners.map((o, i) => (
                <li key={i} className="flex gap-3"><span className="w-28 flex-shrink-0 text-db-muted num">{i === owners.length - 1 ? `by ${o.week}` : o.week}</span><span>{titleCase(o.value)}</span></li>
              ))}
            </ol>
          )}
          {r.contacts.length > 0 ? (
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 pt-2 border-t border-db-border">
              {r.contacts.map((c) => (
                <div key={c.label} className="text-sm"><span className="text-db-muted">{c.label}:</span> {c.label.includes('Phone') || c.label.includes('Contact') ? <span className="num">{c.value}</span> : c.value}</div>
              ))}
            </div>
          ) : owners.length <= 1 && (
            <p className="text-sm text-db-muted">No additional contacts on record.</p>
          )}
        </SectionCard>

        <SectionCard id="notes" title="Research Notes &amp; History">
          {r.comments ? (
            <>
              <div className="bg-db-cream rounded-lg px-4 py-3 text-sm leading-relaxed text-db-subtle whitespace-pre-line">
                <span className="block text-[11px] font-semibold text-db-muted mb-1 uppercase tracking-wide">Original researcher notes</span>
                {r.comments}
              </div>
              {notesAi ? (
                <div className="border border-db-border rounded-lg px-4 py-3">
                  <span className="block text-[11px] font-semibold text-db-navy mb-1 uppercase tracking-wide">Cleaned up by AI</span>
                  {notesAi.summary && <p className="text-sm font-semibold text-db-ink mb-1">{notesAi.summary}</p>}
                  <p className="text-sm leading-relaxed text-db-subtle whitespace-pre-line m-0">{notesAi.cleaned}</p>
                </div>
              ) : (
                <button
                  onClick={fetchNotesAi}
                  disabled={notesAiLoading}
                  className="self-start inline-flex items-center gap-2 text-sm font-semibold text-db-navy hover:underline disabled:opacity-60"
                >
                  {notesAiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {notesAiLoading ? 'Cleaning up the notes…' : 'Show a cleaner, plain-English version'}
                </button>
              )}
              {notesAiError && <p className="text-xs text-db-muted">{notesAiError}</p>}
            </>
          ) : <p className="text-sm text-db-muted">No researcher notes on record.</p>}
        </SectionCard>

        <div id="all" className="md:col-span-2 bg-white border border-db-border rounded-xl px-6 py-5 flex items-center justify-between gap-4 flex-wrap scroll-mt-20">
          <div>
            <div className="font-semibold text-sm">Every field on record</div>
            <div className="text-xs text-db-muted">{r.allFields.length} fields from the research file</div>
          </div>
          <button onClick={() => setShowAll((v) => !v)} className="border border-db-navy text-db-navy px-4 py-2 rounded-lg text-sm font-semibold hover:bg-db-tint">
            {showAll ? 'Hide fields' : 'Show all fields'}
          </button>
        </div>
        {showAll && (
          <div className="md:col-span-2 bg-white border border-db-border rounded-xl px-6 py-5 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
            {r.allFields.map((f) => (
              <div key={f.label}><div className="text-[11px] uppercase tracking-wide text-db-muted">{f.label}</div><div className="font-semibold text-sm num break-words">{f.value}</div></div>
            ))}
          </div>
        )}
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-8 pb-10 text-xs text-db-muted">
        Data as of the Insider week of {r.last} · every sale verified by Databank research staff · Source: Databank Atlanta research.
      </div>
    </div>
  );
}
