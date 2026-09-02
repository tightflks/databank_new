import { gunzipSync } from 'zlib';
import nodePath from 'path';
import { existsSync, readFileSync } from 'fs';
import { Express, Request, Response } from 'express';

// Property Search over the Dropbox archive. The weekly Reflex zips in
// _archive/_datafile are converted to CSV by the sync job in the tareq-dashboard
// repo (tools/rxd/dropbox_sync.py) and written to _archive/_csv/<week>/<TYPE>.csv;
// tools/rxd/history.py folds those weeks into one record per property at
// _archive/_csv/history/<TYPE>.json.gz. This module reads both straight from
// Dropbox, so nothing is uploaded here.
//
// Needs DROPBOX_APP_KEY + DROPBOX_APP_SECRET + DROPBOX_REFRESH_TOKEN.

export const CSV_ROOT = '/GrooveSolutions/Databank/_archive/_csv';
const TTL_MS = 10 * 60 * 1000;
const PAGE = 50;

// Same six databases as the Databases page. OFFSHOP is Reflex's office-and-shopping
// file, so it feeds both Offices and Retail.
export const DATABASES: { id: string; label: string; type: string; note?: string }[] = [
  { id: 'apartments', label: 'Apartments', type: 'APTS' },
  { id: 'franchise', label: 'Franchise', type: 'FRANCHIS' },
  { id: 'industrial', label: 'Industrial', type: 'IND' },
  { id: 'land', label: 'Land', type: 'LANDSALE' },
  { id: 'offices', label: 'Offices', type: 'OFFSHOP', note: 'OFFSHOP.csv covers office and shopping — shared with Retail' },
  { id: 'retail', label: 'Retail', type: 'OFFSHOP', note: 'OFFSHOP.csv covers office and shopping — shared with Offices' },
];

// ---------- Dropbox ----------

async function accessToken(): Promise<string> {
  const key = process.env.DROPBOX_APP_KEY;
  const secret = process.env.DROPBOX_APP_SECRET;
  const refresh = process.env.DROPBOX_REFRESH_TOKEN;
  if (!key || !secret || !refresh) {
    throw new Error('Dropbox is not configured (DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN)');
  }
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: key, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`Dropbox token refresh failed (${res.status})`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

// Returns null when the path does not exist (Dropbox answers 409).
// DROPBOX_LOCAL_CSV_ROOT (dev only) serves a local copy of _archive/_csv instead.
async function download(path: string): Promise<globalThis.Response | null> {
  const local = process.env.DROPBOX_LOCAL_CSV_ROOT;
  if (local) {
    if (!path.startsWith(CSV_ROOT + '/')) return null;
    const file = nodePath.join(local, ...path.slice(CSV_ROOT.length + 1).split('/'));
    if (!existsSync(file)) return null;
    return new globalThis.Response(readFileSync(file));
  }
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Dropbox-API-Arg': JSON.stringify({ path }) },
  });
  if (res.status === 409) return null;
  if (!res.ok) throw new Error(`Dropbox download failed (${res.status})`);
  return res;
}

// RFC 4180-ish parser: quoted fields, doubled quotes, newlines inside quotes.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; rows.push(row); row = [];
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------- Summary: what the sync has written ----------

type ManifestWeek = { zip: string; size: number; synced_at: string; files: Record<string, number>; error?: string };
type Manifest = { weeks: Record<string, ManifestWeek> };

let summaryCache: { at: number; data: object } | null = null;

