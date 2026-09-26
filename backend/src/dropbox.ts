import { gunzipSync } from 'zlib';
import nodePath from 'path';
import { existsSync, readFileSync } from 'fs';
import { Express, Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { requireUser, perUserDailyLimit } from './users';

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

// Reflex's field-width test record: every field is a run of the same digit (name "1111…", city "AAA").
// As a number (the uploads table stores numeric-looking cells as numbers) it prints as 1.1111e+21.
const TEST_NAME = /^(\d)\1{3,}$|^(\d)(\.\2{3,}\d{0,3})?e\+\d+$/;
export function isTestRecord(name: unknown): boolean {
  return TEST_NAME.test(String(name ?? '').trim());
}

// ---------- Rows: one CSV, one week ----------

// Any CSV the sync wrote for that week (APTS, APTS2, IND3…): a bare upper-case name, so no path tricks.
const FILE = /^[A-Z0-9]{1,16}$/;
const WEEK = /^\d{4}-\d{2}-\d{2}$/;

type Parsed = { at: number; rev: string; columns: string[]; rows: string[][] };
const rowsCache = new Map<string, Parsed>();

async function loadRows(type: string, week: string): Promise<Parsed> {
  const key = `${week}/${type}`;
  const hit = rowsCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const res = await download(`${CSV_ROOT}/${week}/${type}.csv`);
  if (!res) throw new Error(`${type}.csv for ${week} is not in Dropbox`);
  // Dropbox's file revision: the sync rewrites a week's CSV in place (e.g. date repairs), and the
  // uploads table must see that as a new version.
  const meta = JSON.parse(res.headers.get('Dropbox-API-Result') ?? '{}') as { rev?: string };
  const all = parseCsv(await res.text());
  const header = (all[0] ?? []).map((h) => h.trim());
  const nameIdx = header.indexOf('P NAME');
  const body = all
    .slice(1)
    .map((r) => header.map((_, i) => (r[i] ?? '').trim()))
    // Reflex pads the database with empty and half-typed records; a real one has several fields.
    .filter((r) => r.filter((v) => v).length >= 3)
    .filter((r) => nameIdx < 0 || !isTestRecord(r[nameIdx]));
  const used = header.map((_, i) => body.some((r) => r[i]));
  const parsed = {
    at: Date.now(),
    rev: meta.rev ?? '',
    columns: header.filter((_, i) => used[i]),
    rows: body.map((r) => r.filter((_, i) => used[i])),
  };
  rowsCache.set(key, parsed);
  return parsed;
}

// ---------- Upload: write one week's converted CSVs and record it in the manifest ----------

async function upload(path: string, body: Buffer): Promise<void> {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true }),
    },
    body: new Uint8Array(body),
  });
  if (!res.ok) throw new Error(`Dropbox upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

// Files over Dropbox's 150 MB single-call limit go up in chunks through an upload session.
export async function uploadLarge(path: string, body: Buffer): Promise<void> {
  const CHUNK = 64 * 1024 * 1024;
  if (body.length <= CHUNK) return upload(path, body);
  const token = await accessToken();
  const post = async (endpoint: string, arg: object, chunk: Buffer) => {
    const res = await fetch(`https://content.dropboxapi.com/2/files/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify(arg) },
      body: new Uint8Array(chunk),
    });
    if (!res.ok) throw new Error(`Dropbox ${endpoint} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return res;
  };
  const start = (await (await post('upload_session/start', { close: false }, body.subarray(0, CHUNK))).json()) as { session_id: string };
  let offset = CHUNK;
  for (; offset + CHUNK < body.length; offset += CHUNK) {
    await post('upload_session/append_v2', { cursor: { session_id: start.session_id, offset }, close: false }, body.subarray(offset, offset + CHUNK));
  }
  await post('upload_session/finish', { cursor: { session_id: start.session_id, offset }, commit: { path, mode: 'overwrite', mute: true } }, body.subarray(offset));
}

export async function deletePath(path: string): Promise<void> {
  const res = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`Dropbox delete failed (${res.status})`);
}

export type WeekFile = { type: string; body: Buffer };

// Files come from the RXD reader (tools/rxd/rxd.py) run by hand when the scheduled sync cannot.
export async function uploadWeek(week: string, files: WeekFile[]): Promise<{ week: string; files: Record<string, number> }> {
  if (!WEEK.test(week)) throw new Error('week must be YYYY-MM-DD');
  const counts: Record<string, number> = {};
  for (const f of files) {
    if (!FILE.test(f.type)) throw new Error(`Bad file name "${f.type}"`);
    const rows = parseCsv(f.body.toString('utf8')).filter((r) => r.some((v) => v));
    counts[f.type] = Math.max(0, rows.length - 1);
    await upload(`${CSV_ROOT}/${week}/${f.type}.csv`, f.body);
  }
  const res = await download(`${CSV_ROOT}/manifest.json`);
  const m: Manifest = res ? ((await res.json()) as Manifest) : { weeks: {} };
  const prev = m.weeks[week];
  const zip = `datafile_${week.slice(5, 7)}_${week.slice(8, 10)}_${week.slice(0, 4)}.zip`;
  m.weeks[week] = {
    zip: prev?.zip ?? zip,
    size: prev?.size ?? files.reduce((n, f) => n + f.body.length, 0),
    synced_at: new Date().toISOString(),
    files: { ...(prev?.files ?? {}), ...counts },
  };
  await upload(`${CSV_ROOT}/manifest.json`, Buffer.from(JSON.stringify(m, null, 2)));
  summaryCache = null;
  for (const t of Object.keys(counts)) rowsCache.delete(`${week}/${t}`);
  return { week, files: counts };
}

// ---------- Backup: build a missing week's CSVs from the Excel exports ----------
// The zip→CSV job (tools/rxd/dropbox_sync.py) is the normal path. If a week's datafile folder
// has been sitting in Dropbox for a while with no CSVs written for it, the Excel exports saved
// next to the Reflex files (APTS.xls, IND_09_23_2026 (1).xlsx, …) carry the same columns, so the
// site converts those itself rather than keep showing last week.

const DATAFILE_ROOT = '/GrooveSolutions/Databank/_archive/_datafile';
const EXPORT_TYPES = [...new Set(DATABASES.map((d) => d.type))];
const BACKUP_AFTER_MS = 6 * 60 * 60 * 1000; // give the normal job this long first

export type Entry = { '.tag': string; name: string; path_lower: string; server_modified?: string };

export async function listFolder(path: string): Promise<Entry[]> {
  const token = await accessToken();
  const call = async (endpoint: string, body: object) => {
    const res = await fetch(`https://api.dropboxapi.com/2/files/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Dropbox list failed (${res.status})`);
    return (await res.json()) as { entries: Entry[]; cursor: string; has_more: boolean };
  };
  let page = await call('list_folder', { path, limit: 2000 });
  const entries = [...page.entries];
  while (page.has_more) {
    page = await call('list_folder/continue', { cursor: page.cursor });
    entries.push(...page.entries);
  }
  return entries;
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// One Reflex Excel export -> CSV in the same shape as the converted weekly files: the header row
// is the one holding "P NAME" (exports can have a title row and a blank first column above/left
// of it), dates become YYYY-MM-DD, and blank rows are dropped.
export function excelToCsv(buf: Buffer): { csv: string; rows: number } | null {
  const wb = XLSX.read(buf, { cellNF: true }); // keep number formats so date cells can be told apart
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) return null;
  const range = XLSX.utils.decode_range(ws['!ref']);
  const text = (r: number, c: number): string => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
    if (!cell || cell.v === undefined || cell.v === null) return '';
    if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) return XLSX.SSF.format('yyyy-mm-dd', cell.v as number);
    if (cell.t === 'd' && cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
    return String(cell.v);
  };
  let headerRow = -1, firstCol = -1;
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 20) && headerRow < 0; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (text(r, c).trim() === 'P NAME') { headerRow = r; firstCol = c; break; }
    }
  }
  if (headerRow < 0) return null;
  let lastCol = range.e.c;
  while (lastCol > firstCol && !text(headerRow, lastCol).trim()) lastCol--;
  const lines: string[] = [];
  for (let r = headerRow; r <= range.e.r; r++) {
    const row: string[] = [];
    for (let c = firstCol; c <= lastCol; c++) row.push(r === headerRow ? text(r, c).trim() : text(r, c));
    if (r > headerRow && row.every((v) => !v.trim())) continue;
    lines.push(row.map(csvCell).join(','));
  }
  return { csv: lines.join('\n') + '\n', rows: lines.length - 1 };
}

