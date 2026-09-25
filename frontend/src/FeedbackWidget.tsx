import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { MessageSquare, X, Loader2, CheckCircle, Paperclip } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

interface Props {
  // The signed-in email is shown (and sent) automatically once someone's logged in — "once
  // users have to log in, this happens automatically" per the written feedback list.
  userEmail?: string | null;
}

export default function FeedbackWidget({ userEmail }: Props) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [screenshot, setScreenshot] = useState<{ dataUrl: string; name: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const prefill = (e as CustomEvent<{ prefill?: string }>).detail?.prefill;
      if (prefill) setMessage((m) => m || prefill);
      setOpen(true);
    };
    window.addEventListener('databank:open-feedback', onOpen);
    return () => window.removeEventListener('databank:open-feedback', onOpen);
  }, []);

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('Attachment must be an image (screenshot or photo).'); return; }
    if (file.size > 8 * 1024 * 1024) { setError('Image is too large (8MB max).'); return; }
    setError(null);
    const reader = new FileReader();
    reader.onload = () => setScreenshot({ dataUrl: String(reader.result), name: file.name });
    reader.readAsDataURL(file);
  };

  const submit = async () => {
    if (!message.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await axios.post(`${API_URL}/api/feedback`, {
        message: message.trim(),
        contact: contact.trim() || null,
        page: window.location.pathname + window.location.hash,
        screenshot: screenshot?.dataUrl || null,
      });
      setSent(true);
      setMessage('');
      setScreenshot(null);
      setTimeout(() => { setOpen(false); setSent(false); }, 1500);
    } catch (e: unknown) {
      const msg = axios.isAxiosError(e) ? e.response?.data?.error : null;
      setError(typeof msg === 'string' ? msg : 'Could not send feedback. Please try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 font-sans">
      {open ? (
        <div className="w-80 bg-white rounded-xl shadow-2xl border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-db-ink flex items-center gap-2"><MessageSquare className="w-4 h-4 text-db-navy" /> Feedback</h3>
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
                className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-db-navy/40 focus:border-db-navy"
              />
              {userEmail ? (
                <p className="text-xs text-db-muted mt-2">Sending as <span className="font-medium text-db-text">{userEmail}</span> — we'll reply there.</p>
              ) : (
                <input
                  type="text"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  maxLength={200}
                  placeholder="Your name or email (optional)"
                  className="w-full mt-2 border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-db-navy/40 focus:border-db-navy"
                />
              )}
              <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => pickFile(e.target.files?.[0])} />
              {screenshot ? (
                <div className="mt-2 flex items-center gap-2 bg-db-cream rounded-lg px-2 py-1.5">
                  <img src={screenshot.dataUrl} alt="" className="w-8 h-8 object-cover rounded" />
                  <span className="text-xs text-db-subtle truncate flex-1">{screenshot.name}</span>
                  <button onClick={() => setScreenshot(null)} className="text-gray-400 hover:text-red-600"><X className="w-3.5 h-3.5" /></button>
                </div>
              ) : (
                <button onClick={() => fileInput.current?.click()} className="mt-2 flex items-center gap-1.5 text-xs text-db-navy hover:underline">
                  <Paperclip className="w-3.5 h-3.5" /> Attach a screenshot or photo
                </button>
              )}
              {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
              <button
                onClick={submit}
                disabled={!message.trim() || sending}
                className="mt-3 w-full py-2 rounded-lg bg-db-navy text-white text-sm font-semibold hover:bg-db-navyLight disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {sending && <Loader2 className="w-4 h-4 animate-spin" />} Send
              </button>
            </>
          )}
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-db-navy text-white text-sm font-semibold shadow-lg hover:bg-db-navyLight"
        >
          <MessageSquare className="w-4 h-4" /> Feedback
        </button>
      )}
    </div>
  );
}
