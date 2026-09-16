// Usage log: what customers actually do on the site. One row per event, kept server-side
// (no third-party analytics), read back on the admin Usage tab. Admin traffic is flagged so
// the customer numbers aren't inflated by us testing.
import type { Express, Request, Response } from 'express';
import { isAdmin, requireAdmin, rateLimit } from './auth';

type Db = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
};

export const USAGE_KINDS = [
  'page_view',   // detail = home | search | dashboard | help | history
  'search',      // detail = quick find text, rows = matches
  'ask',         // detail = Ask Databank question, rows = matches
  'export',      // detail = filename, rows = rows exported
  'report',      // detail = property name (one-page report opened)
  'pdf',         // detail = property | snapshot
  'history',     // detail = property name (Property History opened)
] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export type UsageEvent = {
  kind: UsageKind;
  databaseType?: string | null;
  detail?: string | null;
  rows?: number | null;
};

const VISITOR_HEADER = 'x-databank-visitor';

let insertStmt: ReturnType<Db['prepare']> | null = null;

export function initUsage(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      database_type TEXT,
      detail TEXT,
      rows INTEGER,
      visitor TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_date DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_events(created_date DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_kind ON usage_events(kind, created_date DESC);
  `);
  insertStmt = db.prepare(
    `INSERT INTO usage_events (kind, database_type, detail, rows, visitor, is_admin) VALUES (?, ?, ?, ?, ?, ?)`
  );
}

const clip = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

export function recordUsage(req: Request, ev: UsageEvent) {
  if (!insertStmt) return;
  try {
    const visitor = clip(req.headers[VISITOR_HEADER], 64);
    const rows = typeof ev.rows === 'number' && Number.isFinite(ev.rows) ? Math.max(0, Math.round(ev.rows)) : null;
    insertStmt.run(ev.kind, clip(ev.databaseType, 40), clip(ev.detail, 300), rows, visitor, isAdmin(req) ? 1 : 0);
  } catch (e) {
    console.error('usage log failed:', e instanceof Error ? e.message : e);
  }
}

type Count = { kind: string; n: number };
type DayRow = { day: string; visitors: number; events: number };
type TopRow = { detail: string; n: number };
type DbRow = { database_type: string; n: number };
type RecentRow = {
  id: number; kind: string; database_type: string | null; detail: string | null; rows: number | null;
  visitor: string | null; created_date: string;
};

export function registerUsageRoutes(app: Express, db: Db) {
  initUsage(db);

  // Browser-side events (page views, quick find, report/history opens). Server-side events
  // (exports, Ask Databank, PDFs) are recorded by their own routes.
  app.post('/api/usage', rateLimit(600, 'Too many events'), (req: Request, res: Response) => {
    const { kind, database_type, detail, rows } = (req.body || {}) as Record<string, unknown>;
    if (typeof kind !== 'string' || !(USAGE_KINDS as readonly string[]).includes(kind)) {
      return res.status(400).json({ error: 'unknown kind' });
    }
    recordUsage(req, {
      kind: kind as UsageKind,
      databaseType: typeof database_type === 'string' ? database_type : null,
      detail: typeof detail === 'string' ? detail : null,
      rows: typeof rows === 'number' ? rows : null,
    });
    res.json({ ok: true });
  });

  const since = (days: number) => `datetime('now', '-${Math.max(1, Math.min(365, Math.floor(days)))} days')`;

  app.get('/api/usage/summary', requireAdmin, (req: Request, res: Response) => {
    const days = Number(req.query.days) || 30;
    const includeAdmin = req.query.admin === '1';
    const who = includeAdmin ? '' : 'AND is_admin = 0';
    const where = `WHERE created_date >= ${since(days)} ${who}`;

    const byKind = db.prepare(`SELECT kind, COUNT(*) AS n FROM usage_events ${where} GROUP BY kind`).all() as Count[];
    const totals: Record<string, number> = {};
    for (const k of USAGE_KINDS) totals[k] = 0;
    for (const r of byKind) totals[r.kind] = r.n;

    const visitors = (db.prepare(
      `SELECT COUNT(DISTINCT visitor) AS n FROM usage_events ${where} AND visitor IS NOT NULL`
    ).get() as { n: number }).n;
    const exportedRows = (db.prepare(
      `SELECT COALESCE(SUM(rows), 0) AS n FROM usage_events ${where} AND kind = 'export'`
    ).get() as { n: number }).n;

    const byDay = db.prepare(
      `SELECT date(created_date) AS day, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS events
       FROM usage_events ${where} GROUP BY day ORDER BY day`
    ).all() as DayRow[];
    const byDatabase = db.prepare(
      `SELECT database_type, COUNT(*) AS n FROM usage_events ${where} AND database_type IS NOT NULL
       GROUP BY database_type ORDER BY n DESC`
    ).all() as DbRow[];
    const top = (kind: UsageKind, limit = 15) => db.prepare(
      `SELECT detail, COUNT(*) AS n FROM usage_events ${where} AND kind = ? AND detail IS NOT NULL
       GROUP BY lower(detail) ORDER BY n DESC, detail LIMIT ?`
    ).all(kind, limit) as TopRow[];
    const recent = db.prepare(
      `SELECT id, kind, database_type, detail, rows, visitor, created_date FROM usage_events ${where}
       ORDER BY created_date DESC, id DESC LIMIT 200`
    ).all() as RecentRow[];
    const firstEvent = (db.prepare(`SELECT MIN(created_date) AS d FROM usage_events`).get() as { d: string | null }).d;

    res.json({
      days, includeAdmin, firstEvent, visitors, exportedRows, totals, byDay, byDatabase,
      topSearches: top('search'), topQuestions: top('ask'), topProperties: top('report'), recent,
    });
  });
}