// Newest datafile_MM_DD_YYYY folder as YYYY-MM-DD.
function folderWeek(name: string): string | null {
  const m = /^datafile_(\d{2})_(\d{2})_(\d{4})$/i.exec(name);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

export async function backfillWeekFromExcel(force = false): Promise<{ week: string; files: Record<string, number> } | null> {
  if (process.env.DROPBOX_LOCAL_CSV_ROOT) return null;
  const folders = (await listFolder(DATAFILE_ROOT))
    .filter((e) => e['.tag'] === 'folder' && folderWeek(e.name))
    .sort((a, b) => folderWeek(a.name)!.localeCompare(folderWeek(b.name)!));
  const newest = folders[folders.length - 1];
  if (!newest) return null;
  const week = folderWeek(newest.name)!;

  const res = await download(`${CSV_ROOT}/manifest.json`);
  const m: Manifest = res ? ((await res.json()) as Manifest) : { weeks: {} };
  if (Object.keys(m.weeks[week]?.files ?? {}).length > 0) return null; // already converted

  const entries = (await listFolder(newest.path_lower)).filter((e) => e['.tag'] === 'file');
  const lastUpload = Math.max(0, ...entries.map((e) => Date.parse(e.server_modified ?? '') || 0));
  if (!force && Date.now() - lastUpload < BACKUP_AFTER_MS) return null;

  const files: WeekFile[] = [];
  for (const type of EXPORT_TYPES) {
    const re = new RegExp(`^${type}(?:_\\d{2}_\\d{2}_\\d{4})?(?:\\s*\\(\\d+\\))?\\.xlsx?$`, 'i');
    const match = entries.filter((e) => re.test(e.name)).sort((a, b) => (b.server_modified ?? '').localeCompare(a.server_modified ?? ''))[0];
    if (!match) continue;
    const dl = await download(match.path_lower);
    if (!dl) continue;
    const converted = excelToCsv(Buffer.from(await dl.arrayBuffer()));
    if (converted && converted.rows > 0) files.push({ type, body: Buffer.from(converted.csv, 'utf8') });
    else console.error(`Excel backup: ${match.name} has no "P NAME" header row, skipped`);
  }
  if (!files.length) return null;
  const result = await uploadWeek(week, files);
  console.log(`✅ Excel backup: built ${week} from the Excel exports`, result.files);
  return result;
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

export type LatestSheet = { week: string; rev: string; type: string; file: string; data: (string | number | null)[][] };

export async function latestSheet(databaseId: string): Promise<LatestSheet | null> {
  const db = DATABASES.find((d) => d.id === databaseId);
  if (!db) throw new Error(`Unknown database "${databaseId}"`);
  const s = (await summary()) as { databases: { id: string; latestWeek: string | null }[] };
  const week = s.databases.find((d) => d.id === databaseId)?.latestWeek;
  if (!week) return null;
  const { rev, columns, rows } = await loadRows(db.type, week);
  return {
    week,
    rev,
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

// Real-estate shorthand that should stay in caps rather than get title-cased, and the
// research file's ordinal suffixes ("2ND", "3RD") which PROPER-style casing would otherwise
// mangle into "2Nd", "3Rd" — genuinely wrong regardless of matching Excel's PROPER exactly.
const KEEP_CAPS = new Set(['LLC', 'LLP', 'LP', 'LTD', 'INC', 'CO', 'PC', 'JV', 'MF', 'DBA', 'TIC', 'HOA', 'REIT']);

// Researchers flag a record with a leading/trailing "*" or "#" in the name field itself (e.g.
// "*PLAINVIEW 2ND PHASE") — a marker for their own internal tracking, not part of the actual
// property name, and not something a customer reading a report should see.
function stripMarkers(s: string): string {
  return s.replace(/^[*#\s]+|[*#\s]+$/g, '');
}

// Researchers write "UNKNOWN TO US" (or similar) when a field genuinely wasn't found — that's
// internal shorthand, not something to show a paying customer verbatim.
function orNotDisclosed(s: string): string {
  return /^(unknown( to us)?|n\/?a|none|not (available|disclosed|found))$/i.test(s.trim()) ? 'Not disclosed' : s;
}

// Multi-party names come from the source as a comma-joined, un-spaced list ("Shirley
// Cooper,Judy Tullis,Etal") — add the missing spaces after commas and normalize any spelling
// of "et al" (which properCase alone would leave as "Etal") to "et al."
function formatPartyList(s: string): string {
  return s
    .replace(/,(?=\S)/g, ', ')
    .replace(/\bEt\s*al\.?/gi, 'et al.')
    .replace(/\s+/g, ' ')
    .trim();
}

// Excel PROPER()-equivalent, for display only (never applied to the raw data used for
// matching/search). Matches Excel's real behavior, including capitalizing the letter right
// after an apostrophe (e.g. "MCDONALD'S" -> "Mcdonald'S"), rather than a "smarter" version —
// except for the two cases above, which are wrong often enough to be worth a specific fix
// rather than literal PROPER fidelity.
function properCase(s: string): string {
  const titled = s.replace(/\p{L}+/gu, (w) => {
    const upper = w.toUpperCase();
    if (KEEP_CAPS.has(upper)) return upper;
    const lower = w.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
  // The title-casing above treats the letters after a digit as their own word ("2ND" -> "2"
  // + "Nd"), which is correct for most abbreviations but wrong for an ordinal suffix. Put it
  // back down: "2Nd" -> "2nd".
  return titled.replace(/(\d)(St|Nd|Rd|Th)\b/g, (_m, d: string, suf: string) => d + suf.toLowerCase());
}

// Punctuation-free lowercase, so "Cassville-White Rd" and "cassville white" meet.
// Apostrophes are dropped rather than turned into a space, so "Zaxby's" and "Zaxbys" both
// normalize to "zaxbys" and match each other. Covers the straight apostrophe (') plus the
// smart-quote variants (’ ‘ ´ `) that copy-pasted text commonly carries — those used to fall
// through to the punctuation-to-space rule below and silently break the match.
function norm(s: string): string {
  return s.toLowerCase().replace(/['\u2018\u2019\u00b4`]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
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
  hist.properties = hist.properties.filter((p) => !isTestRecord(p.name));
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
  'sold_once',        // properties with a single sale on record (sold in a period and never resold), oldest first
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
  search_text?: string; // free text (e.g. a company/brand name) — some callers send this
                         // instead of `area` for history questions; we treat it the same.
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
  // a date that is undone at the next sighting (record flips straight back) was a typo, not a sale
  const trail = trailOf(p, dateField).filter((d, i, a) => !(i > 0 && i + 1 < a.length && a[i + 1].value === a[i - 1].value));
  const seen = new Set<string>();
  const dates = trail.filter((d) => !seen.has(d.value) && seen.add(d.value));
  return dates.map((d) => ({
    week: d.week,
    date: fixCentury(d.value),
    price: at(priceField, d.week),
    seller: at(sellerField, d.week),
    buyer: at(OWNER_FIELD, d.week) || at('OWNER', d.week),
  }));
}

// Reflex took two-digit years; a sale dated 1914 in a file that only goes back a few decades is 2014.
export function fixCentury(date: string): string {
  const y = Number(date.slice(0, 4));
  return y >= 1900 && y < 1950 ? `${y + 100}${date.slice(4)}` : date;
}

function item(p: Stored): AskItem {
  return { ...summarize(p), ownerTrail: trailOf(p, OWNER_FIELD), saleList: salesOf(p), events: p.events };
}

// A customer-readable one-page report for one property: what it is, who owns
// it, who owned it before, every sale on record. Same facts as the ask()
// items, arranged for someone who has never seen a Reflex field name.
export type PropertyReport = {
  id: string; type: string; name: string; formerNames: string[]; address: string; city: string; county: string; zip: string; parcel: string;
  removed: boolean; first: string; last: string; weeks: number;
  facts: { label: string; value: string }[];
  owner: string; ownerTrail: Trail; saleList: Sale[];
  loan: string; lender: string; broker: string; comments: string;
  contacts: { label: string; value: string }[];
  allFields: { label: string; value: string }[];
};

const FACT_FIELDS: [string, string][] = [
  ['P TYPE', 'Property type'], ['PROJECT TYPE', 'Property type'], ['MARKET AREA', 'Submarket'],
  ['UNITS COMPLETED:', 'Units'], ['UNITS COMPLETED', 'Units'], ['$ UNIT PROJECT', 'Price per unit'], ['# SQ FT BUILT', 'Square feet built'],
  ['HEATED SF', 'Square feet'], ['# ACRES', 'Acres'], ['$ ACRE', 'Price per acre'], ['YEAR BUILT', 'Year built'], ['BUILT\\COMPLETE', 'Built'],
  ['ORIGINALLY BUILT', 'Originally built'], ['INSIDER DATE', 'Last published by Databank'],
];
const YEAR_ONLY = new Set(['YEAR BUILT', 'BUILT\\COMPLETE', 'ORIGINALLY BUILT']);

// Every party on the record with its rep, phone and mailing address, from the source's
// prefixed columns (O = owner, S = seller, B = broker, L = lender, C L = construction lender…).
// Ported from the frontend's old raw-row view so the full-page report keeps the same depth —
// the redesign changed the page's look, not what data a paying customer can see.
function buildContacts(c: Record<string, string>): { label: string; value: string }[] {
  const get = (col: string) => c[col] ?? '';
  const getAny = (...cols: string[]) => { for (const col of cols) { const v = get(col); if (v) return v; } return ''; };
  const address = (prefix: string) => {
    const street = properCase(`${get(`${prefix} STREET NUMBER`)} ${get(`${prefix} STREET NAME`)}`.trim());
    const suite = get(`${prefix} SUITE NUMBER`);
    const box = get(`${prefix} P O BOX NUMBER`);
    const cityLine = [properCase(get(`${prefix} CITY`)), [get(`${prefix} STATE`), get(`${prefix} ZIP`)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return [street, suite && `Suite ${suite}`, box && `P.O. Box ${box}`, cityLine].filter(Boolean).join(', ');
  };
  const party = (label: string, name: string, prefix: string, phones: string[], reps: string[] = [`${prefix} REP`, `${prefix} REP2`]) => {
    if (!name) return [];
    return [
      { label, value: orNotDisclosed(formatPartyList(properCase(name))) },
      { label: `${label} Contact`, value: [properCase(reps.map(get).filter(Boolean).join(' / ')), getAny(...phones)].filter(Boolean).join(' · ') },
      { label: `${label} Address`, value: address(prefix) },
    ];
  };
  return [
    ...party('Owner', get('OWNER') || get('TAX OWNER'), 'O', ['O PHONE', 'O PHONE2\\FAX', 'O PHONE2 FAX']),
    ...party('2nd Owner', get('2ND OWNER'), '2ND OWNER', ['2ND OWNER PHONE']),
    ...party('Seller', getAny('SELLER\\FORECLOSEE', 'SELLER'), 'S', ['S PHONE']),
    ...party('Broker', get('BROKER'), 'B', ['BROKER PHONE', 'B PHONE']),
    ...(get('BUILDER') ? [{ label: 'Builder', value: properCase(get('BUILDER')) }] : []),
    ...party('Lender', get('LENDER'), 'L', ['L PHONE']),
    ...party('Construction Lender', get('C LENDER'), 'C L', ['C L PHONE']),
    ...party('Leasing', getAny('LEASING COMPANY', 'LEASING REP'), 'LEASING', ['LEASING PHONE']),
    ...party('Management', get('MANAGEMENT COMPANY'), 'MANAGEMENT', ['MANAGEMENT PHONE']),
    ...(get('ATTORNEY') ? [{ label: 'Attorney', value: [properCase(get('ATTORNEY')), get('ATTORNEY PHONE')].filter(Boolean).join(' · ') }] : []),
    ...(get('ONSITE PHONE') ? [{ label: 'Onsite Telephone', value: get('ONSITE PHONE') }] : []),
  ].filter((f) => f.value);
}

// Literally every non-empty column on the record, not just the curated facts/contacts above —
// the "show me everything" escape hatch the old raw-row view had.
function allFieldsOf(c: Record<string, string>): { label: string; value: string }[] {
  return Object.entries(c)
    .filter(([label, value]) => label && value !== undefined && value !== null && String(value).trim() !== '')
    .map(([label, value]) => ({ label, value: label.toUpperCase() === 'COMMENTS' || /^M\d+$/.test(label) ? value.trim() : properCase(value.trim()) }));
}

export async function propertyReport(type: string, id: string): Promise<PropertyReport | null> {
  const { hist, byId } = await loadHistory(type);
  const p = byId.get(id);
  if (!p) return null;
  const c = p.current;
  const names = trailOf(p, 'P NAME').map((n) => n.value).filter((n) => n && norm(n) !== norm(p.name));
  const facts = FACT_FIELDS.filter(([f]) => c[f]).map(([f, label]) => ({
    label,
    value: YEAR_ONLY.has(f) ? c[f].slice(0, 4) : properCase(c[f]),
  }));
  const properTrail = (t: Trail): Trail => t.map((x) => ({ ...x, value: formatPartyList(properCase(x.value)) }));
  return {
    id: p.id, type, name: properCase(stripMarkers(p.name)), formerNames: Array.from(new Set(names)).map((n) => properCase(stripMarkers(n))), address: properCase(p.address), city: properCase(p.city), county: properCase(p.county), zip: c['P ZIP'] ?? '', parcel: p.parcel,
    removed: p.removed, first: p.first, last: p.last, weeks: hist.weeks.length,
    facts,
    owner: formatPartyList(properCase(c[OWNER_FIELD] ?? c['OWNER'] ?? '')),
    ownerTrail: properTrail(trailOf(p, OWNER_FIELD).length ? trailOf(p, OWNER_FIELD) : trailOf(p, 'OWNER')),
    saleList: salesOf(p).map((s) => ({ ...s, seller: formatPartyList(properCase(s.seller)), buyer: formatPartyList(properCase(s.buyer)) })),
    loan: c['$ LOAN'] ?? '', lender: orNotDisclosed(properCase(c['LENDER'] ?? '')), broker: orNotDisclosed(properCase(c['BROKER'] ?? '')), comments: c['COMMENTS'] ?? '',
    contacts: buildContacts(c),
    allFields: allFieldsOf(c),
  };
}

function inRange(week: string, after?: string, before?: string): boolean {
  return (!after || week >= after) && (!before || week <= before);
}

export async function ask(params: AskParams): Promise<Record<string, unknown>> {
  const { type, question } = params;
  const after = params.after && WEEK_RE.test(params.after) ? params.after : undefined;
  const before = params.before && WEEK_RE.test(params.before) ? params.before : undefined;
  const limit = Math.min(Math.max(params.limit ?? 500, 1), 1000);
  const { hist, words } = await loadHistory(type);
  const props = hist.properties;

  // Some callers (including the LLM query-parser) send free text as `search_text` — the
  // field documented for mode "current" — even on history questions where only `area` is
  // read below. Fold both in so a company/brand name narrows the results either way.
  const areaTerms = norm(`${params.area ?? ''} ${params.search_text ?? ''}`).split(' ').filter(Boolean);
  const inArea = (i: number) => areaTerms.every((t) => words[i].includes(t));
  let oldestSale: string | null = null;
  for (const p of props) for (const s of salesOf(p)) if (s.date && (!oldestSale || s.date < oldestSale)) oldestSale = s.date;
  const base = { type, question, weeks: hist.weeks.length, firstWeek: hist.weeks[0] ?? null, latestWeek: hist.weeks[hist.weeks.length - 1] ?? null, oldestSale, after: after ?? null, before: before ?? null };

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

  if (question === 'sold_once') {
    const items: AskItem[] = [];
    for (let i = 0; i < props.length; i++) {
      if (!inArea(i)) continue;
      const it = item(props[i]);
      if (it.saleList.length === 1 && inRange(it.saleList[0].date, after, before)) items.push(it);
    }
    items.sort((a, b) => a.saleList[0].date.localeCompare(b.saleList[0].date));
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
  app.get('/api/dropbox/summary', requireUser, async (_req: Request, res: Response) => {
    try {
      res.json(await summary());
    } catch (e) {
      fail(res, e);
    }
  });

  // Raw rows of one CSV (one file, one week): ?type=APTS&week=2026-08-27&q=…&page=0
  app.get('/api/dropbox/rows', requireUser, async (req: Request, res: Response) => {
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
  app.get('/api/dropbox/ask', requireUser, async (req: Request, res: Response) => {
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

  // Customer-readable report for one property: ?type=APTS&id=APTS-01234
  app.get('/api/dropbox/report', requireUser, perUserDailyLimit(200, 'Daily property report limit reached'), async (req: Request, res: Response) => {
    const type = str(req.query.type);
    const id = str(req.query.id);
    if (!TYPE.test(type) || !ID.test(id)) return res.status(400).json({ error: 'type and id are required' });
    try {
      const r = await propertyReport(type, id);
      if (!r) return res.status(404).json({ error: 'not found' });
      res.json(r);
    } catch (e) {
      fail(res, e);
    }
  });

  // One record per property across every week:
  //   ?type=APTS&q=briarhill&page=0[&removed=1]  -> search + paging
  //   ?type=APTS&id=APTS-01234                    -> current record + every change
  app.get('/api/dropbox/properties', requireUser, async (req: Request, res: Response) => {
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
