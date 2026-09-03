import { useState, type FormEvent } from 'react';
import { Lock, X, Eye, ArrowRight } from 'lucide-react';

interface Props {
  onClose: () => void;
  onGuest: () => void;
}

// Customer accounts are not live yet: the form is a placeholder so the eventual flow is visible,
// and "Continue as guest" opens the public preview of the Research Database.
export default function LoginModal({ onClose, onGuest }: Props) {
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setNotice(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 sm:p-8 relative" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" className="absolute top-4 right-4 text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
        <div className="flex items-center gap-3 mb-1">
          <span className="w-10 h-10 rounded-lg bg-[#0b1f5c] text-white flex items-center justify-center"><Lock className="w-5 h-5" /></span>
          <h2 className="text-xl font-bold text-gray-900">Research Database</h2>
        </div>
        <p className="text-sm text-gray-500 mb-6">Sign in with your Databank account.</p>
        <form onSubmit={submit} className="space-y-3">
          <input type="email" required placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b1f5c]/40" />
          <input type="password" required placeholder="Password" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b1f5c]/40" />
          {notice && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Customer accounts are coming soon. Use the public preview below in the meantime, or call (404) 872-8880.
            </p>
          )}
          <button type="submit" className="w-full inline-flex items-center justify-center gap-2 bg-[#0b1f5c] text-white font-semibold px-5 py-2.5 rounded-lg hover:bg-[#122a7a]">
            Sign in <ArrowRight className="w-4 h-4" />
          </button>
        </form>
        <div className="flex items-center gap-3 my-5 text-xs text-gray-400"><span className="flex-1 border-t" />or<span className="flex-1 border-t" /></div>
        <button onClick={onGuest} className="w-full inline-flex items-center justify-center gap-2 border border-gray-300 text-gray-800 font-semibold px-5 py-2.5 rounded-lg hover:bg-gray-50">
          <Eye className="w-4 h-4" /> Continue as guest — public preview
        </button>
        <p className="text-xs text-gray-400 text-center mt-3">Preview access is open while customer accounts are being set up.</p>
      </div>
    </div>
  );
}
