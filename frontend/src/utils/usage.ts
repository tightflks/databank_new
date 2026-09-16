import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');
const VISITOR_KEY = 'databank.visitor';

// Anonymous per-browser id so the admin Usage tab can count visitors, not just hits.
export function visitorId(): string {
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    return 'anon';
  }
}

axios.defaults.headers.common['X-Databank-Visitor'] = visitorId();

export type UsageKind = 'page_view' | 'search' | 'ask' | 'export' | 'report' | 'pdf' | 'history';

export function trackUsage(kind: UsageKind, data: { database_type?: string; detail?: string; rows?: number } = {}) {
  axios.post(`${API_URL}/api/usage`, { kind, ...data }, { withCredentials: true }).catch(() => undefined);
}
