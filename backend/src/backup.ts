import { gzipSync } from 'zlib';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Express, Request, Response } from 'express';
import { requireAdmin } from './auth';
import { dropboxConfigured, listFolder, uploadLarge, deletePath } from './dropbox';

// Nightly copy of the site's own SQLite database (accounts, sessions, feedback, photos, usage)
// to Dropbox. db.backup() takes a consistent snapshot while the site keeps running; the copy
// is gzipped and the last KEEP_DAYS are kept. Restore: download, gunzip, put it at
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
    const gz = gzipSync(fs.readFileSync(tmp));
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
