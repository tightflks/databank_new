import { Express, Request, Response } from 'express';
import { requireUser } from '../users';
import { rateLimit } from '../auth';
import {
  Cell, Property, SearchParams, EMPTY_PARAMS, SOURCE_HEADER,
  buildProperties, filterProperties, insiderStats, topOwners, resultStats, newThisWeek,
} from './core';

// Customers buy five reports; the Franchise file is sold inside Retail, so the Retail tab is the
// office-and-shopping file with the Franchise records merged in (same as the search screen did).
const MERGED_INTO: Record<string, string[]> = { retail: ['franchise'] };
const DATABASES = ['apartments', 'industrial', 'land', 'offices', 'retail'];
const PAGE_MAX = 100;
// Browsing stops after this many results: narrow the search to see more. Keeps one account from
// paging through a whole database; exports have their own cap and rate limit.
export const BROWSE_MAX = 1000;
export const EXPORT_MAX = 1000;

type Upload = { id: number; original_filename: string };
export type SearchDeps = {
  latestUpload: (databaseType: string) => Upload | null;
  uploadData: (uploadId: number) => Cell[][]; // header row first, sensitive columns already removed
};

type Dataset = { sig: string; name: string; headers: string[]; properties: Property[]; meta: object };
const cache = new Map<string, Dataset>();

const alpha = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' });
const tally = (props: Property[], key: string, blank?: string) => {
  const m = new Map<string, number>();
  for (const p of props) { const k = String(p[key] || '').trim() || blank; if (k) m.set(k, (m.get(k) || 0) + 1); }
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
};

function dataset(deps: SearchDeps, databaseType: string): Dataset | null {
  const sources = [databaseType, ...(MERGED_INTO[databaseType] || [])]
    .map((db) => ({ db, upload: deps.latestUpload(db) }))
    .filter((s): s is { db: string; upload: Upload } => s.upload !== null);
  if (!sources.length) return null;
  const sig = sources.map((s) => s.upload.id).join(',');
  const hit = cache.get(databaseType);
  if (hit && hit.sig === sig) return hit;

  const files = sources.map((s) => ({ db: s.db, data: deps.uploadData(s.upload.id) })).filter((f) => f.data.length > 1);
  if (!files.length) return null;
  // Files name a few columns differently, so merged rows are re-laid onto the union of the headers,
  // each tagged with the file it came from.
  const headers: string[] = files.length > 1 ? [SOURCE_HEADER] : [];
  for (const f of files) for (const h of f.data[0]) { const t = String(h ?? '').trim(); if (t && !headers.some((x) => x.trim().toUpperCase() === t.toUpperCase())) headers.push(t); }
  const sourceLabel = (db: string) => db.charAt(0).toUpperCase() + db.slice(1);
  const rows: Cell[][] = files.flatMap((f) => {
    const pos = f.data[0].map((h) => headers.findIndex((x) => x.trim().toUpperCase() === String(h ?? '').trim().toUpperCase()));
    return f.data.slice(1).map((r) => {
      const out: Cell[] = new Array(headers.length).fill('');
      if (files.length > 1) out[0] = sourceLabel(f.db);
      pos.forEach((p, i) => { if (p >= 0) out[p] = r[i]; });
      return out;
    });
  });
  const properties = buildProperties(headers, rows, databaseType);

  const uniq = (key: string) => ([...new Set(properties.map((p) => p[key]).filter(Boolean))] as string[]).sort(alpha);
  const prices = properties.map((p) => parseFloat(p.salePrice?.replace(/[^0-9.-]/g, '') || '0')).filter((n) => n > 0);
  const units = properties.map((p) => parseInt(p.units?.replace(/[^0-9]/g, '') || '0')).filter((n) => n > 0);
  const meta = {
    latestUploadName: sources.map((s) => s.upload.original_filename).join(', '),
    headers,
    total: properties.length,
    filters: {
      cities: uniq('city'), counties: uniq('county'), marketAreas: uniq('marketArea'),
      dates: ([...new Set(properties.map((p) => p.insiderDate).filter(Boolean))] as string[]).sort((a, b) => new Date(b).getTime() - new Date(a).getTime()),
      priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : { min: 0, max: 0 },
      unitsRange: units.length ? { min: Math.min(...units), max: Math.max(...units) } : { min: 0, max: 0 },
    },
    insider: insiderStats(properties),
    newThisWeek: newThisWeek(properties),
    // Dashboard lists ("Unknown" buckets as the screen showed them) and the snapshot PDF's tallies.
    tallies: {
      county: tally(properties, 'county', 'Unknown'), zip: tally(properties, 'zip', 'Unknown'), insiderDate: tally(properties, 'insiderDate'),
      countyNamed: tally(properties, 'county'), zipNamed: tally(properties, 'zip'), city: tally(properties, 'city'),
    },
  };
  const ds = { sig, name: meta.latestUploadName, headers, properties, meta };
  cache.set(databaseType, ds);
  return ds;
}

