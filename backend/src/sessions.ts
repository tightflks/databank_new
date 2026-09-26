import { randomBytes } from 'crypto';

// Sessions used to live only in an in-memory Map in auth.ts and users.ts — a Sep 25 security
// review pointed out that with ~87 commits/month, that means customers get logged out several
// times a week on every deploy. Persisting to the SQLite database already used for everything
// else fixes that: a redeploy restarts the process, but the sessions table survives on the
// mounted volume, so a session already handed to a browser keeps working across restarts.

type Db = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
};

let db_: Db | null = null;

export function initSessions(db: Db): void {
  if (db_) return; // already initialized (both auth.ts and users.ts call this; only do it once)
  db_ = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
  // Sweep anything already expired on startup, and periodically thereafter, so the table
  // doesn't grow forever with dead rows.
  const sweep = () => { try { db_!.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); } catch { /* ignore */ } };
  sweep();
  setInterval(sweep, 6 * 60 * 60 * 1000).unref();
}

// kind separates admin sessions from customer sessions sharing one table, so a token minted for
// one can never be replayed as the other even if the random values somehow collided.
export function createSession(kind: string, subject: string, ttlMs: number): string {
  const token = randomBytes(32).toString('hex');
  db_!.prepare('INSERT INTO sessions (token, kind, subject, expires_at) VALUES (?, ?, ?, ?)').run(token, kind, subject, Date.now() + ttlMs);
  return token;
}

// Returns the session's subject (whatever string identifies who it belongs to — an admin's
// name, or a user's numeric id as a string) if the token is valid and unexpired, else null.
export function getSession(kind: string, token: string): string | null {
  if (!db_) return null;
  const row = db_.prepare('SELECT subject, expires_at FROM sessions WHERE token = ? AND kind = ?').get(token, kind) as
    | { subject: string; expires_at: number }
    | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db_.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row.subject;
}

export function deleteSession(token: string): void {
  db_?.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
