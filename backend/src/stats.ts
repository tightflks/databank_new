import type { Express, Request, Response } from 'express';
import { DATABASES, latestSheet } from './dropbox';

type Cell = string | number | null;

type Db = {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
};

export type PublicStats = {
  week: string | null;
  totalProperties: number;
  thisWeek: { count: number; volume: number; biggest: { name: string; city: string; price: number; type: string } | null };
  quarters: { label: string; volume: number; count: number }[];
  featured: { key: string; name: string; city: string; type: string }[];
};

const MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function toDate(v: Cell): Date | null {
  if (typeof v !== 'string') return null;
  const m = MDY.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return isNaN(d.getTime()) ? null : d;
}

function num(v: Cell): number {
  return typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[^0-9.]/g, '')) || 0 : 0;
}

function quarterLabel(d: Date): string {
  return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
}

export function computeStats(
  sheets: { type: string; week: string; data: Cell[][] }[],
  featured: { key: string; name: string; city: string; type: string }[]
): PublicStats {
  let total = 0;
  let week: string | null = null;
  let weekCount = 0;
  let weekVolume = 0;
  let biggest: PublicStats['thisWeek']['biggest'] = null;
  const q = new Map<string, { volume: number; count: number; t: number }>();
  const now = new Date();
  const cutoff = new Date(now.getFullYear() - 2, now.getMonth(), 1);

  for (const s of sheets) {
    if (!week || s.week > week) week = s.week;
    const [header, ...rows] = s.data;
    const col = (...names: string[]) => {
      for (const n of names) {
        const i = header.findIndex((h) => String(h).trim().toUpperCase() === n);
        if (i >= 0) return i;
      }
      return -1;
    };
    const cName = col('P NAME', 'PROPERTY NAME', 'NAME');
    const cCity = col('P CITY', 'CITY');
    const cIns = col('INSIDER DATE');
    const cPrice = col('SALE PRICE', 'LAND SALE PRICE');
    const cDate = col('SALE DATE', 'LAND SALE DATE');
    total += rows.length;

    let latest: Date | null = null;
    for (const r of rows) {
      const d = toDate(r[cIns]);
      if (d && (!latest || d > latest)) latest = d;
    }
    for (const r of rows) {
      const price = num(r[cPrice]);
      const ins = toDate(r[cIns]);
      if (latest && ins && ins.getTime() === latest.getTime()) {
        weekCount++;
        weekVolume += price;
        if (price > 0 && (!biggest || price > biggest.price)) {
          biggest = { name: String(r[cName] ?? '').split('/')[0].trim(), city: String(r[cCity] ?? ''), price, type: s.type };
        }
      }
      const sd = toDate(r[cDate]);
      if (sd && sd >= cutoff && sd <= now && price > 0) {
        const label = quarterLabel(sd);
        const cur = q.get(label) ?? { volume: 0, count: 0, t: sd.getFullYear() * 4 + Math.floor(sd.getMonth() / 3) };
        cur.volume += price;
        cur.count++;
        q.set(label, cur);
      }
    }
  }

  const quarters = [...q.entries()]
    .sort((a, b) => a[1].t - b[1].t)
    .slice(-8)
    .map(([label, v]) => ({ label, volume: v.volume, count: v.count }));

  return { week, totalProperties: total, thisWeek: { count: weekCount, volume: weekVolume, biggest }, quarters, featured };
}

let cache: { at: number; value: PublicStats } | null = null;
const TTL = 60 * 60 * 1000;

export function registerStatsRoutes(app: Express, db: Db) {
  const featuredStmt = db.prepare(
    "SELECT key, name, city, database_type AS type FROM property_photos WHERE status = 'approved' AND image IS NOT NULL ORDER BY reviewed_date DESC LIMIT 3"
  );

  app.get('/api/public/stats', async (_req: Request, res: Response) => {
    try {
      if (!cache || Date.now() - cache.at > TTL) {
        const uniqueDbs = DATABASES.filter((d, i) => DATABASES.findIndex((x) => x.type === d.type) === i);
        const sheets = (await Promise.all(uniqueDbs.map((d) => latestSheet(d.id).catch(() => null)))).filter(
          (s): s is NonNullable<typeof s> => s !== null
        );
        const featured = featuredStmt.all() as PublicStats['featured'];
        cache = { at: Date.now(), value: computeStats(sheets, featured) };
      }
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.json(cache.value);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'stats failed' });
    }
  });
}
