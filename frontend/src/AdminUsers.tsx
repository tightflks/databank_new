import { useEffect, useState } from 'react';
import axios from 'axios';
import { Loader2, Users, CheckCircle2, XCircle, Ban, RotateCcw } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

interface AccountUser {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  createdDate: string;
  trialEndsAt: string;
  paidUntil: string | null;
  disabled: boolean;
  hasAccess: boolean;
}

export default function AdminUsers() {
  const [users, setUsers] = useState<AccountUser[] | null>(null);
  const [activeCount, setActiveCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = async () => {
    try {
      const r = await axios.get(`${API_URL}/api/account/admin/users`);
      setUsers(r.data.users);
      setActiveCount(r.data.activeCount);
    } catch {
      setError('Could not load users.');
    }
  };
  useEffect(() => { load(); }, []);

  const markPaid = async (u: AccountUser) => {
    const input = window.prompt(`Grant ${u.email} access through what date? (YYYY-MM-DD, or leave blank for "paid, no end date")`, '');
    if (input === null) return;
    setBusy(u.id);
    try {
      await axios.post(`${API_URL}/api/account/admin/users/${u.id}/paid`, { paidUntil: input.trim() || null });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const revokePaid = async (u: AccountUser) => {
    setBusy(u.id);
    try {
      await axios.post(`${API_URL}/api/account/admin/users/${u.id}/paid`, { paidUntil: null });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const toggleDisabled = async (u: AccountUser) => {
    setBusy(u.id);
    try {
      await axios.post(`${API_URL}/api/account/admin/users/${u.id}/disabled`, { disabled: !u.disabled });
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-xl p-8">
      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-800 mb-1">Users</h2>
          <p className="text-gray-600 text-sm">Everyone who's signed up, newest first.</p>
        </div>
        {users && (
          <div className="flex gap-3">
            <div className="bg-emerald-50 text-emerald-800 rounded-xl px-4 py-2 text-center">
              <div className="text-xl font-bold">{activeCount}</div>
              <div className="text-xs">active now</div>
            </div>
            <div className="bg-gray-50 text-gray-700 rounded-xl px-4 py-2 text-center">
              <div className="text-xl font-bold">{users.length}</div>
              <div className="text-xs">total signups</div>
            </div>
          </div>
        )}
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      {users === null ? (
        <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>
      ) : users.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <Users className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          No signups yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-3">Name / company</th>
                <th className="py-2 pr-3">Email</th>
                <th className="py-2 pr-3">Signed up</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id} className={u.disabled ? 'opacity-50' : ''}>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-gray-900">{[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}</div>
                    <div className="text-xs text-gray-500">{u.company || ''}</div>
                  </td>
                  <td className="py-2 pr-3">{u.email}</td>
                  <td className="py-2 pr-3 text-gray-500">{new Date(u.createdDate + (u.createdDate.endsWith('Z') ? '' : 'Z')).toLocaleDateString()}</td>
                  <td className="py-2 pr-3">
                    {u.disabled ? (
                      <span className="inline-flex items-center gap-1 text-gray-500"><Ban className="w-3.5 h-3.5" /> Disabled</span>
                    ) : u.hasAccess ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> {u.paidUntil !== null ? 'Paid' : 'Trial'}</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-red-600"><XCircle className="w-3.5 h-3.5" /> Expired</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex gap-2">
                      <button disabled={busy === u.id} onClick={() => markPaid(u)} className="text-xs font-semibold text-blue-600 hover:underline disabled:opacity-50">Mark paid…</button>
                      {u.paidUntil !== null && (
                        <button disabled={busy === u.id} onClick={() => revokePaid(u)} title="Back to trial-only access" className="text-xs font-semibold text-gray-500 hover:underline disabled:opacity-50 flex items-center gap-0.5"><RotateCcw className="w-3 h-3" /> Revert</button>
                      )}
                      <button disabled={busy === u.id} onClick={() => toggleDisabled(u)} className="text-xs font-semibold text-red-600 hover:underline disabled:opacity-50">
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                    </div>
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
