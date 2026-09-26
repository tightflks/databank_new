import { useState, type FormEvent } from 'react';
import axios from 'axios';
import { Lock, X, ArrowRight, Eye, EyeOff, Mail, CheckCircle2 } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

export interface AccountInfo {
  email: string;
  trialEndsAt: string;
  paidUntil: string | null;
  paidIndefinite: boolean;
  hasAccess: boolean;
  daysLeft: number | null;
  needsVerification?: boolean;
}

interface Props {
  onClose: () => void;
  onAuthed: (account: AccountInfo) => void;
  // Set when a previously logged-in session's trial has run out, so the modal opens straight
  // into a clear "trial ended" state instead of a blank sign-in form.
  trialEndedFor?: string | null;
  // Set when a signed-up-but-not-yet-verified account tries to search, so the modal opens
  // straight into the "check your email" state instead of a blank sign-in form.
  verifyPendingFor?: string | null;
  // Set when arriving from a password-reset email link (?resetToken=...), so the modal opens
  // straight into the "choose a new password" form instead of a login screen.
  resetToken?: string | null;
}

const input = 'w-full rounded-lg border border-db-borderStrong px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-db-navy/30';

type View = 'login' | 'signup' | 'verify-pending' | 'forgot' | 'forgot-sent' | 'reset' | 'reset-done';

