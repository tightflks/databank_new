import { useEffect, useState } from 'react';
import axios from 'axios';
import { Loader2, Trash2, MessageSquare, ImageIcon, Plus, X } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

type Status = 'pending' | 'solved';
type Source = 'website' | 'call' | 'other';

interface Feedback {
  id: number;
  message: string;
  contact: string | null;
  page: string | null;
  database_type: string | null;
  email: string | null;
  status: Status;
  resolution: string | null;
  source: Source;
  has_screenshot: number;
  created_date: string;
}

function StatusBadge({ status }: { status: Status }) {
  return status === 'solved' ? (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">Solved</span>
  ) : (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">Pending</span>
  );
}

// Logging a call (or any other non-website source) so it lands in the same list as what comes
// through the site's own Feedback button — Blake uses both.
function AddManualEntry({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [source, setSource] = useState<'call' | 'other'>('call');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!message.trim() || saving) return;
    setSaving(true);
    try {
      await axios.post(`${API_URL}/api/feedback/manual`, { message: message.trim(), contact: contact.trim() || null, source });
      setMessage('');
      setContact('');
      setOpen(false);
      onAdded();
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:underline">
        <Plus className="w-4 h-4" /> Log a call or other feedback
      </button>
    );
  }
  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-gray-50 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-700">Log feedback from a call or other source</span>
        <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
      </div>
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="What did they say?" className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400" />
      <div className="flex gap-2 items-center flex-wrap">
        <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Who (name/company, optional)" className="flex-1 min-w-[10rem] text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400" />
        <select value={source} onChange={(e) => setSource(e.target.value as 'call' | 'other')} className="text-sm border border-gray-300 rounded-lg px-2 py-2">
          <option value="call">Phone call</option>
          <option value="other">Other</option>
        </select>
        <button onClick={submit} disabled={!message.trim() || saving} className="bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Add
        </button>
      </div>
    </div>
  );
}

