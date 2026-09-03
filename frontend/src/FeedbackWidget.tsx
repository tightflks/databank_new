import { useState } from 'react';
import axios from 'axios';
import { MessageSquare, X, Loader2, CheckCircle } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

export default function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!message.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await axios.post(`${API_URL}/api/feedback`, {
        message: message.trim(),
        contact: contact.trim() || null,
        page: window.location.pathname + window.location.hash,
      });
      setSent(true);
      setMessage('');
      setTimeout(() => { setOpen(false); setSent(false); }, 1500);
    } catch (e: unknown) {
      const msg = axios.isAxiosError(e) ? e.response?.data?.error : null;
      setError(typeof msg === 'string' ? msg : 'Could not send feedback. Please try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50">
      {open ? (
        <div className="w-80 bg-white rounded-xl shadow-2xl border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-gray-800 flex items-center gap-2"><MessageSquare className="w-4 h-4 text-[#0b1f5c]" /> Feedback</h3>
            <button onClick={() => setOpen(false)} aria-label="Close" className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
          </div>
          {sent ? (
            <div className="flex items-center gap-2 text-emerald-700 text-sm py-6 justify-center"><CheckCircle className="w-5 h-5" /> Thanks — sent to Databank.</div>
          ) : (
            <>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                maxLength={4000}
                placeholder="What's wrong, missing, or confusing? Send it raw — we'll sort it."
                className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <input
                type="text"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                maxLength={200}
                placeholder="Your name or email (optional)"
                className="w-full mt-2 border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
              <button
                onClick={submit}
                disabled={!message.trim() || sending}
                className="mt-3 w-full py-2 rounded-lg bg-[#0b1f5c] text-white text-sm font-semibold hover:bg-[#122a75] disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {sending && <Loader2 className="w-4 h-4 animate-spin" />} Send
              </button>
            </>
          )}
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-[#0b1f5c] text-white text-sm font-semibold shadow-lg hover:bg-[#122a75]"
        >
          <MessageSquare className="w-4 h-4" /> Feedback
        </button>
      )}
    </div>
  );
}