function params(body: unknown): SearchParams {
  const b = (body && typeof body === 'object' ? (body as { params?: unknown }).params : null) ?? {};
  const out: SearchParams = { ...EMPTY_PARAMS };
  for (const k of Object.keys(EMPTY_PARAMS) as (keyof SearchParams)[]) {
    const v = (b as Record<string, unknown>)[k];
    if (v === undefined || v === null) continue;
    if (k === 'selectedCounties') out[k] = Array.isArray(v) ? v.map(String) : [];
    else if (k === 'aiFields' || k === 'aiRanges') out[k] = typeof v === 'object' ? (v as never) : {};
    else if (k === 'sort') out[k] = typeof v === 'object' ? (v as never) : null;
    else (out as Record<string, unknown>)[k] = String(v);
  }
  return out;
}

export function registerSearchRoutes(app: Express, deps: SearchDeps): void {
  const dbParam = (req: Request, res: Response): string | null => {
    const db = String(req.params.db || '').toLowerCase();
    if (!DATABASES.includes(db)) { res.status(404).json({ error: 'Unknown database' }); return null; }
    return db;
  };

  app.get('/api/search/:db/meta', requireUser, (req: Request, res: Response) => {
    const db = dbParam(req, res); if (!db) return;
    const ds = dataset(deps, db);
    res.json(ds ? ds.meta : { total: 0, headers: [], latestUploadName: '' });
  });

  app.post('/api/search/:db', requireUser, rateLimit(1200, 'Search limit reached ({n} searches an hour)'), (req: Request, res: Response) => {
    const db = dbParam(req, res); if (!db) return;
    const ds = dataset(deps, db);
    if (!ds) return res.json({ total: 0, rows: [], partial: false, browseMax: BROWSE_MAX });
    const offset = Math.max(0, Math.min(Number(req.body?.offset) || 0, BROWSE_MAX));
    const limit = Math.max(1, Math.min(Number(req.body?.limit) || PAGE_MAX, PAGE_MAX, BROWSE_MAX - offset));
    const { rows, partial } = filterProperties(ds.properties, ds.headers, params(req.body));
    res.json({
      total: rows.length,
      partial,
      rows: offset < BROWSE_MAX ? rows.slice(offset, offset + limit) : [],
      browseMax: BROWSE_MAX,
      stats: offset === 0 ? resultStats(rows, db) : undefined,
      topOwners: offset === 0 ? topOwners(rows) : undefined,
    });
  });

  // Rows for an Excel export of the current search, capped; the browser formats and posts them
  // to /api/export/xlsx as before.
  app.post('/api/search/:db/export', requireUser, rateLimit(30, 'Export limit reached ({n} an hour)'), (req: Request, res: Response) => {
    const db = dbParam(req, res); if (!db) return;
    const ds = dataset(deps, db);
    if (!ds) return res.json({ total: 0, rows: [], capped: false });
    const { rows } = filterProperties(ds.properties, ds.headers, params(req.body));
    res.json({ total: rows.length, rows: rows.slice(0, EXPORT_MAX), capped: rows.length > EXPORT_MAX, max: EXPORT_MAX });
  });
}