export default function FeedbackList() {
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [tab, setTab] = useState<'website' | 'other'>('website');
  const [error, setError] = useState<string | null>(null);
  const [openImage, setOpenImage] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<number | null>(null);

  const load = async () => {
    try {
      const r = await axios.get<Feedback[]>(`${API_URL}/api/feedback`);
      setItems(r.data);
      setDraft(Object.fromEntries(r.data.map((f) => [f.id, f.resolution ?? ''])));
    } catch {
      setError('Could not load feedback.');
    }
  };
  useEffect(() => { load(); }, []);

  const remove = async (id: number) => {
    if (!confirm('Delete this feedback?')) return;
    await axios.delete(`${API_URL}/api/feedback/${id}`);
    setItems((cur) => (cur ? cur.filter((f) => f.id !== id) : cur));
  };

  const setStatus = async (f: Feedback, status: Status) => {
    setItems((cur) => (cur ? cur.map((x) => (x.id === f.id ? { ...x, status } : x)) : cur));
    await axios.post(`${API_URL}/api/feedback/${f.id}/status`, { status, resolution: draft[f.id] ?? f.resolution ?? '' }).catch(() => load());
  };

  const saveResolution = async (f: Feedback) => {
    setSaving(f.id);
    try {
      const resolution = draft[f.id] ?? '';
      await axios.post(`${API_URL}/api/feedback/${f.id}/status`, { status: f.status, resolution });
      setItems((cur) => (cur ? cur.map((x) => (x.id === f.id ? { ...x, resolution } : x)) : cur));
    } finally {
      setSaving(null);
    }
  };

  const websiteItems = items?.filter((f) => f.source === 'website' || !f.source) ?? [];
  const otherItems = items?.filter((f) => f.source === 'call' || f.source === 'other') ?? [];
  const shown = tab === 'website' ? websiteItems : otherItems;
  const pendingCount = shown.filter((f) => f.status !== 'solved').length;

  const TabButton = ({ id, label, count }: { id: 'website' | 'other'; label: string; count: number }) => (
    <button
      onClick={() => setTab(id)}
      className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${tab === id ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
    >
      {label} <span className={tab === id ? 'text-blue-100' : 'text-gray-400'}>({count})</span>
    </button>
  );

  return (
    <div className="bg-white rounded-2xl shadow-xl p-8">
      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-800 mb-1">Customer feedback</h2>
          <p className="text-gray-600 text-sm">From the site's Feedback button, plus anything logged from a call or elsewhere.</p>
        </div>
        {items && (
          <div className="flex gap-3">
            <div className="bg-amber-50 text-amber-800 rounded-xl px-4 py-2 text-center">
              <div className="text-xl font-bold">{pendingCount}</div>
              <div className="text-xs">pending here</div>
            </div>
            <div className="bg-gray-50 text-gray-700 rounded-xl px-4 py-2 text-center">
              <div className="text-xl font-bold">{items.length}</div>
              <div className="text-xs">total</div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div className="flex gap-2">
          <TabButton id="website" label="From the website" count={websiteItems.length} />
          <TabButton id="other" label="Calls & other sources" count={otherItems.length} />
        </div>
        <AddManualEntry onAdded={load} />
      </div>

      {error && <p className="text-red-600 text-sm">{error}</p>}
      {items === null ? (
        <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>
      ) : shown.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <MessageSquare className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          {tab === 'website' ? 'No website feedback yet.' : 'Nothing logged from a call or other source yet.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-3 w-16">Status</th>
                <th className="py-2 pr-3">Feedback</th>
                <th className="py-2 pr-3">From / when</th>
                <th className="py-2 pr-3 w-64">Changes made</th>
                <th className="py-2 pr-3 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {shown.map((f) => (
                <tr key={f.id} className="align-top">
                  <td className="py-3 pr-3">
                    <select
                      value={f.status}
                      onChange={(e) => setStatus(f, e.target.value as Status)}
                      className="text-xs border border-gray-200 rounded-lg px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-blue-400"
                    >
                      <option value="pending">Pending</option>
                      <option value="solved">Solved</option>
                    </select>
                    <div className="mt-1"><StatusBadge status={f.status} /></div>
                  </td>
                  <td className="py-3 pr-3 max-w-md">
                    <p className="whitespace-pre-wrap text-gray-900">{f.message}</p>
                    {f.has_screenshot ? (
                      <button onClick={() => setOpenImage(openImage === f.id ? null : f.id)} className="mt-2 flex items-center gap-1.5 text-xs text-blue-600 hover:underline">
                        <ImageIcon className="w-3.5 h-3.5" /> {openImage === f.id ? 'Hide' : 'View'} attached image
                      </button>
                    ) : null}
                    {openImage === f.id && (
                      <img src={`${API_URL}/api/feedback/${f.id}/screenshot`} alt="Attached screenshot" className="mt-2 max-w-xs rounded-lg border border-gray-200" />
                    )}
                  </td>
                  <td className="py-3 pr-3 text-xs text-gray-500 whitespace-nowrap">
                    <div>{f.email ? `${f.email} (signed in)` : f.contact || 'anonymous'}</div>
                    <div>{new Date(f.created_date + (f.created_date.endsWith('Z') ? '' : 'Z')).toLocaleString()}</div>
                    {f.source && f.source !== 'website' && <div className="capitalize text-gray-400">{f.source}</div>}
                    {f.page && <div className="truncate max-w-[10rem]">{f.page}</div>}
                  </td>
                  <td className="py-3 pr-3">
                    <textarea
                      value={draft[f.id] ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.id]: e.target.value }))}
                      onBlur={() => saveResolution(f)}
                      placeholder="What changed in response to this (optional)…"
                      rows={2}
                      className="w-full text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 resize-y"
                    />
                    {saving === f.id && <span className="text-[10px] text-gray-400">Saving…</span>}
                  </td>
                  <td className="py-3">
                    <button onClick={() => remove(f.id)} title="Delete" className="text-gray-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
