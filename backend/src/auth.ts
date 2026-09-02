import { randomBytes, timingSafeEqual } from 'crypto';
import type { Express, NextFunction, Request, Response } from 'express';

// Admin login: a single password from ADMIN_PASSWORD gates the Generate / History / Databases
// tabs and every write endpoint. Sessions are random tokens held in memory and in an HttpOnly
// cookie; a redeploy simply asks the admin to sign in again. The User View stays public.

const COOKIE = 'databank_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map<string, number>();

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function passwordMatches(given: string): boolean {
  const expected = process.env.ADMIN_PASSWORD ?? '';
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function adminConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
}

export function isAdmin(req: Request): boolean {
  const token = readCookie(req, COOKIE);
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!adminConfigured()) {
    return res.status(503).json({ error: 'Admin login is not configured. Set ADMIN_PASSWORD on the server.' });
  }
  if (!isAdmin(req)) return res.status(401).json({ error: 'Admin login required' });
  next();
}

const attempts = new Map<string, { n: number; until: number }>();

export function registerAuthRoutes(app: Express) {
  app.get('/api/auth/me', (req: Request, res: Response) => {
    res.json({ admin: isAdmin(req), configured: adminConfigured() });
  });

  app.post('/api/auth/login', (req: Request, res: Response) => {
    const ip = req.ip || 'unknown';
    const a = attempts.get(ip);
    if (a && a.n >= 5 && a.until > Date.now()) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!adminConfigured()) {
      return res.status(503).json({ error: 'Admin login is not configured. Set ADMIN_PASSWORD on the server.' });
    }
    if (!passwordMatches(password)) {
      attempts.set(ip, { n: (a && a.until > Date.now() ? a.n : 0) + 1, until: Date.now() + 10 * 60 * 1000 });
      return res.status(401).json({ error: 'Wrong password' });
    }
    attempts.delete(ip);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_MS);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MS / 1000}; SameSite=Lax${req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`,
    );
    res.json({ admin: true });
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    const token = readCookie(req, COOKIE);
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
    res.json({ admin: false });
  });
}

// Ask AI spends Anthropic credit on every call: cap requests per client IP per hour.
const askHits = new Map<string, number[]>();

export function rateLimit(maxPerHour: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isAdmin(req)) return next();
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const hits = (askHits.get(ip) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    if (hits.length >= maxPerHour) {
      res.setHeader('Retry-After', String(Math.ceil((hits[0] + 60 * 60 * 1000 - now) / 1000)));
      return res.status(429).json({ error: `Ask AI limit reached (${maxPerHour} questions an hour). Please try again later.` });
    }
    hits.push(now);
    askHits.set(ip, hits);
    next();
  };
}
