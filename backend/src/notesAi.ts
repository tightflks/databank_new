import { createHash } from 'crypto';
import type { Express, Request, Response } from 'express';
import { requireUser } from './users';
import { propertyReport } from './dropbox';

// The Comments/Notes field is Alan's dense shorthand ("BERKADIA(P.VETTER)BROKERED/$14MIL/
// CAP 5.2%..."). Blake and Tareq's Sep 24 call: keep the raw text and an AI-cleaned version
// side by side (never replace it — the raw field is valuable on its own and appears on the
// printed report), plus an optional short summary. Computed lazily per property, once — not
// for every property on every page load — and cached by a hash of the exact text, so an
// unchanged note is never re-sent to the API twice.

type Db = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
};

type CacheRow = { hash: string; cleaned: string; summary: string; created_date: string };

let db_: Db | null = null;
const getCacheStmt = () => db_!.prepare('SELECT * FROM notes_ai_cache WHERE hash = ?');
const insertCacheStmt = () =>
  db_!.prepare('INSERT INTO notes_ai_cache (hash, cleaned, summary) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET cleaned = excluded.cleaned, summary = excluded.summary');

function notesHash(raw: string): string {
  return createHash('sha1').update(raw.trim()).digest('hex');
}

const SYSTEM = `You clean up dense shorthand notes from a commercial real-estate research file for a paying customer to read. The notes use heavy abbreviation, slashes instead of sentences, and inconsistent punctuation (e.g. "BERKADIA(P.VETTER)BROKERED/$14MIL/CAP 5.2%/BUYER TO ASSUME EXIST LOAN").

Rewrite the notes as clear, plain-English prose. This is a REWRITE, not a summary — every fact in the original must still be present: every dollar figure, percentage, date, name, unit/square-footage count, loan detail, and party mentioned. Expand abbreviations you're confident about (BERKADIA stays as-is since it's a company name; CAP -> "cap rate"; MIL -> "million"). Do not add any fact, guess, or interpretation that is not directly stated in the original. Do not drop anything, even details that seem minor. If the original text is already clear, return it lightly punctuated rather than rewritten.

Respond with strict JSON only, no markdown fences: {"cleaned": "...", "summary": "..."}
- cleaned: the full rewrite, same information density as the original, just readable.
- summary: one short plain-English sentence capturing the single most important fact (usually the deal itself), for a quick skim. If there isn't a clear headline fact, use "".`;

async function cleanNotes(raw: string): Promise<{ cleaned: string; summary: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        temperature: 0,
        system: SYSTEM,
        messages: [{ role: 'user', content: raw }],
      }),
    });
    if (!r.ok) {
      console.error('notes-ai error:', r.status, await r.text());
      return null;
    }
    const j = (await r.json()) as { content?: { text?: string }[] };
    const text = (j.content?.[0]?.text ?? '').trim();
    const parsed = JSON.parse(text.replace(/^```(json)?/, '').replace(/```$/, '').trim()) as { cleaned?: string; summary?: string };
    if (!parsed.cleaned) return null;
    return { cleaned: parsed.cleaned, summary: parsed.summary ?? '' };
  } catch (e) {
    console.error('notes-ai failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

export function registerNotesAiRoutes(app: Express, db: Db) {
  db_ = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes_ai_cache (
      hash TEXT PRIMARY KEY,
      cleaned TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      created_date DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  app.get('/api/dropbox/report/notes-ai', requireUser, async (req: Request, res: Response) => {
    const type = String(req.query.type || '');
    const id = String(req.query.id || '');
    if (!type || !id) return res.status(400).json({ error: 'type and id are required' });
    const r = await propertyReport(type, id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const raw = (r.comments || '').trim();
    if (!raw) return res.json({ cleaned: '', summary: '' });

    const hash = notesHash(raw);
    const cached = getCacheStmt().get(hash) as CacheRow | undefined;
    if (cached) return res.json({ cleaned: cached.cleaned, summary: cached.summary });

    const result = await cleanNotes(raw);
    if (!result) return res.status(503).json({ error: 'AI cleanup is not available right now.' });
    insertCacheStmt().run(hash, result.cleaned, result.summary);
    res.json(result);
  });
}
