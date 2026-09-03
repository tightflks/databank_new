import { useEffect, useState } from 'react';
import axios from 'axios';
import { Camera, Check, Loader2, Trash2, X } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

type Status = 'pending' | 'approved' | 'rejected';

interface Item {
  key: string;
  name: string;
  address: string;
  city: string;
  zip: string;
  database_type: string;
  status: Status;
  pano_date: string | null;
  created_date: string;
  has_image: number;
}

const DATABASES = [
  { id: 'apartments', label: 'Apartments' },
  { id: 'franchise', label: 'Franchise' },
  { id: 'industrial', label: 'Industrial' },
  { id: 'land', label: 'Land' },
  { id: 'offices', label: 'Offices' },
  { id: 'retail', label: 'Retail' },
];

export default function PhotoReview() {
  const [tab, setTab] = useState<Status>('pending');
  const [items, setItems] = useState<Item[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [fetching, setFetching] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = async (s: Status) => {
    const r = await axios.get<{ counts: Record<string, number>; items: Item[] }>(`${API_URL}/api/photos`, { params: { status: s } });
    setCounts(r.data.counts);
    setItems(r.data.items);
  };
  useEffect(() => { setItems(null); load(tab); }, [tab]);

  const review = async (key: string, status: Status) => {
    await axios.post(`${API_URL}/api/photos/${key}/review`, { status });
    setItems((cur) => (cur ? cur.filter((i) => i.key !== key) : cur));
    setCounts((c) => ({ ...c, [tab]: (c[tab] ?? 1) - 1, [status]: (c[status] ?? 0) + 1 }));
  };

  const remove = async (key: string) => {
    if (!confirm('Delete this photo? It can be fetched again later.')) return;
    await axios.delete(`${API_URL}/api/photos/${key}`);
    setItems((cur) => (cur ? cur.filter((i) => i.key !== key) : cur));
  };

  const fetchAll = async (databaseId: string) => {
    setFetching(databaseId); setMessage(null);
    try {
      const r = await axios.post<{ fetched: number; missing: number; skipped: number; errors: number; remaining: number }>(`${API_URL}/api/photos/fetch-all/${databaseId}`, { limit: 200 });
      const d = r.data;
      setMessage(`${databaseId}: ${d.fetched} new photos, ${d.missing} with no Street View, ${d.skipped} already done${d.errors ? `, ${d.errors} errors` : ''}${d.remaining > 0 ? ` — ${d.remaining} left, run again` : ''}.`);
      await load(tab);
    } catch (e) {
      setMessage(axios.isAxiosError(e) ? e.response?.data?.error || e.message : 'Fetch failed');
    } finally { setFetching(null); }
  };

  return (
    <div className="bg-white rounded-2xl shadow-xl p-8 space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-800 mb-1">Property photos</h2>
        <p className="text-gray-600 text-sm">Street View shots fetched per address. Customers only ever see <b>approved</b> photos; everything else shows "Photo coming soon".</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-gray-500 mr-1">Fetch missing (200 per run):</span>
        {DATABASES.map((d) => (
          <button key={d.id} onClick={() => fetchAll(d.id)} disabled={fetching !== null} className="px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 font-medium disabled:opacity-50 flex items-center gap-1">
            {fetching === d.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />} {d.label}
          </button>
        ))}
      </div>
      {message && <p className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">{message}</p>}

      <div className="inline-flex rounded-xl bg-gray-100 p-1 gap-1">
        {(['pending', 'approved', 'rejected'] as Status[]).map((s) => (
          <button key={s} onClick={() => setTab(s)} className={`px-4 py-1.5 rounded-lg text-sm font-semibold ${tab === s ? 'bg-white shadow text-[#0b1f5c]' : 'text-gray-600'}`}>
            {s[0].toUpperCase() + s.slice(1)} <span className="text-gray-400">{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      {items === null ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
      ) : items.length === 0 ? (
        <p className="text-gray-500 text-sm py-8 text-center">Nothing {tab} yet.</p>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((it) => (
            <div key={it.key} className="rounded-xl border border-gray-200 overflow-hidden flex flex-col">
              {it.has_image ? (
                <img src={`${API_URL}/api/photos/${it.key}/image`} alt={it.name} className="w-full h-44 object-cover" loading="lazy" />
              ) : (
                <div className="w-full h-44 bg-gray-100 flex items-center justify-center text-gray-400 text-sm">No Street View at this address</div>
              )}
              <div className="p-3 text-sm flex-1">
                <p className="font-semibold text-gray-900 truncate" title={it.name}>{it.name}</p>
                <p className="text-gray-600 truncate">{it.address}, {it.city} {it.zip}</p>
                <p className="text-gray-400 text-xs mt-1">{it.database_type}{it.pano_date ? ` · Street View ${it.pano_date}` : ''}</p>
              </div>
              <div className="flex gap-2 p-3 pt-0">
                {tab !== 'approved' && it.has_image ? (
                  <button onClick={() => review(it.key, 'approved')} className="flex-1 px-3 py-1.5 rounded-lg bg-green-600 text-white font-semibold text-sm flex items-center justify-center gap-1"><Check className="w-4 h-4" /> Approve</button>
                ) : null}
                {tab !== 'rejected' && (
                  <button onClick={() => review(it.key, 'rejected')} className="flex-1 px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 font-semibold text-sm flex items-center justify-center gap-1"><X className="w-4 h-4" /> Reject</button>
                )}
                <button onClick={() => remove(it.key)} title="Delete" className="px-2 py-1.5 rounded-lg text-gray-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
