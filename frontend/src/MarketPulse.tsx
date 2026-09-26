import { useEffect, useState, type FormEvent } from 'react';
import axios from 'axios';
import { TrendingUp, Mail, CheckCircle, Loader2, ArrowRight } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

export type Stats = {
  week: string | null;
  totalProperties: number;
  thisWeek: { count: number; volume: number; biggest: { name: string; city: string; price: number; type: string } | null };
  quarters: { label: string; volume: number; count: number }[];
  featured: { key: string; name: string; city: string; type: string }[];
};

export const money = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M` : `$${Math.round(n / 1e3)}K`;

export const weekLabel = (w: string | null) => {
  if (!w) return 'latest week';
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(w);
  if (!m) return w;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export function useStats(): Stats | null {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    axios.get<Stats>(`${API_URL}/api/public/stats`).then((r) => setStats(r.data)).catch(() => setStats(null));
  }, []);
  return stats;
}

function TrustNumbers({ total }: { total: number }) {
  const items = [
    { n: 'Since 1970', t: 'Reporting on Atlanta commercial real estate' },
    { n: total ? `${Math.round(total / 1000)}k+` : '18,000+', t: 'Researched properties online' },
    { n: '100+', t: 'Fields per property record' },
    { n: '25 yrs', t: 'Average staff experience' }
  ];
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {items.map((i) => (
        <div key={i.t} className="bg-db-navy text-white rounded-xl p-4 text-center">
          <p className="text-2xl sm:text-3xl font-semibold num">{i.n}</p>
          <p className="text-xs text-db-tint mt-1">{i.t}</p>
        </div>
      ))}
    </div>
  );
}

// The current quarter isn't finished yet, so its bar is drawn hollow/dashed with a "QTD" label
// instead of solid — otherwise a partial quarter reads as a market decline (Sep 24 audit).
function currentQuarterLabel(): string {
  const d = new Date();
  return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
}

function VolumeChart({ quarters }: { quarters: Stats['quarters'] }) {
  if (quarters.length < 2) return null;
  const max = Math.max(...quarters.map((q) => q.volume));
  const liveQ = currentQuarterLabel();
  return (
    <div className="bg-white border border-db-border rounded-2xl p-6">
      <div className="flex items-center gap-2 mb-1"><TrendingUp className="w-5 h-5 text-db-navy" /><h3 className="font-bold tracking-tight text-lg text-db-ink m-0">Atlanta sales volume by quarter</h3></div>
      <p className="text-xs text-db-muted mb-5">All five databases · sale price of reported transactions</p>
      <div className="flex items-end gap-2">
        {quarters.map((q) => {
          const qtd = q.label === liveQ;
          return (
            <div key={q.label} className="flex-1 flex flex-col items-center gap-1 group">
              <span className="text-[10px] text-db-subtle font-semibold whitespace-nowrap num">{money(q.volume)}{qtd ? ' so far' : ''}</span>
              <div
                className={qtd ? 'w-full rounded-t-md bg-white border-[1.5px] border-dashed border-db-navy border-b-0' : 'w-full bg-db-navy rounded-t-md opacity-80 group-hover:opacity-100 transition'}
                style={{ height: `${Math.max(6, Math.round((q.volume / max) * 140))}px` }}
                title={`${q.count} transactions${qtd ? ' so far this quarter' : ''}`}
              />
              <span className="text-[10px] text-db-muted whitespace-nowrap num">{qtd ? `${q.label} QTD` : q.label}</span>
            </div>
          );
        })}
      </div>
      <div className="flex gap-5 text-[11px] text-db-muted mt-4 pt-3 border-t border-db-border">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-db-navy rounded-sm" /> Closed quarter</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 border-[1.5px] border-dashed border-db-navy rounded-sm" /> Quarter to date</span>
      </div>
    </div>
  );
}

function ReportSignup() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('sending');
    try {
      await axios.post(`${API_URL}/api/feedback`, { message: '[Free weekly report request]', contact: email, page: 'signup' });
      setState('sent');
    } catch { setState('error'); }
  };
  return (
    <div className="bg-db-navy text-white rounded-2xl p-6 flex flex-col justify-center">
      <div className="flex items-center gap-2 mb-1"><Mail className="w-5 h-5 text-db-tint" /><h3 className="font-semibold m-0">Get one Insider Report free</h3></div>
      <p className="text-sm text-db-tint mb-4">See exactly what Databank clients receive every Thursday — no commitment.</p>
      {state === 'sent' ? (
        <p className="flex items-center gap-2 text-sm bg-white/10 rounded-lg px-3 py-2"><CheckCircle className="w-4 h-4" /> Thanks — we'll send it to {email}.</p>
      ) : (
        <form onSubmit={submit} className="flex gap-2">
          <input type="email" required placeholder="Work email" value={email} onChange={(e) => setEmail(e.target.value)} className="flex-1 rounded-lg px-3 py-2 text-sm text-db-text focus:outline-none" />
          <button disabled={state === 'sending'} className="bg-white text-db-navy font-semibold px-4 rounded-lg hover:bg-gray-100 disabled:opacity-50">
            {state === 'sending' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
          </button>
        </form>
      )}
      {state === 'error' && <p className="text-xs text-red-200 mt-2">Couldn't send — please call (404) 872-8880.</p>}
    </div>
  );
}

export default function MarketPulse({ onStart, stats }: { onStart: () => void; stats: Stats | null }) {
  return (
    <div className="space-y-6">
      <TrustNumbers total={stats?.totalProperties ?? 0} />

      {stats && stats.featured.length > 0 && (
        <div className="grid sm:grid-cols-3 gap-4">
          {stats.featured.map((f) => (
            <button key={f.key} onClick={onStart} className="text-left bg-white border border-db-border rounded-xl overflow-hidden hover:shadow-md transition">
              <img src={`${API_URL}/api/photos/${f.key}/image`} alt={f.name} className="w-full h-36 object-cover" loading="lazy" />
              <div className="p-3">
                <p className="font-semibold text-db-ink truncate">{f.name}</p>
                <p className="text-xs text-db-muted">{f.city} · {f.type}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      <div className={`grid gap-4 ${stats && stats.quarters.length >= 2 ? 'lg:grid-cols-[2fr,1fr]' : ''}`}>
        {stats && stats.quarters.length >= 2 && <VolumeChart quarters={stats.quarters} />}
        <ReportSignup />
      </div>
    </div>
  );
}
