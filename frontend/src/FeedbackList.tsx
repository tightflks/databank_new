import { useEffect, useState } from 'react';
import axios from 'axios';
import { Loader2, Trash2, MessageSquare, ImageIcon, CheckCircle2, Circle } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

interface Feedback {
  id: number;
  message: string;
  contact: string | null;
  page: string | null;
  database_type: string | null;
  email: string | null;
  replied: number;
  has_screenshot: number;
  created_date: string;
}

export default function FeedbackList() {
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openImage, setOpenImage] = useState<number | null>(null);

  const load = async () => {
    try {
      const r = await axios.get<Feedback[]>(`${API_URL}/api/feedback`);
      setItems(r.data);
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

  const toggleReplied = async (f: Feedback) => {
    const replied = f.replied ? 0 : 1;
    setItems((cur) => (cur ? cur.map((x) => (x.id === f.id ? { ...x, replied } : x)) : cur));
    await axios.post(`${API_URL}/api/feedback/${f.id}/replied`, { replied: Boolean(replied) }).catch(() => load());
  };

  return (
    <div className="bg-white rounded-2xl shadow-xl p-8">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800 mb-1">Customer feedback</h2>
        <p className="text-gray-600 text-sm">Everything sent from the Feedback button on the customer view, newest first.</p>
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
        <ul className="divide-y divide-gray-100">
          {items.map((f) => (
            <li key={f.id} className="py-4 flex gap-4">
              <button
                onClick={() => toggleReplied(f)}
                title={f.replied ? 'Mark as not replied' : 'Mark as replied'}
                className={`mt-0.5 flex-shrink-0 ${f.replied ? 'text-emerald-600' : 'text-gray-300 hover:text-gray-400'}`}
              >
                {f.replied ? <CheckCircle2 className="w-5 h-5" /> : <Circle className="w-5 h-5" />}
              </button>
              <div className="flex-1 min-w-0">
                <p className={`text-sm whitespace-pre-wrap ${f.replied ? 'text-gray-500' : 'text-gray-900'}`}>{f.message}</p>
                {f.has_screenshot ? (
                  <button onClick={() => setOpenImage(openImage === f.id ? null : f.id)} className="mt-2 flex items-center gap-1.5 text-xs text-blue-600 hover:underline">
                    <ImageIcon className="w-3.5 h-3.5" /> {openImage === f.id ? 'Hide' : 'View'} attached image
                  </button>
                ) : null}
                {openImage === f.id && (
                  <img src={`${API_URL}/api/feedback/${f.id}/screenshot`} alt="Attached screenshot" className="mt-2 max-w-md rounded-lg border border-gray-200" />
                )}
                <p className="text-xs text-gray-500 mt-1">
                  {new Date(f.created_date + (f.created_date.endsWith('Z') ? '' : 'Z')).toLocaleString()}
                  {f.email ? ` · ${f.email} (signed in)` : f.contact ? ` · ${f.contact}` : ' · anonymous'}
                  {f.page ? ` · ${f.page}` : ''}
                  {f.replied ? ' · replied' : ''}
                </p>
              </div>
              <button onClick={() => remove(f.id)} title="Delete" className="text-gray-400 hover:text-red-600 self-start"><Trash2 className="w-4 h-4" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
