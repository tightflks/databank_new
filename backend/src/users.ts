import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { isAdmin, requireAdmin } from './auth';
import { sendWelcomeMail } from './mail';

// Customer accounts: self-serve signup (email + a password the user picks themselves — not
// something we generate and hand them, which is what made the old Becton accounts hard to
// manage), a 30-day trial window starting from each user's own signup date, and a session
// cookie separate from the admin one in auth.ts. No payment processing here — after the trial
// ends, requireUser below just stops serving data until an admin marks the account paid
// (extend/reactivate is a manual, admin-side action for now, since most customers here pay by
// check or ACH through an AP department rather than a card online).

type Db = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
};

type UserRow = {
  id: number;
  email: string;
  password_hash: string;
  salt: string;
  created_date: string;
  trial_ends_at: string;
  paid_until: string | null;
  disabled: number;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
};

type Session = { userId: number; email: string; trialEndsAt: number; paidUntil: number | null };

const COOKIE = 'databank_user';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // the browser session cookie can outlive the trial;
// requireUser is what actually decides access, on every request, from the live DB row.
const TRIAL_DAYS = 30;
const sessions = new Map<string, { token_exp: number; userId: number }>();

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function setSessionCookie(res: Response, req: Request, token: string) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MS / 1000}; SameSite=Lax${req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`,
  );
}

function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function passwordMatches(password: string, salt: string, hash: string): boolean {
  const given = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function userToSession(u: UserRow): Session {
  return {
    userId: u.id,
    email: u.email,
    trialEndsAt: new Date(u.trial_ends_at).getTime(),
    paidUntil: u.paid_until ? new Date(u.paid_until).getTime() : null,
  };
}

// Access is granted while the trial hasn't ended, OR while an admin has marked the account paid
// through (paid_until in the future, or null meaning "paid, no end date set").
function hasAccess(s: Session): boolean {
  const now = Date.now();
  if (s.paidUntil !== null) return s.paidUntil > now;
  return s.trialEndsAt > now;
}

function daysLeft(endMs: number): number {
  return Math.max(0, Math.ceil((endMs - Date.now()) / (24 * 60 * 60 * 1000)));
}

const attempts = new Map<string, { n: number; until: number }>();
function attemptLimited(ip: string): boolean {
  const a = attempts.get(ip);
  return Boolean(a && a.n >= 8 && a.until > Date.now());
}
function recordAttempt(ip: string, failed: boolean) {
  if (!failed) {
    attempts.delete(ip);
    return;
  }
  const a = attempts.get(ip);
  attempts.set(ip, { n: (a && a.until > Date.now() ? a.n : 0) + 1, until: Date.now() + 10 * 60 * 1000 });
}

let db_: Db | null = null;
const getUserByEmailStmt = () => db_!.prepare('SELECT * FROM users WHERE email = ?');
const getUserByIdStmt = () => db_!.prepare('SELECT * FROM users WHERE id = ?');
const insertUserStmt = () =>
  db_!.prepare('INSERT INTO users (email, password_hash, salt, trial_ends_at, first_name, last_name, company) VALUES (?, ?, ?, ?, ?, ?, ?)');

// Reads the live row on every gated request (not just at login) so an admin marking someone
// paid, or disabling an account, takes effect immediately rather than waiting for a new login.
export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (isAdmin(req)) return next(); // admin sessions always have full access
  if (!db_) return res.status(503).json({ error: 'Accounts are not set up yet.' });
  const token = readCookie(req, COOKIE);
  const s = token ? sessions.get(token) : undefined;
  if (!s) return res.status(401).json({ error: 'Please sign in to search Databank.' });
  const row = getUserByIdStmt().get(s.userId) as UserRow | undefined;
  if (!row || row.disabled) {
    sessions.delete(token!);
    return res.status(401).json({ error: 'Please sign in to search Databank.' });
  }
  const session = userToSession(row);
  if (!hasAccess(session)) {
    return res.status(402).json({
      error: 'Your 30-day trial has ended. Contact Databank to continue.',
      trialEndsAt: row.trial_ends_at,
    });
  }
  next();
}

export function usersConfigured(): boolean {
  return db_ !== null;
}

// For endpoints that stay open to logged-out visitors but should auto-attach the sender's
// email when one is available — feedback submissions, for instance ("once users have to log
// in, this happens automatically" per the written list). Never throws, never blocks.
export function currentUserEmail(req: Request): string | null {
  if (!db_) return null;
  const token = readCookie(req, COOKIE);
  const s = token ? sessions.get(token) : undefined;
  if (!s) return null;
  const row = getUserByIdStmt().get(s.userId) as UserRow | undefined;
  return row && !row.disabled ? row.email : null;
}

export function registerUserRoutes(app: Express, db: Db) {
  db_ = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      trial_ends_at DATETIME NOT NULL,
      paid_until DATETIME,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);
  // Added after the table already existed in production, so each is a separate migration
  // guarded against "column already exists" rather than part of the CREATE TABLE above.
  for (const col of ['first_name TEXT', 'last_name TEXT', 'company TEXT']) {
    try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch { /* already added */ }
  }

  app.post('/api/account/signup', (req: Request, res: Response) => {
    const ip = req.ip || 'unknown';
    if (attemptLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const firstName = typeof req.body?.firstName === 'string' ? req.body.firstName.trim().slice(0, 100) : null;
    const lastName = typeof req.body?.lastName === 'string' ? req.body.lastName.trim().slice(0, 100) : null;
    const company = typeof req.body?.company === 'string' ? req.body.company.trim().slice(0, 200) : null;
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (getUserByEmailStmt().get(email)) {
      recordAttempt(ip, true);
      return res.status(409).json({ error: 'An account with that email already exists. Try signing in instead.' });
    }
    const { salt, hash } = hashPassword(password);
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const result = insertUserStmt().run(email, hash, salt, trialEndsAt, firstName, lastName, company) as { lastInsertRowid: number };
    recordAttempt(ip, false);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { token_exp: Date.now() + SESSION_MS, userId: result.lastInsertRowid });
    setSessionCookie(res, req, token);
    res.json({ email, trialEndsAt, paidUntil: null, hasAccess: true, daysLeft: TRIAL_DAYS });
    sendWelcomeMail(email, firstName).catch((e) => console.error('Welcome email failed:', e instanceof Error ? e.message : e));
  });

  app.post('/api/account/login', (req: Request, res: Response) => {
    const ip = req.ip || 'unknown';
    if (attemptLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const row = getUserByEmailStmt().get(email) as UserRow | undefined;
    if (!row || row.disabled || !passwordMatches(password, row.salt, row.password_hash)) {
      recordAttempt(ip, true);
      return res.status(401).json({ error: 'Wrong email or password.' });
    }
    recordAttempt(ip, false);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { token_exp: Date.now() + SESSION_MS, userId: row.id });
    setSessionCookie(res, req, token);
    const s = userToSession(row);
    res.json({ email: row.email, trialEndsAt: row.trial_ends_at, paidUntil: row.paid_until, hasAccess: hasAccess(s), daysLeft: daysLeft(s.paidUntil ?? s.trialEndsAt) });
  });

  app.post('/api/account/logout', (req: Request, res: Response) => {
    const token = readCookie(req, COOKIE);
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
    res.json({ loggedIn: false });
  });

  app.get('/api/account/me', (req: Request, res: Response) => {
    const token = readCookie(req, COOKIE);
    const s = token ? sessions.get(token) : undefined;
    if (!s) return res.json({ loggedIn: false });
    const row = getUserByIdStmt().get(s.userId) as UserRow | undefined;
    if (!row || row.disabled) return res.json({ loggedIn: false });
    const session = userToSession(row);
    res.json({
      loggedIn: true,
      email: row.email,
      trialEndsAt: row.trial_ends_at,
      paidUntil: row.paid_until,
      hasAccess: hasAccess(session),
      daysLeft: daysLeft(session.paidUntil ?? session.trialEndsAt),
    });
  });

  // Admin: see who's signed up, who's currently active (trial or paid), and flip someone to
  // paid or disabled by hand — there's no payment processor wired in yet (most customers here
  // pay by check/ACH through an AP department), so this is how an admin actually grants access
  // once a payment comes in.
  const listUsersStmt = db.prepare('SELECT * FROM users ORDER BY created_date DESC');
  const setPaidStmt = db.prepare('UPDATE users SET paid_until = ? WHERE id = ?');
  const setDisabledStmt = db.prepare('UPDATE users SET disabled = ? WHERE id = ?');
  const updateUserStmt = db.prepare('UPDATE users SET first_name = ?, last_name = ?, company = ?, email = ? WHERE id = ?');

  app.get('/api/account/admin/users', requireAdmin, (_req: Request, res: Response) => {
    const rows = listUsersStmt.all() as UserRow[];
    const users = rows.map((row) => {
      const session = userToSession(row);
      return {
        id: row.id, email: row.email, firstName: row.first_name, lastName: row.last_name, company: row.company,
        createdDate: row.created_date, trialEndsAt: row.trial_ends_at, paidUntil: row.paid_until,
        disabled: Boolean(row.disabled), hasAccess: !row.disabled && hasAccess(session),
      };
    });
    res.json({ users, activeCount: users.filter((u) => u.hasAccess).length, totalCount: users.length });
  });

  // paidUntil: an ISO date string to grant access through, or null for "paid, no end date."
  // Sending neither (paidUntil: undefined isn't valid JSON, so send null explicitly) reverts
  // to trial-only access.
  app.post('/api/account/admin/users/:id/paid', requireAdmin, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const paidUntil = typeof req.body?.paidUntil === 'string' ? req.body.paidUntil : null;
    setPaidStmt.run(paidUntil, id);
    res.json({ ok: true, paidUntil });
  });

  app.post('/api/account/admin/users/:id/disabled', requireAdmin, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const disabled = req.body?.disabled ? 1 : 0;
    setDisabledStmt.run(disabled, id);
    res.json({ ok: true, disabled: Boolean(disabled) });
  });

  app.post('/api/account/admin/users/:id/edit', requireAdmin, (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    const clip = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
    const firstName = clip(req.body?.firstName, 100);
    const lastName = clip(req.body?.lastName, 100);
    const company = clip(req.body?.company, 200);
    const email = normalizeEmail(req.body?.email);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    try {
      updateUserStmt.run(firstName, lastName, company, email, id);
    } catch {
      return res.status(409).json({ error: 'Another account already uses that email.' });
    }
    res.json({ ok: true });
  });
}
