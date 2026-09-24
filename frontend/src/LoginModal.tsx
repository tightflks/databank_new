import { useState, type FormEvent } from 'react';
import axios from 'axios';
import { Lock, X, ArrowRight } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

export interface AccountInfo {
  email: string;
  trialEndsAt: string;
  paidUntil: string | null;
  hasAccess: boolean;
  daysLeft: number;
}

interface Props {
  onClose: () => void;
  onAuthed: (account: AccountInfo) => void;
  // Set when a previously logged-in session's trial has run out, so the modal opens straight
  // into a clear "trial ended" state instead of a blank sign-in form.
  trialEndedFor?: string | null;
}

// Self-serve accounts: the user picks their own password (mirrors the note from the Sep 24
// call about the old Becton-created accounts being hard to manage). Signing up starts a 30-day
// trial from that moment; there's no payment step here yet, matching the free-30-day rollout.
export default function LoginModal({ onClose, onAuthed, trialEndedFor }: Props) {
  const [mode, setMode] = useState<'login' | 'signup'>(trialEndedFor ? 'login' : 'signup');
  const [email, setEmail] = useState(trialEndedFor ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { data } = await axios.post(`${API_URL}/api/account/${mode}`, { email, password });
      onAuthed({ email: data.email, trialEndsAt: data.trialEndsAt, paidUntil: data.paidUntil ?? null, hasAccess: data.hasAccess ?? true, daysLeft: data.daysLeft });
    } catch (err: any) {
      setError(err.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 sm:p-8 relative" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" className="absolute top-4 right-4 text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
        <div className="flex items-center gap-3 mb-1">
          <span className="w-10 h-10 rounded-lg bg-[#0b1f5c] text-white flex items-center justify-center"><Lock className="w-5 h-5" /></span>
          <h2 className="text-xl font-bold text-gray-900">Research Database</h2>
        </div>
        {trialEndedFor ? (
          <p className="text-sm text-gray-500 mb-6">Your 30-day trial has ended. Sign in and contact Databank at (404) 872-8880 to continue.</p>
        ) : (
          <p className="text-sm text-gray-500 mb-6">{mode === 'signup' ? 'Start your free 30-day trial.' : 'Sign in with your Databank account.'}</p>
        )}
        <form onSubmit={submit} className="space-y-3">
          <input type="email" required placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b1f5c]/40" />
          <input type="password" required minLength={mode === 'signup' ? 8 : undefined} placeholder={mode === 'signup' ? 'Create a password (8+ characters)' : 'Password'} value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b1f5c]/40" />
          {error && (
            <p className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}
          <button type="submit" disabled={loading} className="w-full inline-flex items-center justify-center gap-2 bg-[#0b1f5c] text-white font-semibold px-5 py-2.5 rounded-lg hover:bg-[#122a7a] disabled:opacity-60">
            {loading ? 'Please wait…' : mode === 'signup' ? 'Start free trial' : 'Sign in'} <ArrowRight className="w-4 h-4" />
          </button>
        </form>
        <p className="text-xs text-gray-400 text-center mt-4">
          {mode === 'signup' ? (
            <>Already have an account? <button onClick={() => { setMode('login'); setError(null); }} className="text-[#0b1f5c] font-semibold hover:underline">Sign in</button></>
          ) : (
            <>New here? <button onClick={() => { setMode('signup'); setError(null); }} className="text-[#0b1f5c] font-semibold hover:underline">Start a free trial</button></>
          )}
        </p>
      </div>
    </div>
  );
}
