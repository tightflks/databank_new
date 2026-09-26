import { timingSafeEqual } from 'crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { initSessions, createSession, getSession, deleteSession } from './sessions';

// Admin login: each admin has their own password rather than one shared one, so a login can be
// traced to a person and a departing admin's access can be revoked without changing everyone
// else's password. Configured via ADMIN_PASSWORDS="tareq:pw1,blake:pw2,stephanie:pw3" (comma-
// separated name:password pairs). ADMIN_PASSWORD (singular, the old single shared password)
// still works as a fallback, logged in as "admin", for anyone who hasn't set the new variable.
// Sessions persist in the sessions table (see sessions.ts) rather than only in memory, so a
// redeploy doesn't sign everyone out. The User View stays public.

const COOKIE = 'databank_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function parseAdmins(): Map<string, string> {
  const admins = new Map<string, string>();
  const list = process.env.ADMIN_PASSWORDS ?? '';
  for (const pair of list.split(',')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const pw = pair.slice(idx + 1).trim();
    if (name && pw) admins.set(name, pw);
  }
  if (admins.size === 0 && process.env.ADMIN_PASSWORD) admins.set('admin', process.env.ADMIN_PASSWORD);
  return admins;
}

function timingSafeStrEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// Finds which configured admin's password this is, if any (case-insensitive on the name isn't
// needed here since we're matching by password, not name).
function matchAdmin(given: string): string | null {
  for (const [name, pw] of parseAdmins()) {
    if (timingSafeStrEqual(given, pw)) return name;
  }
  return null;
}

export function adminConfigured(): boolean {
  return parseAdmins().size > 0;
}

export function isAdmin(req: Request): boolean {
  return Boolean(adminName(req));
}

// The name of the admin behind this session, or null if not logged in / expired.
export function adminName(req: Request): string | null {
  const token = readCookie(req, COOKIE);
  return token ? getSession('admin', token) : null;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!adminConfigured()) {
    return res.status(503).json({ error: 'Admin login is not configured. Set ADMIN_PASSWORDS on the server.' });
  }
  if (!isAdmin(req)) return res.status(401).json({ error: 'Admin login required' });
  next();
}

const attempts = new Map<string, { n: number; until: number }>();

type Db = Parameters<typeof initSessions>[0];

export function registerAuthRoutes(app: Express, db: Db) {
  initSessions(db);

  app.get('/api/auth/me', (req: Request, res: Response) => {
    res.json({ admin: isAdmin(req), name: adminName(req), configured: adminConfigured() });
  });

  app.post('/api/auth/login', (req: Request, res: Response) => {
    const ip = req.ip || 'unknown';
    const a = attempts.get(ip);
    if (a && a.n >= 5 && a.until > Date.now()) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!adminConfigured()) {
      return res.status(503).json({ error: 'Admin login is not configured. Set ADMIN_PASSWORDS on the server.' });
    }
    const name = matchAdmin(password);
    if (!name) {
      attempts.set(ip, { n: (a && a.until > Date.now() ? a.n : 0) + 1, until: Date.now() + 10 * 60 * 1000 });
      return res.status(401).json({ error: 'Wrong password' });
    }
    attempts.delete(ip);
    const token = createSession('admin', name, SESSION_MS);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MS / 1000}; SameSite=Lax${req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`,
    );
    res.json({ admin: true, name });
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    const token = readCookie(req, COOKIE);
    if (token) deleteSession(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
    res.json({ admin: false });
  });
}

// Cap requests per client IP per hour (Ask AI spends Anthropic credit on every call; exports and
// feedback are cheap but open). Each middleware instance keeps its own bucket.
export function rateLimit(maxPerHour: number, what = 'Ask AI limit reached ({n} questions an hour)') {
  const hitsByIp = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    if (isAdmin(req)) return next();
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const hits = (hitsByIp.get(ip) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    if (hits.length >= maxPerHour) {
      res.setHeader('Retry-After', String(Math.ceil((hits[0] + 60 * 60 * 1000 - now) / 1000)));
      return res.status(429).json({ error: `${what.replace('{n}', String(maxPerHour))}. Please try again later.` });
    }
    hits.push(now);
    hitsByIp.set(ip, hits);
    next();
  };
}
