import { createHash } from 'crypto';
import type { Express, Request, Response } from 'express';
import { isAdmin, requireAdmin } from './auth';
import { DATABASES, latestSheet } from './dropbox';

// Property photos come from Google Street View. Every fetched image starts as "pending" and is
// visible only on /admin; a customer sees it only once an admin has marked it approved.

type Db = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
};

export type PhotoStatus = 'pending' | 'approved' | 'rejected';

type PhotoRow = {
  key: string;
  name: string;
  address: string;
  city: string;
  zip: string;
  database_type: string;
  status: PhotoStatus;
  image: Buffer | null;
  pano_date: string | null;
  created_date: string;
  reviewed_date: string | null;
};

const SIZE = '640x400';
const MAP_SIZE = '640x400';

export function photosConfigured(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function photoKey(address: string, city: string, zip: string): string {
  return createHash('sha1').update(`${norm(address)}|${norm(city)}|${norm(zip)}`).digest('hex').slice(0, 20);
}

function location(address: string, city: string, zip: string): string {
  return [address, city, 'GA', zip].filter(Boolean).join(', ');
}

export async function fetchStreetView(address: string, city: string, zip: string): Promise<{ image: Buffer; date: string | null } | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY is not set');
  const loc = encodeURIComponent(location(address, city, zip));
  const meta = (await (await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${loc}&source=outdoor&key=${key}`)).json()) as {
    status: string;
    date?: string;
    error_message?: string;
  };
  if (meta.status === 'ZERO_RESULTS' || meta.status === 'NOT_FOUND') return null;
  if (meta.status !== 'OK') throw new Error(meta.error_message || `Street View: ${meta.status}`);
  const img = await fetch(`https://maps.googleapis.com/maps/api/streetview?size=${SIZE}&location=${loc}&source=outdoor&fov=80&key=${key}`);
  if (!img.ok) throw new Error(`Street View image: HTTP ${img.status}`);
  return { image: Buffer.from(await img.arrayBuffer()), date: meta.date ?? null };
}

// A small pinned map of the property, for the customer-facing PDF report. No approval workflow
// needed here (unlike Street View) — it's just a map, nothing that could show the wrong scene.
// Cached in memory per address for the life of the process; a property's location never changes.
const mapCache = new Map<string, Buffer | null>();
export async function fetchStaticMap(address: string, city: string, zip: string): Promise<Buffer | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const cacheKey = photoKey(address, city, zip);
  if (mapCache.has(cacheKey)) return mapCache.get(cacheKey) ?? null;
  const loc = encodeURIComponent(location(address, city, zip));
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${loc}&zoom=15&size=${MAP_SIZE}&scale=2&markers=color:0x1e3a8a%7C${loc}&key=${key}`;
  const img = await fetch(url);
  // The Static Maps API returns a 200 with a small PNG error graphic (not JSON) for bad
  // requests/billing issues; a real map tile image is always well over a few KB.
  const buf = img.ok ? Buffer.from(await img.arrayBuffer()) : null;
  const result = buf && buf.length > 2000 ? buf : null;
  mapCache.set(cacheKey, result);
  return result;
}

// The customer-facing PDF report: only ever the currently-approved shot for this address,
// same rule as the public /api/photos/status endpoint. Returns null if there's no photo yet,
// or the one on file hasn't been approved.
const reportPhotoStmt = (db: Db) => db.prepare('SELECT image, status FROM property_photos WHERE key = ?');
export function getApprovedPhoto(db: Db, address: string, city: string, zip: string): Buffer | null {
  const row = reportPhotoStmt(db).get(photoKey(address, city, zip)) as { image: Buffer | null; status: PhotoStatus } | undefined;
  return row?.image && row.status === 'approved' ? row.image : null;
}

// Fire-and-forget: if this address has never had a Street View shot attempted, fetch and queue
// it as 'pending' for admin review, so photos gradually fill in as customers view reports —
// without ever showing an unapproved photo to a customer in the meantime. Never throws.
const queuedCheckStmt = (db: Db) => db.prepare('SELECT 1 FROM property_photos WHERE key = ?');
const queuedInsertStmt = (db: Db) =>
  db.prepare(
    'INSERT INTO property_photos (key, name, address, city, zip, database_type, status, image, pano_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING'
  );
export function queuePhotoIfMissing(db: Db, p: { name: string; address: string; city: string; zip: string; databaseType: string }): void {
  if (!photosConfigured() || !p.address) return;
  const key = photoKey(p.address, p.city, p.zip);
  if (queuedCheckStmt(db).get(key)) return;
  fetchStreetView(p.address, p.city, p.zip)
    .then((shot) => {
      queuedInsertStmt(db).run(key, p.name, p.address, p.city, p.zip, p.databaseType, shot ? 'pending' : 'rejected', shot?.image ?? null, shot?.date ?? null);
    })
    .catch((e) => console.error('queuePhotoIfMissing failed:', e instanceof Error ? e.message : e));
}

export function registerPhotoRoutes(app: Express, db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS property_photos (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      zip TEXT NOT NULL,
      database_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      image BLOB,
      pano_date TEXT,
      created_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_date DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_photo_status ON property_photos(status);
  `);

  const getStmt = db.prepare('SELECT * FROM property_photos WHERE key = ?');
  const listStmt = db.prepare(
    'SELECT key, name, address, city, zip, database_type, status, pano_date, created_date, reviewed_date, image IS NOT NULL AS has_image FROM property_photos WHERE (? = \'all\' OR status = ?) ORDER BY created_date DESC LIMIT 500'
  );
  const countStmt = db.prepare('SELECT status, COUNT(*) AS n FROM property_photos GROUP BY status');
  const upsertStmt = db.prepare(`
    INSERT INTO property_photos (key, name, address, city, zip, database_type, status, image, pano_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET image = excluded.image, pano_date = excluded.pano_date, name = excluded.name
  `);
  const reviewStmt = db.prepare("UPDATE property_photos SET status = ?, reviewed_date = CURRENT_TIMESTAMP WHERE key = ?");
  const deleteStmt = db.prepare('DELETE FROM property_photos WHERE key = ?');

  const keyFromQuery = (req: Request) => {
    const q = req.query as Record<string, string | undefined>;
    const address = (q.address ?? '').trim();
    const city = (q.city ?? '').trim();
    const zip = (q.zip ?? '').trim();
    return { address, city, zip, key: photoKey(address, city, zip) };
  };

  async function fetchAndStore(p: { name: string; address: string; city: string; zip: string; databaseType: string }): Promise<PhotoStatus | 'none'> {
    const key = photoKey(p.address, p.city, p.zip);
    const existing = getStmt.get(key) as PhotoRow | undefined;
    if (existing?.image) return existing.status;
    const shot = await fetchStreetView(p.address, p.city, p.zip);
    if (!shot) {
      upsertStmt.run(key, p.name, p.address, p.city, p.zip, p.databaseType, 'rejected', null, null);
      return 'none';
    }
    upsertStmt.run(key, p.name, p.address, p.city, p.zip, p.databaseType, existing?.status ?? 'pending', shot.image, shot.date);
    return existing?.status ?? 'pending';
  }

  // Public: what a customer may show for this address. Only approved photos leak their status.
  app.get('/api/photos/status', (req: Request, res: Response) => {
    const { key, address } = keyFromQuery(req);
    if (!address) return res.status(400).json({ error: 'address required' });
    const row = getStmt.get(key) as PhotoRow | undefined;
    const admin = isAdmin(req);
    const status: PhotoStatus | 'none' = row?.image ? row.status : 'none';
    res.json({
      key,
      status: admin ? status : status === 'approved' ? 'approved' : 'none',
      configured: photosConfigured(),
      panoDate: admin ? row?.pano_date ?? null : null,
    });
  });

  app.get('/api/photos/:key/image', (req: Request, res: Response) => {
    const row = getStmt.get(req.params.key) as PhotoRow | undefined;
    if (!row?.image || (row.status !== 'approved' && !isAdmin(req))) return res.status(404).end();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', row.status === 'approved' ? 'public, max-age=86400' : 'private, no-store');
    res.send(row.image);
  });

  // Admin: fetch one property's Street View shot (idempotent).
  app.post('/api/photos/fetch', requireAdmin, async (req: Request, res: Response) => {
    if (!photosConfigured()) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY is not set on the server.' });
    const b = req.body as Record<string, unknown>;
    const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
    const p = { name: s('name'), address: s('address'), city: s('city'), zip: s('zip'), databaseType: s('databaseType') || 'apartments' };
    if (!p.address) return res.status(400).json({ error: 'address required' });
    try {
      const status = await fetchAndStore(p);
      res.json({ key: photoKey(p.address, p.city, p.zip), status });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Admin: fetch every property in a database that has no photo yet (bounded per call).
  app.post('/api/photos/fetch-all/:databaseId', requireAdmin, async (req: Request, res: Response) => {
    if (!photosConfigured()) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY is not set on the server.' });
    const dbInfo = DATABASES.find((d) => d.id === req.params.databaseId);
    if (!dbInfo) return res.status(404).json({ error: 'Unknown database' });
    const limit = Math.min(Number((req.body as { limit?: unknown })?.limit) || 200, 1000);
    try {
      const sheet = await latestSheet(dbInfo.id);
      if (!sheet) return res.status(404).json({ error: 'No weekly file for this database yet' });
      const cols = (sheet.data[0] as string[]).map((c) => String(c ?? '').trim().toUpperCase());
      const idx = (n: string) => cols.indexOf(n);
      const [iName, iNum, iStreet, iCity, iZip] = ['P NAME', 'P STREET NUMBER', 'P STREET NAME', 'P CITY', 'P ZIP'].map(idx);
      let fetched = 0, missing = 0, skipped = 0, errors = 0;
      for (const row of sheet.data.slice(1)) {
        if (fetched + missing >= limit) break;
        const cell = (i: number) => (i >= 0 ? String(row[i] ?? '').trim() : '');
        const address = `${cell(iNum)} ${cell(iStreet)}`.trim();
        if (!address || !cell(iName)) { skipped++; continue; }
        const key = photoKey(address, cell(iCity), cell(iZip));
        if (getStmt.get(key)) { skipped++; continue; }
        try {
          const r = await fetchAndStore({ name: cell(iName), address, city: cell(iCity), zip: cell(iZip), databaseType: dbInfo.id });
          if (r === 'none') missing++; else fetched++;
        } catch (e) {
          errors++;
          console.error('Street View fetch failed:', e instanceof Error ? e.message : e);
          if (errors >= 5) break;
        }
      }
      res.json({ fetched, missing, skipped, errors, remaining: Math.max(0, sheet.data.length - 1 - skipped - fetched - missing) });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/photos', requireAdmin, (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const counts: Record<string, number> = {};
    for (const c of countStmt.all() as { status: string; n: number }[]) counts[c.status] = c.n;
    res.json({ counts, items: listStmt.all(status, status) });
  });

  app.post('/api/photos/:key/review', requireAdmin, (req: Request, res: Response) => {
    const status = (req.body as { status?: unknown })?.status;
    if (status !== 'approved' && status !== 'rejected' && status !== 'pending') return res.status(400).json({ error: 'status must be approved, rejected or pending' });
    reviewStmt.run(status, req.params.key);
    res.json({ key: req.params.key, status });
  });

  app.delete('/api/photos/:key', requireAdmin, (req: Request, res: Response) => {
    deleteStmt.run(req.params.key);
    res.json({ ok: true });
  });
}