async function summary() {
  if (summaryCache && Date.now() - summaryCache.at < TTL_MS) return summaryCache.data;
  const res = await download(`${CSV_ROOT}/manifest.json`);
  const m: Manifest = res ? ((await res.json()) as Manifest) : { weeks: {} };
  // Weeks whose zip could not be read carry no files; they are not "synced".
  const weeks = Object.keys(m.weeks).filter((w) => Object.keys(m.weeks[w].files).length > 0).sort();
  const databases = DATABASES.map((d) => {
    const have = weeks.filter((w) => d.type in m.weeks[w].files);
    const last = have.length ? have[have.length - 1] : null;
    return {
      ...d,
      latestWeek: last,
      rows: last ? m.weeks[last].files[d.type] : null,
      weeks: have.length,
      firstWeek: have.length ? have[0] : null,
      path: last ? `${CSV_ROOT}/${last}/${d.type}.csv` : null,
    };
  });
  const data = {
    fetchedAt: new Date().toISOString(),
    weeks: weeks.length,
    firstWeek: weeks.length ? weeks[0] : null,
    latestWeek: weeks.length ? weeks[weeks.length - 1] : null,
    databases,
    all: [...weeks].reverse().map((w) => ({ week: w, ...m.weeks[w] })),
  };
  summaryCache = { at: Date.now(), data };
  return data;
}

// ---------- Rows: one CSV, one week ----------

// Any CSV the sync wrote for that week (APTS, APTS2, IND3…): a bare upper-case name, so no path tricks.
const FILE = /^[A-Z0-9]{1,16}$/;
const WEEK = /^\d{4}-\d{2}-\d{2}$/;

type Parsed = { at: number; columns: string[]; rows: string[][] };
const rowsCache = new Map<string, Parsed>();

async function loadRows(type: string, week: string): Promise<Parsed> {
  const key = `${week}/${type}`;
  const hit = rowsCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const res = await download(`${CSV_ROOT}/${week}/${type}.csv`);
  if (!res) throw new Error(`${type}.csv for ${week} is not in Dropbox`);
  const all = parseCsv(await res.text());
  const header = (all[0] ?? []).map((h) => h.trim());
  const body = all
    .slice(1)
    .map((r) => header.map((_, i) => (r[i] ?? '').trim()))
    // Reflex pads the database with empty and half-typed records; a real one has several fields.
    .filter((r) => r.filter((v) => v).length >= 3);
  const used = header.map((_, i) => body.some((r) => r[i]));
  const parsed = {
    at: Date.now(),
    columns: header.filter((_, i) => used[i]),
    rows: body.map((r) => r.filter((_, i) => used[i])),
  };
  rowsCache.set(key, parsed);
  return parsed;
}

// ---------- Latest week as an Excel-shaped sheet (feeds the uploads table) ----------

