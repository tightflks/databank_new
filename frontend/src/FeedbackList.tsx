import { useEffect, useState } from 'react';
import axios from 'axios';
import { Loader2, Trash2, MessageSquare, ImageIcon } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

type Status = 'pending' | 'solved';

interface Feedback {
  id: number;
  message: string;
  contact: string | null;
  page: string | null;
  database_type: string | null;
  email: string | null;
  status: Status;
  resolution: string | null;
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

export default function FeedbackList() {
  const [items, setItems] = useState<Feedback[] | null>(null);
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

  const pendingCount = items?.filter((f) => f.status !== 'solved').length ?? 0;

  return (
    <div className="bg-white rounded-2xl shadow-xl p-8">
      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-800 mb-1">Customer feedback</h2>
          <p className="text-gray-600 text-sm">Everything sent from the Feedback button on the customer view. Pending items sort to the top.</p>
        </div>
        {items && (
          <div className="flex gap-3">
            <div className="bg-amber-50 text-amber-800 rounded-xl px-4 py-2 text-center">
              <div className="text-xl font-bold">{pendingCount}</div>
              <div className="text-xs">pending</div>
            </div>
            <div className="bg-gray-50 text-gray-700 rounded-xl px-4 py-2 text-center">
              <div className="text-xl font-bold">{items.length}</div>
              <div className="text-xs">total</div>
            </div>
          </div>
        )}
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      {items === null ? (
        <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <MessageSquare className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          No feedback yet.
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
              {items.map((f) => (
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
