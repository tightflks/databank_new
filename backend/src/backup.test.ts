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
    db.exec("CREATE TABLE users (email TEXT); INSERT INTO users VALUES ('a@b.com')");
    const { file } = await backupDatabase(db);
    expect(file).toMatch(/_site_backups\/databank-\d{4}-\d{2}-\d{2}\.db\.gz$/);

    const restored = path.join(os.tmpdir(), `restore-${process.pid}.db`);
    fs.writeFileSync(restored, gunzipSync(uploaded[file]));
    expect(new Database(restored).prepare('SELECT email FROM users').all()).toEqual([{ email: 'a@b.com' }]);
    fs.rmSync(restored);

    expect(deleted).toEqual(['/b/2', '/b/1']); // the two oldest of 16
  });
});
