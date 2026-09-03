import { useEffect, useState } from 'react';
import axios from 'axios';
import { Camera, Check, Loader2, X } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

type Status = 'none' | 'pending' | 'approved' | 'rejected';

interface Props {
  name: string;
  address: string;
  city: string;
  zip: string;
  databaseType: string;
  admin: boolean;
}

// Customers see an approved Street View photo or a "coming soon" tile; admins see every fetched
// photo with Approve / Reject so nothing unverified reaches the public view.
export default function PropertyPhoto({ name, address, city, zip, databaseType, admin }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [key, setKey] = useState('');
  const [configured, setConfigured] = useState(true);
  const [panoDate, setPanoDate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!address) { setStatus('none'); return; }
    axios
      .get<{ key: string; status: Status; configured: boolean; panoDate: string | null }>(`${API_URL}/api/photos/status`, { params: { address, city, zip }, withCredentials: true })
      .then((r) => { setStatus(r.data.status); setKey(r.data.key); setConfigured(r.data.configured); setPanoDate(r.data.panoDate); })
      .catch(() => setStatus('none'));
  }, [address, city, zip, nonce]);

  const fetchPhoto = async () => {
    setBusy(true); setError(null);
    try {
      await axios.post(`${API_URL}/api/photos/fetch`, { name, address, city, zip, databaseType }, { withCredentials: true });
      setNonce((n) => n + 1);
    } catch (e) {
      setError(axios.isAxiosError(e) ? e.response?.data?.error || e.message : 'Could not fetch photo');
    } finally { setBusy(false); }
  };

  const review = async (s: 'approved' | 'rejected') => {
    setBusy(true); setError(null);
    try {
      await axios.post(`${API_URL}/api/photos/${key}/review`, { status: s }, { withCredentials: true });
      setStatus(s);
    } catch { setError('Could not save'); } finally { setBusy(false); }
  };

  if (status === null) return <div className="h-40 rounded-xl bg-gray-100 animate-pulse" />;

  const showImage = status === 'approved' || (admin && status !== 'none');

  if (!showImage) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 flex items-center gap-4 text-gray-500">
        <Camera className="w-8 h-8 shrink-0" />
        <div className="text-sm flex-1">
          <p className="font-semibold text-gray-700">Photo coming soon</p>
          <p>Property photos are being verified before they go live.</p>
        </div>
        {admin && configured && (
          <button onClick={fetchPhoto} disabled={busy} className="px-3 py-1.5 rounded-lg bg-[#0b1f5c] text-white text-sm font-semibold disabled:opacity-50 flex items-center gap-1">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />} Fetch Street View
          </button>
        )}
        {admin && !configured && <span className="text-xs">GOOGLE_MAPS_API_KEY not set</span>}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    );
  }

  return (
    <div className="rounded-xl overflow-hidden border border-gray-200">
      <img src={`${API_URL}/api/photos/${key}/image`} alt={name} className="w-full h-56 sm:h-72 object-cover" />
      {admin && (
        <div className="flex items-center gap-3 px-4 py-2 bg-gray-50 text-sm">
          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${status === 'approved' ? 'bg-green-100 text-green-800' : status === 'rejected' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>
            {status === 'approved' ? 'Live for customers' : status === 'rejected' ? 'Rejected — hidden' : 'Pending review — admin only'}
          </span>
          {panoDate && <span className="text-gray-500">Street View {panoDate}</span>}
          <span className="flex-1" />
          {status !== 'approved' && (
            <button onClick={() => review('approved')} disabled={busy} className="px-3 py-1 rounded-lg bg-green-600 text-white font-semibold flex items-center gap-1 disabled:opacity-50"><Check className="w-4 h-4" /> Approve</button>
          )}
          {status !== 'rejected' && (
            <button onClick={() => review('rejected')} disabled={busy} className="px-3 py-1 rounded-lg bg-white border border-gray-300 text-gray-700 font-semibold flex items-center gap-1 disabled:opacity-50"><X className="w-4 h-4" /> Reject</button>
          )}
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      )}
    </div>
  );
}
