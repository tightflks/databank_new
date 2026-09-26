import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Express, Request, Response } from 'express';
import { requireAdmin } from './auth';
import { dropboxConfigured, listFolder, uploadLarge, deletePath } from './dropbox';

// Nightly copy of the site's own SQLite database (accounts, sessions, feedback, photos, usage)
// to Dropbox. db.backup() takes a consistent snapshot while the site keeps running. The weekly
// files synced from Dropbox are dropped from the copy (they are re-fetched from Dropbox on
// restore, and made the first backup 570 MB); the copy is gzipped and the last KEEP_DAYS kept. Restore: download, gunzip, put it at
// $DATA_DIR/databank.db and redeploy.

export const BACKUP_ROOT = '/GrooveSolutions/Databank/_archive/_site_backups';
const KEEP_DAYS = 14;
const CHECK_MS = 60 * 60 * 1000; // look hourly; back up once per UTC day
const NAME = /^databank-(\d{4}-\d{2}-\d{2})\.db\.gz$/;

let last: { at: string; file: string; bytes: number } | { at: string; error: string } | null = null;

export async function backupDatabase(db: { backup: (dest: string) => Promise<unknown> }): Promise<{ file: string; bytes: number }> {
  const day = new Date().toISOString().slice(0, 10);
  const tmp = path.join(os.tmpdir(), `databank-backup-${process.pid}.db`);
  try {
    await db.backup(tmp);
    const copy = new Database(tmp);
    try {
      copy.exec("DELETE FROM excel_data WHERE upload_id IN (SELECT id FROM uploads WHERE filename LIKE 'dropbox:%')");
    } catch { /* no uploads tables (tests) */ }
    // Live sign-in and reset tokens don't belong in a file that sits in Dropbox; after a restore
    // everyone just signs in again.
    for (const table of ['sessions', 'email_tokens']) {
      try { copy.exec(`DELETE FROM ${table}`); } catch { /* table not there */ }
    }
    copy.exec('VACUUM');
    copy.close();
    await pipeline(fs.createReadStream(tmp), createGzip(), fs.createWriteStream(`${tmp}.gz`));
    const gz = fs.readFileSync(`${tmp}.gz`);
    const file = `${BACKUP_ROOT}/databank-${day}.db.gz`;
    await uploadLarge(file, gz);
    const old = (await listFolder(BACKUP_ROOT))
      .filter((e) => e['.tag'] === 'file' && NAME.test(e.name))
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(KEEP_DAYS);
    for (const e of old) await deletePath(e.path_lower);
    last = { at: new Date().toISOString(), file, bytes: gz.length };
    console.log(`✅ Database backup: ${file} (${(gz.length / 1e6).toFixed(1)} MB)`);
    return { file, bytes: gz.length };
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(`${tmp}.gz`, { force: true });
  }
}

async function backedUpToday(): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  try {
    return (await listFolder(BACKUP_ROOT)).some((e) => e.name === `databank-${day}.db.gz`);
  } catch {
    return false; // folder doesn't exist yet
  }
}

export function startBackups(db: { backup: (dest: string) => Promise<unknown> }): void {
  if (!dropboxConfigured() || process.env.DROPBOX_LOCAL_CSV_ROOT) return;
  const tick = async () => {
    try {
      if (!(await backedUpToday())) await backupDatabase(db);
    } catch (e) {
      last = { at: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) };
      console.error('Database backup failed:', last.error);
    }
  };
  setTimeout(tick, 5 * 60 * 1000); // shortly after a deploy, then hourly
  setInterval(tick, CHECK_MS);
}

export function registerBackupRoutes(app: Express, db: { backup: (dest: string) => Promise<unknown> }): void {
  app.get('/api/admin/backup', requireAdmin, (_req: Request, res: Response) => res.json({ last, folder: BACKUP_ROOT }));
  app.post('/api/admin/backup', requireAdmin, async (_req: Request, res: Response) => {
    if (!dropboxConfigured()) return res.status(400).json({ error: 'Dropbox is not configured' });
    try {
      res.json(await backupDatabase(db));
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : 'Backup failed' });
    }
  });
}
