import { useEffect, useState, type FormEvent } from 'react';
import axios from 'axios';
import { TrendingUp, Mail, CheckCircle, Loader2, ArrowRight } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

type Stats = {
  week: string | null;
  totalProperties: number;
  thisWeek: { count: number; volume: number; biggest: { name: string; city: string; price: number; type: string } | null };
  quarters: { label: string; volume: number; count: number }[];
  featured: { key: string; name: string; city: string; type: string }[];
};

const money = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M` : `$${Math.round(n / 1e3)}K`;

const weekLabel = (w: string | null) => {
  if (!w) return 'latest week';
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(w);
  if (!m) return w;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

function TrustNumbers({ total }: { total: number }) {
  const items = [
    { n: 'Since 1970', t: 'Reporting on Atlanta commercial real estate' },
    { n: total ? `${Math.round(total / 1000)}k+` : '10,000+', t: 'Researched properties online' },
    { n: '100+', t: 'Fields per property record' },
    { n: '25 yrs', t: 'Average staff experience' }
  ];
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {items.map((i) => (
        <div key={i.t} className="bg-[#0b1f5c] text-white rounded-xl p-4 text-center">
          <p className="text-2xl sm:text-3xl font-bold">{i.n}</p>
          <p className="text-xs text-blue-200 mt-1">{i.t}</p>
        </div>
      ))}
    </div>
  );
}

function VolumeChart({ quarters }: { quarters: Stats['quarters'] }) {
  if (quarters.length < 2) return null;
  const max = Math.max(...quarters.map((q) => q.volume));
  return (
    <div className="bg-white rounded-2xl shadow p-6">
      <div className="flex items-center gap-2 mb-1"><TrendingUp className="w-5 h-5 text-[#0b1f5c]" /><h3 className="font-bold text-gray-900">Atlanta sales volume by quarter</h3></div>
      <p className="text-xs text-gray-500 mb-5">All five databases · sale price of reported transactions</p>
      <div className="flex items-end gap-2 h-40">
        {quarters.map((q) => (
          <div key={q.label} className="flex-1 flex flex-col items-center gap-1 group">
            <span className="text-[10px] text-gray-500 opacity-0 group-hover:opacity-100 transition">{money(q.volume)} · {q.count}</span>
            <div className="w-full bg-blue-100 rounded-t-md relative" style={{ height: `${Math.max(4, (q.volume / max) * 100)}%` }}>
              <div className="absolute inset-0 bg-[#0b1f5c] rounded-t-md opacity-80 group-hover:opacity-100" />
            </div>
            <span className="text-[10px] text-gray-500 whitespace-nowrap">{q.label}</span>
          </div>
        ))}
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
    <div className="bg-gradient-to-br from-[#0b1f5c] to-[#1e3a8a] text-white rounded-2xl shadow p-6 flex flex-col justify-center">
      <div className="flex items-center gap-2 mb-1"><Mail className="w-5 h-5 text-blue-200" /><h3 className="font-bold">Get one Insider Report free</h3></div>
      <p className="text-sm text-blue-100 mb-4">See exactly what Databank clients receive every Thursday — no commitment.</p>
      {state === 'sent' ? (
        <p className="flex items-center gap-2 text-sm bg-white/10 rounded-lg px-3 py-2"><CheckCircle className="w-4 h-4" /> Thanks — we'll send it to {email}.</p>
      ) : (
        <form onSubmit={submit} className="flex gap-2">
          <input type="email" required placeholder="Work email" value={email} onChange={(e) => setEmail(e.target.value)} className="flex-1 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none" />
          <button disabled={state === 'sending'} className="bg-white text-[#0b1f5c] font-semibold px-4 rounded-lg hover:bg-blue-50 disabled:opacity-50">
            {state === 'sending' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
          </button>
        </form>
      )}
      {state === 'error' && <p className="text-xs text-red-200 mt-2">Couldn't send — please call (404) 872-8880.</p>}
    </div>
  );
}

export default function MarketPulse({ onStart }: { onStart: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    axios.get<Stats>(`${API_URL}/api/public/stats`).then((r) => setStats(r.data)).catch(() => setStats(null));
  }, []);

  const tw = stats?.thisWeek;
  return (
    <div className="space-y-6">
      <TrustNumbers total={stats?.totalProperties ?? 0} />

      {stats && tw && tw.count > 0 && (
        <div className="bg-white rounded-2xl shadow p-6 sm:p-8">
          <p className="uppercase tracking-widest text-xs text-gray-500 mb-1">Latest Insider week · {weekLabel(stats.week)}</p>
          <div className="grid sm:grid-cols-3 gap-6 mt-3">
            <div><p className="text-3xl font-bold text-gray-900">{tw.count}</p><p className="text-sm text-gray-600">new transactions reported</p></div>
            <div><p className="text-3xl font-bold text-gray-900">{money(tw.volume)}</p><p className="text-sm text-gray-600">total sale volume</p></div>
            {tw.biggest && (
              <div>
                <p className="text-3xl font-bold text-gray-900">{money(tw.biggest.price)}</p>
                <p className="text-sm text-gray-600 truncate" title={tw.biggest.name}>largest: {tw.biggest.name}{tw.biggest.city ? `, ${tw.biggest.city}` : ''}</p>
              </div>
            )}
          </div>
          <button onClick={onStart} className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[#0b1f5c] hover:underline">See this week's sales <ArrowRight className="w-4 h-4" /></button>
        </div>
      )}

      {stats && stats.featured.length > 0 && (
        <div className="grid sm:grid-cols-3 gap-4">
          {stats.featured.map((f) => (
            <button key={f.key} onClick={onStart} className="text-left bg-white rounded-xl shadow overflow-hidden hover:shadow-md transition">
              <img src={`${API_URL}/api/photos/${f.key}/image`} alt={f.name} className="w-full h-36 object-cover" loading="lazy" />
              <div className="p-3">
                <p className="font-semibold text-gray-900 truncate">{f.name}</p>
                <p className="text-xs text-gray-500">{f.city} · {f.type}</p>
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
