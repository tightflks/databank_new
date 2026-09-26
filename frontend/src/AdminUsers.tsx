import { useEffect, useState } from 'react';
import axios from 'axios';
import { Loader2, Users, CheckCircle2, XCircle, Ban, RotateCcw, Pencil, Check, X } from 'lucide-react';

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
  paidIndefinite: boolean;
  disabled: boolean;
  hasAccess: boolean;
}

export default function AdminUsers() {
  const [users, setUsers] = useState<AccountUser[] | null>(null);
  const [activeCount, setActiveCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ firstName: '', lastName: '', company: '', email: '' });
  const [editError, setEditError] = useState<string | null>(null);

  const startEdit = (u: AccountUser) => {
    setEditingId(u.id);
    setEditError(null);
    setEditForm({ firstName: u.firstName ?? '', lastName: u.lastName ?? '', company: u.company ?? '', email: u.email });
  };

  const saveEdit = async (u: AccountUser) => {
    setBusy(u.id);
    setEditError(null);
    try {
      await axios.post(`${API_URL}/api/account/admin/users/${u.id}/edit`, editForm);
      setEditingId(null);
      await load();
    } catch (e: unknown) {
      setEditError(axios.isAxiosError(e) ? e.response?.data?.error || 'Could not save.' : 'Could not save.');
    } finally {
      setBusy(null);
    }
  };

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
    const input = window.prompt(`Grant ${u.email} access through what date? (YYYY-MM-DD)\n\nLeave blank and click OK for "paid, no end date."`, '');
    if (input === null) return;
    setBusy(u.id);
    try {
      if (input.trim() === '') {
        await axios.post(`${API_URL}/api/account/admin/users/${u.id}/paid`, { indefinite: true });
      } else if (Number.isNaN(new Date(input.trim()).getTime())) {
        alert(`"${input}" isn't a date I can understand. Try YYYY-MM-DD, e.g. 2027-01-01.`);
        return;
      } else {
        await axios.post(`${API_URL}/api/account/admin/users/${u.id}/paid`, { paidUntil: input.trim() });
      }
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
                  {editingId === u.id ? (
                    <>
                      <td className="py-2 pr-3">
                        <div className="flex gap-1">
                          <input value={editForm.firstName} onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))} placeholder="First" className="w-20 text-xs border border-gray-300 rounded px-1.5 py-1" />
                          <input value={editForm.lastName} onChange={(e) => setEditForm((f) => ({ ...f, lastName: e.target.value }))} placeholder="Last" className="w-20 text-xs border border-gray-300 rounded px-1.5 py-1" />
                        </div>
                        <input value={editForm.company} onChange={(e) => setEditForm((f) => ({ ...f, company: e.target.value }))} placeholder="Company" className="mt-1 w-full text-xs border border-gray-300 rounded px-1.5 py-1" />
                      </td>
                      <td className="py-2 pr-3">
                        <input value={editForm.email} onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))} placeholder="Email" className="w-full text-xs border border-gray-300 rounded px-1.5 py-1" />
                        {editError && <p className="text-[10px] text-red-600 mt-1">{editError}</p>}
                      </td>
                      <td className="py-2 pr-3 text-gray-500">{new Date(u.createdDate + (u.createdDate.endsWith('Z') ? '' : 'Z')).toLocaleDateString()}</td>
                      <td className="py-2 pr-3">
                        {u.disabled ? (
                          <span className="inline-flex items-center gap-1 text-gray-500"><Ban className="w-3.5 h-3.5" /> Disabled</span>
                        ) : u.hasAccess ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> {u.paidIndefinite || u.paidUntil !== null ? 'Paid' : 'Trial'}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-red-600"><XCircle className="w-3.5 h-3.5" /> Expired</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex gap-2">
                          <button disabled={busy === u.id} onClick={() => saveEdit(u)} className="text-xs font-semibold text-emerald-700 hover:underline disabled:opacity-50 flex items-center gap-0.5">
                            {busy === u.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save
                          </button>
                          <button disabled={busy === u.id} onClick={() => setEditingId(null)} className="text-xs font-semibold text-gray-500 hover:underline disabled:opacity-50 flex items-center gap-0.5">
                            <X className="w-3 h-3" /> Cancel
                          </button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
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
                          <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> {u.paidIndefinite || u.paidUntil !== null ? 'Paid' : 'Trial'}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-red-600"><XCircle className="w-3.5 h-3.5" /> Expired</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex gap-2 flex-wrap">
                          <button disabled={busy === u.id} onClick={() => startEdit(u)} className="text-xs font-semibold text-gray-600 hover:underline disabled:opacity-50 flex items-center gap-0.5"><Pencil className="w-3 h-3" /> Edit</button>
                          <button disabled={busy === u.id} onClick={() => markPaid(u)} className="text-xs font-semibold text-blue-600 hover:underline disabled:opacity-50">Mark paid…</button>
                          {(u.paidIndefinite || u.paidUntil !== null) && (
                            <button disabled={busy === u.id} onClick={() => revokePaid(u)} title="Back to trial-only access" className="text-xs font-semibold text-gray-500 hover:underline disabled:opacity-50 flex items-center gap-0.5"><RotateCcw className="w-3 h-3" /> Revert</button>
                          )}
                          <button disabled={busy === u.id} onClick={() => toggleDisabled(u)} className="text-xs font-semibold text-red-600 hover:underline disabled:opacity-50">
                            {u.disabled ? 'Enable' : 'Disable'}
                          </button>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