// Self-serve accounts: the user picks their own password (mirrors the note from the Sep 24
// call about the old Becton-created accounts being hard to manage). Signing up starts a 30-day
// trial from that moment; there's no payment step here yet, matching the free-30-day rollout.
// A Sep 25 security review pointed out signup had nothing to confirm the signer actually
// controls the email address given — verification (view 'verify-pending') and password reset
// (views 'forgot' / 'reset') close that gap.
export default function LoginModal({ onClose, onAuthed, trialEndedFor, resetToken, verifyPendingFor }: Props) {
  const [view, setView] = useState<View>(resetToken ? 'reset' : verifyPendingFor ? 'verify-pending' : trialEndedFor ? 'login' : 'signup');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState(trialEndedFor ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingEmail, setPendingEmail] = useState(verifyPendingFor ?? '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const mode = view === 'signup' ? 'signup' : 'login';
      const body = mode === 'signup' ? { email, password, firstName, lastName, company } : { email, password };
      const { data } = await axios.post(`${API_URL}/api/account/${mode}`, body);
      if (data.needsVerification) {
        setPendingEmail(email);
        setView('verify-pending');
        return;
      }
      onAuthed({ email: data.email, trialEndsAt: data.trialEndsAt, paidUntil: data.paidUntil ?? null, paidIndefinite: Boolean(data.paidIndefinite), hasAccess: data.hasAccess ?? true, daysLeft: data.daysLeft ?? null });
    } catch (err: any) {
      setError(err.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const resendVerification = async () => {
    setLoading(true);
    try {
      await axios.post(`${API_URL}/api/account/resend-verification`);
    } finally {
      setLoading(false);
    }
  };

  const submitForgot = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await axios.post(`${API_URL}/api/account/forgot-password`, { email });
      setView('forgot-sent');
    } finally {
      setLoading(false);
    }
  };

  const submitReset = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await axios.post(`${API_URL}/api/account/reset-password`, { token: resetToken, password });
      setView('reset-done');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Could not reset your password. The link may have expired.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 font-sans" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 sm:p-8 relative max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" className="absolute top-4 right-4 text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
        <div className="flex items-center gap-3 mb-1">
          <span className="w-10 h-10 rounded-lg bg-db-navy text-white flex items-center justify-center"><Lock className="w-5 h-5" /></span>
          <h2 className="font-bold tracking-tight text-xl text-db-ink m-0">Research Database</h2>
        </div>

        {view === 'verify-pending' ? (
          <div className="pt-2">
            <div className="flex items-start gap-3 bg-db-tint rounded-xl p-4 mb-4">
              <Mail className="w-5 h-5 text-db-navy mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold text-db-ink m-0">Check your email</p>
                <p className="text-sm text-db-subtle mt-1">We sent a confirmation link to <b>{pendingEmail}</b>. Click it to activate your trial.</p>
              </div>
            </div>
            <button onClick={resendVerification} disabled={loading} className="text-sm font-semibold text-db-navy hover:underline disabled:opacity-60">
              {loading ? 'Sending…' : "Didn't get it? Resend the email"}
            </button>
          </div>
        ) : view === 'forgot' || view === 'forgot-sent' ? (
          <>
            <p className="text-sm text-db-muted mb-6">{view === 'forgot-sent' ? 'Check your email for a reset link.' : "Enter your email and we'll send you a reset link."}</p>
            {view === 'forgot-sent' ? (
              <div className="flex items-center gap-2 text-sm bg-db-tint rounded-lg px-3 py-2.5"><CheckCircle2 className="w-4 h-4 text-db-navy" /> If an account exists for {email}, a reset link is on its way.</div>
            ) : (
              <form onSubmit={submitForgot} className="space-y-3">
                <input type="email" required placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
                <button type="submit" disabled={loading} className="w-full inline-flex items-center justify-center gap-2 bg-db-navy text-white font-semibold px-5 py-2.5 rounded-lg hover:bg-db-navyLight disabled:opacity-60">
                  {loading ? 'Sending…' : 'Send reset link'}
                </button>
              </form>
            )}
            <p className="text-xs text-gray-400 text-center mt-4">
              <button onClick={() => setView('login')} className="text-db-navy font-semibold hover:underline">Back to sign in</button>
            </p>
          </>
        ) : view === 'reset' || view === 'reset-done' ? (
          <>
            <p className="text-sm text-db-muted mb-6">{view === 'reset-done' ? 'Your password has been reset.' : 'Choose a new password.'}</p>
            {view === 'reset-done' ? (
              <div className="flex items-center gap-2 text-sm bg-db-tint rounded-lg px-3 py-2.5 mb-3"><CheckCircle2 className="w-4 h-4 text-db-navy" /> You can sign in with your new password now.</div>
            ) : (
              <form onSubmit={submitReset} className="space-y-3">
                <div className="relative">
                  <input type={showPassword ? 'text' : 'password'} required minLength={8} placeholder="New password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} className={`${input} pr-9`} />
                  <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {error && <p className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
                <button type="submit" disabled={loading} className="w-full inline-flex items-center justify-center gap-2 bg-db-navy text-white font-semibold px-5 py-2.5 rounded-lg hover:bg-db-navyLight disabled:opacity-60">
                  {loading ? 'Please wait…' : 'Reset password'}
                </button>
              </form>
            )}
            {view === 'reset-done' && (
              <button onClick={() => setView('login')} className="w-full inline-flex items-center justify-center gap-2 bg-db-navy text-white font-semibold px-5 py-2.5 rounded-lg hover:bg-db-navyLight">
                Sign in <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </>
        ) : (
          <>
            {trialEndedFor ? (
              <p className="text-sm text-db-muted mb-6">Your 30-day trial has ended. Sign in and contact Databank at (404) 872-8880 to continue.</p>
            ) : (
              <p className="text-sm text-db-muted mb-6">{view === 'signup' ? 'Start your free 30-day trial. No credit card needed.' : 'Sign in with your Databank account.'}</p>
            )}
            <form onSubmit={submit} className="space-y-3">
              {view === 'signup' && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <input required placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} className={input} />
                    <input required placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} className={input} />
                  </div>
                  <input required placeholder="Company" value={company} onChange={(e) => setCompany(e.target.value)} className={input} />
                </>
              )}
              <input type="email" required placeholder={view === 'signup' ? 'Work email' : 'Email address'} value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={view === 'signup' ? 8 : undefined}
                  placeholder={view === 'signup' ? 'Create a password (8+ characters)' : 'Password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${input} pr-9`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {view === 'signup' && (
                <p className="text-xs text-db-muted -mt-1">
                  A work email gets you approved fastest. Using a personal address is fine too — we review new sign-ups and may call to confirm. We'll email you a link to confirm it's really you.
                </p>
              )}
              {view === 'login' && (
                <button type="button" onClick={() => setView('forgot')} className="text-xs text-db-navy hover:underline -mt-1">Forgot your password?</button>
              )}
              {error && (
                <p className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
              )}
              <button type="submit" disabled={loading} className="w-full inline-flex items-center justify-center gap-2 bg-db-navy text-white font-semibold px-5 py-2.5 rounded-lg hover:bg-db-navyLight disabled:opacity-60">
                {loading ? 'Please wait…' : view === 'signup' ? 'Start free trial' : 'Sign in'} <ArrowRight className="w-4 h-4" />
              </button>
            </form>
            <p className="text-xs text-gray-400 text-center mt-4">
              {view === 'signup' ? (
                <>Already have an account? <button onClick={() => { setView('login'); setError(null); }} className="text-db-navy font-semibold hover:underline">Sign in</button></>
              ) : (
                <>New here? <button onClick={() => { setView('signup'); setError(null); }} className="text-db-navy font-semibold hover:underline">Start a free trial</button></>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
