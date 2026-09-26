import Database from 'better-sqlite3';
import { gunzipSync } from 'zlib';
import fs from 'fs';
import os from 'os';
import path from 'path';

const uploaded: Record<string, Buffer> = {};
const deleted: string[] = [];
jest.mock('./dropbox', () => ({
  dropboxConfigured: () => true,
  uploadLarge: async (p: string, b: Buffer) => { uploaded[p] = b; },
  deletePath: async (p: string) => { deleted.push(p); },
  listFolder: async () =>
    Array.from({ length: 16 }, (_, i) => ({ '.tag': 'file', name: `databank-2026-09-${String(i + 1).padStart(2, '0')}.db.gz`, path_lower: `/b/${i + 1}` })),
}));
import { backupDatabase } from './backup';

describe('backupDatabase', () => {
  it('uploads a restorable gzipped snapshot and keeps only the newest 14', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE users (email TEXT); INSERT INTO users VALUES ('a@b.com');
      CREATE TABLE uploads (id INTEGER, filename TEXT); INSERT INTO uploads VALUES (1, 'dropbox:APTS:2026-09-23:r1'), (2, 'hand-upload.xls');
      CREATE TABLE excel_data (upload_id INTEGER, data TEXT); INSERT INTO excel_data VALUES (1, 'weekly'), (2, 'manual');
      CREATE TABLE sessions (token TEXT); INSERT INTO sessions VALUES ('live-token');`);
    const { file } = await backupDatabase(db);
    expect(file).toMatch(/_site_backups\/databank-\d{4}-\d{2}-\d{2}\.db\.gz$/);

    const restored = path.join(os.tmpdir(), `restore-${process.pid}.db`);
    fs.writeFileSync(restored, gunzipSync(uploaded[file]));
    const back = new Database(restored);
    expect(back.prepare('SELECT email FROM users').all()).toEqual([{ email: 'a@b.com' }]);
    // Dropbox-synced weekly files are left out (re-fetched on restore); hand uploads are kept.
    expect(back.prepare('SELECT upload_id FROM excel_data').all()).toEqual([{ upload_id: 2 }]);
    expect(back.prepare('SELECT * FROM sessions').all()).toEqual([]); // no live sign-in tokens in Dropbox
    fs.rmSync(restored);

    expect(deleted).toEqual(['/b/2', '/b/1']); // the two oldest of 16
  });
});