export function dropboxConfigured(): boolean {
  return !!(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET && process.env.DROPBOX_REFRESH_TOKEN);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUMBER = /^-?\d+(\.\d+)?$/;

// Same cell types sheet_to_json(header: 1) yields for the hand-exported .xls: numbers as numbers,
// dates as MM/DD/YYYY strings, blanks as null.
export function excelCell(v: string): string | number | null {
  if (v === '') return null;
  const d = ISO_DATE.exec(v);
  if (d) return `${d[2]}/${d[3]}/${d[1]}`;
  if (NUMBER.test(v)) return Number(v);
  return v;
}

export type LatestSheet = { week: string; type: string; file: string; data: (string | number | null)[][] };

export async function latestSheet(databaseId: string): Promise<LatestSheet | null> {
  const db = DATABASES.find((d) => d.id === databaseId);
  if (!db) throw new Error(`Unknown database "${databaseId}"`);
  const s = (await summary()) as { databases: { id: string; latestWeek: string | null }[] };
  const week = s.databases.find((d) => d.id === databaseId)?.latestWeek;
  if (!week) return null;
  const { columns, rows } = await loadRows(db.type, week);
  return {
    week,
    type: db.type,
    file: `${db.type}.csv`,
    data: [columns, ...rows.map((r) => r.map(excelCell))],
  };
}

// ---------- Properties: one record per property with its history ----------

const TYPE = /^[A-Z]{1,16}$/;
const ID = /^[A-Z]{1,16}-\d{1,6}$/;

export type DbxEvent = [string, string, string, string]; // [week, field, from, to]; field "*" = removed/restored

type Stored = {
  id: string;
  name: string;
  address: string;
  city: string;
  county: string;
  parcel: string;
  first: string;
  last: string;
  seen: number;
  removed: boolean;
  current: Record<string, string>;
  events: DbxEvent[];
};
type History = { type: string; generated: string | null; weeks: string[]; fields: string[]; properties: Stored[] };

type Summary = {
  id: string; name: string; address: string; city: string; county: string; parcel: string;
  first: string; last: string; seen: number; removed: boolean;
  owner: string; saleDate: string; salePrice: string; size: string;
  changes: number; sales: number; owners: number;
};
type Loaded = { at: number; hist: History; summaries: Summary[]; haystack: string[]; words: string[]; byId: Map<string, Stored> };
const histCache = new Map<string, Loaded>();

const SALE_FIELDS = new Set(['SALE DATE', 'SALE PRICE', 'TAX OWNER', 'OWNER']);

// Punctuation-free lowercase, so "Cassville-White Rd" and "cassville white" meet.
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function summarize(p: Stored): Summary {
  const c = p.current;
  const size = c['UNITS COMPLETED:'] ? `${c['UNITS COMPLETED:']} units` : c['# SQ FT BUILT'] ? `${c['# SQ FT BUILT']} SF` : c['# ACRES'] ? `${c['# ACRES']} ac` : '';
  return {
    id: p.id, name: p.name, address: p.address, city: p.city, county: p.county, parcel: p.parcel,
    first: p.first, last: p.last, seen: p.seen, removed: p.removed,
    owner: c['TAX OWNER'] ?? c['OWNER'] ?? '',
    saleDate: c['SALE DATE'] ?? '',
    salePrice: c['SALE PRICE'] ?? '',
    size,
    changes: p.events.filter((e) => e[1] !== '*').length,
    sales: p.events.filter((e) => e[1] === 'SALE DATE' && e[3]).length + (c['SALE DATE'] ? 1 : 0),
    owners: new Set(p.events.filter((e) => e[1] === 'TAX OWNER').flatMap((e) => [e[2], e[3]]).concat(c['TAX OWNER'] ?? []).filter(Boolean)).size,
  };
}

async function loadHistory(type: string): Promise<Loaded> {
  const hit = histCache.get(type);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const res = await download(`${CSV_ROOT}/history/${type}.json.gz`);
  if (!res) throw new Error(`No property history for ${type} yet — run tools/rxd/history.py --upload`);
  const hist = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf-8')) as History;
  const summaries = hist.properties.map(summarize);
  const haystack = hist.properties.map((p) =>
    [p.name, p.address, p.city, p.county, p.parcel, p.current['P ZIP'], p.current['TAX OWNER'], p.current['OWNER'], p.current['SELLER\\FORECLOSEE'], p.current['SELLER'],
      ...p.events.filter((e) => SALE_FIELDS.has(e[1])).map((e) => e[2])]
      .filter(Boolean)
      .join(' | ')
      .toLowerCase(),
  );
  const loaded = { at: Date.now(), hist, summaries, haystack, words: haystack.map(norm), byId: new Map(hist.properties.map((p) => [p.id, p])) };
  histCache.set(type, loaded);
  return loaded;
}

// ---------- Ask: history questions ----------
//
// Questions Ask AI routes here when they need more than one week of data.
// Every answer is built from the fold in history/<TYPE>.json.gz.

export const ASK_QUESTIONS = [
  'property_history', // who owned / bought / sold X, sale history, what changed on X
  'entity_history',   // everything a company or person bought or sold, over time
  'repeat_sales',     // properties that sold more than once
  'changes',          // properties whose record changed (optionally one field) in a period
  'new',              // properties that first appeared in a period
  'removed',          // properties that dropped off the list in a period
  'top_buyers',       // who bought the most properties in a period
  'top_sellers',      // who sold the most properties in a period
] as const;
export type AskQuestion = (typeof ASK_QUESTIONS)[number];

export type AskParams = {
  type: string;
  question: AskQuestion;
  subject?: string; // property name / address / parcel (property_history)
  entity?: string;  // company or person (entity_history)
  field?: string;   // restrict `changes` to one field, e.g. "SALE PRICE"
  after?: string;   // ISO week bounds, inclusive
  before?: string;
  area?: string;    // city / county / zip / market-area text, narrows any question
  limit?: number;
};

type Trail = { week: string; value: string }[];
type Sale = { week: string; date: string; price: string; seller: string; buyer: string };
type AskItem = Summary & {
  ownerTrail: Trail;
  saleList: Sale[];
  events: DbxEvent[];
  role?: string; // entity_history: "owner" | "seller" | "owner, seller"
};

const OWNER_FIELD = 'TAX OWNER';
const SELLER_FIELDS = ['SELLER\\FORECLOSEE', 'SELLER'];
const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

function trailOf(p: Stored, field: string): Trail {
  const evs = p.events.filter((e) => e[1] === field);
  const out: Trail = [];
  if (evs.length) out.push({ week: p.first, value: evs[0][2] });
  else if (p.current[field]) out.push({ week: p.first, value: p.current[field] });
  for (const e of evs) out.push({ week: e[0], value: e[3] });
  return out.filter((x, i, a) => x.value && (i === 0 || x.value !== a[i - 1].value));
}

// One entry per distinct SALE DATE the record has carried, with the price,
// seller and owner the record showed in that same week.
function salesOf(p: Stored): Sale[] {
  const at = (field: string, week: string): string => {
    // value of `field` as of `week`: last change at or before that week, else the initial value
    const evs = p.events.filter((e) => e[1] === field);
    let v = evs.length ? evs[0][2] : p.current[field] ?? '';
    for (const e of evs) if (e[0] <= week) v = e[3];
    return v;
  };
  const sellerField = SELLER_FIELDS.find((f) => f in p.current || p.events.some((e) => e[1] === f)) ?? SELLER_FIELDS[0];
  const has = (f: string) => !!p.current[f] || p.events.some((e) => e[1] === f);
  const land = !has('SALE DATE') && has('LAND SALE DATE');
  const dateField = land ? 'LAND SALE DATE' : 'SALE DATE';
  const priceField = land ? 'LAND SALE PRICE' : 'SALE PRICE';
  // the record can flip back to an earlier date (numbered-copy weeks); keep the first sighting of each date
  const seen = new Set<string>();
  const dates = trailOf(p, dateField).filter((d) => !seen.has(d.value) && seen.add(d.value));
  return dates.map((d) => ({
    week: d.week,
    date: d.value,
    price: at(priceField, d.week),
    seller: at(sellerField, d.week),
    buyer: at(OWNER_FIELD, d.week) || at('OWNER', d.week),
  }));
}

function item(p: Stored): AskItem {
  return { ...summarize(p), ownerTrail: trailOf(p, OWNER_FIELD), saleList: salesOf(p), events: p.events };
}

function inRange(week: string, after?: string, before?: string): boolean {
  return (!after || week >= after) && (!before || week <= before);
}

export async function ask(params: AskParams): Promise<Record<string, unknown>> {
  const { type, question } = params;
  const after = params.after && WEEK_RE.test(params.after) ? params.after : undefined;
  const before = params.before && WEEK_RE.test(params.before) ? params.before : undefined;
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 200);
  const { hist, words } = await loadHistory(type);
  const props = hist.properties;

  const areaTerms = norm(params.area ?? '').split(' ').filter(Boolean);
  const inArea = (i: number) => areaTerms.every((t) => words[i].includes(t));
  const base = { type, question, weeks: hist.weeks.length, firstWeek: hist.weeks[0] ?? null, latestWeek: hist.weeks[hist.weeks.length - 1] ?? null, after: after ?? null, before: before ?? null };

  if (question === 'property_history') {
    const terms = norm(params.subject ?? '').split(' ').filter(Boolean);
    if (!terms.length) return { ...base, total: 0, items: [], note: 'Say which property (name, address or parcel).' };
    const hits: Stored[] = [];
    for (let i = 0; i < props.length && hits.length < limit; i++) {
      if (terms.every((t) => words[i].includes(t)) && inArea(i)) hits.push(props[i]);
    }
    return { ...base, subject: params.subject, total: hits.length, items: hits.map(item) };
  }

  if (question === 'entity_history') {
    const needle = norm(params.entity ?? '');
    if (!needle) return { ...base, total: 0, items: [], note: 'Say which company or person.' };
    const items: AskItem[] = [];
    for (let i = 0; i < props.length; i++) {
      if (!inArea(i)) continue;
      const p = props[i];
      const it = item(p);
      const asOwner = it.ownerTrail.some((o) => norm(o.value).includes(needle));
      const asSeller = it.saleList.some((s) => norm(s.seller).includes(needle)) || SELLER_FIELDS.some((f) => norm(p.current[f] ?? '').includes(needle));
      if (!asOwner && !asSeller) continue;
      const touched = [...it.ownerTrail.map((o) => o.week), ...it.saleList.map((s) => s.week)];
      if ((after || before) && !touched.some((w) => inRange(w, after, before))) continue;
      it.role = [asOwner && 'owner', asSeller && 'seller'].filter(Boolean).join(', ');
      items.push(it);
    }
    items.sort((a, b) => (b.saleDate || '').localeCompare(a.saleDate || ''));
    return { ...base, entity: params.entity, total: items.length, items: items.slice(0, limit) };
  }

  if (question === 'repeat_sales') {
    const items: AskItem[] = [];
    for (let i = 0; i < props.length; i++) {
      if (!inArea(i)) continue;
      const it = item(props[i]);
      const saleList = (after || before) ? it.saleList.filter((s) => inRange(s.date, after, before)) : it.saleList;
      if (saleList.length >= 2) items.push({ ...it, saleList });
    }
    items.sort((a, b) => b.saleList.length - a.saleList.length || (b.saleDate || '').localeCompare(a.saleDate || ''));
    return { ...base, total: items.length, items: items.slice(0, limit) };
  }

  if (question === 'changes') {
    const field = (params.field ?? '').trim().toUpperCase();
    const items: AskItem[] = [];
    for (let i = 0; i < props.length; i++) {
      if (!inArea(i)) continue;
      const p = props[i];
      const evs = p.events.filter((e) => e[1] !== '*' && (!field || e[1].toUpperCase() === field) && inRange(e[0], after, before));
      if (evs.length) items.push({ ...item(p), events: evs });
    }
    items.sort((a, b) => b.events[b.events.length - 1][0].localeCompare(a.events[a.events.length - 1][0]));
    return { ...base, field: field || null, total: items.length, items: items.slice(0, limit) };
  }

  if (question === 'new' || question === 'removed') {
    const items: AskItem[] = [];
    for (let i = 0; i < props.length; i++) {
      if (!inArea(i)) continue;
      const p = props[i];
      const ok = question === 'new'
        ? inRange(p.first, after, before)
        : p.removed && inRange(p.last, after, before);
      if (ok) items.push(item(p));
    }
    items.sort((a, b) => (question === 'new' ? b.first.localeCompare(a.first) : b.last.localeCompare(a.last)));
    return { ...base, total: items.length, items: items.slice(0, limit) };
  }

  if (question === 'top_buyers' || question === 'top_sellers') {
    // Ownership changes: the new TAX OWNER bought, the seller of that sale sold.
    const counts = new Map<string, { name: string; count: number; properties: string[] }>();
    const bump = (name: string, id: string) => {
      const k = norm(name);
      if (!k) return;
      const c = counts.get(k) ?? { name, count: 0, properties: [] };
      if (c.properties.includes(id)) return;
      c.count++;
      if (c.properties.length < 10) c.properties.push(id);
      counts.set(k, c);
    };
    for (let i = 0; i < props.length; i++) {
      if (!inArea(i)) continue;
      const p = props[i];
      for (const s of salesOf(p)) {
        if (!inRange(s.date, after, before)) continue;
        bump(question === 'top_buyers' ? s.buyer : s.seller, p.id);
      }
    }
    const ranked = Array.from(counts.values()).sort((a, b) => b.count - a.count).slice(0, limit);
    return { ...base, total: counts.size, items: ranked };
  }

  return { ...base, total: 0, items: [], note: `Unknown question "${question}"` };
}

// ---------- Routes ----------

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function fail(res: Response, e: unknown) {
  res.status(502).json({ error: e instanceof Error ? e.message : 'Dropbox request failed' });
}

export function registerDropboxRoutes(app: Express) {
  // What the sync has written: weeks, per-database latest file, every week's file list.
  app.get('/api/dropbox/summary', async (_req: Request, res: Response) => {
    try {
      res.json(await summary());
    } catch (e) {
      fail(res, e);
    }
  });

  // Raw rows of one CSV (one file, one week): ?type=APTS&week=2026-08-27&q=…&page=0
  app.get('/api/dropbox/rows', async (req: Request, res: Response) => {
    const type = str(req.query.type);
    const week = str(req.query.week);
    const q = str(req.query.q).trim().toLowerCase();
    const page = Math.max(0, Number(str(req.query.page)) || 0);
    if (!FILE.test(type) || !WEEK.test(week)) {
      return res.status(400).json({ error: 'type and week are required' });
    }
    try {
      const { columns, rows } = await loadRows(type, week);
      const hits = q ? rows.filter((r) => r.some((v) => v.toLowerCase().includes(q))) : rows;
      res.json({ type, week, columns, total: hits.length, page, pageSize: PAGE, rows: hits.slice(page * PAGE, (page + 1) * PAGE) });
    } catch (e) {
      fail(res, e);
    }
  });

  // History questions (see ASK_QUESTIONS): ?type=APTS&question=property_history&subject=…
  app.get('/api/dropbox/ask', async (req: Request, res: Response) => {
    const type = str(req.query.type);
    const question = str(req.query.question) as AskQuestion;
    if (!TYPE.test(type)) return res.status(400).json({ error: 'type is required' });
    if (!ASK_QUESTIONS.includes(question)) return res.status(400).json({ error: `question must be one of ${ASK_QUESTIONS.join(', ')}` });
    try {
      res.json(await ask({
        type, question,
        subject: str(req.query.subject), entity: str(req.query.entity), field: str(req.query.field), area: str(req.query.area),
        after: str(req.query.after), before: str(req.query.before),
        limit: Number(str(req.query.limit)) || undefined,
      }));
    } catch (e) {
      fail(res, e);
    }
  });

  // One record per property across every week:
  //   ?type=APTS&q=briarhill&page=0[&removed=1]  -> search + paging
  //   ?type=APTS&id=APTS-01234                    -> current record + every change
  app.get('/api/dropbox/properties', async (req: Request, res: Response) => {
    const type = str(req.query.type);
    const id = req.query.id === undefined ? null : str(req.query.id);
    const q = str(req.query.q).trim().toLowerCase();
    const page = Math.max(0, Number(str(req.query.page)) || 0);
    const includeRemoved = str(req.query.removed) === '1';
    if (!TYPE.test(type)) return res.status(400).json({ error: 'type is required' });
    try {
      const { hist, summaries, haystack, byId } = await loadHistory(type);
      if (id !== null) {
        if (!ID.test(id)) return res.status(400).json({ error: 'bad id' });
        const p = byId.get(id);
        if (!p) return res.status(404).json({ error: 'not found' });
        return res.json({ ...summarize(p), type, weeks: hist.weeks.length, fields: hist.fields, current: p.current, events: p.events });
      }
      const terms = q.split(/\s+/).filter(Boolean);
      const hits: Summary[] = [];
      for (let i = 0; i < summaries.length; i++) {
        if (!includeRemoved && summaries[i].removed) continue;
        if (terms.every((t) => haystack[i].includes(t))) hits.push(summaries[i]);
      }
      hits.sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
      res.json({
        type,
        weeks: hist.weeks.length,
        firstWeek: hist.weeks[0] ?? null,
        latestWeek: hist.weeks[hist.weeks.length - 1] ?? null,
        generated: hist.generated,
        properties: summaries.length,
        current: summaries.filter((s) => !s.removed).length,
        total: hits.length,
        page,
        pageSize: PAGE,
        items: hits.slice(page * PAGE, (page + 1) * PAGE),
      });
    } catch (e) {
      fail(res, e);
    }
  });
}
