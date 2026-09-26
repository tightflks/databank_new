# Databank — notes for Claude

Commercial real-estate sales database (apartments, retail, land, etc.) with a search UI,
property pages, PDF reports and "Ask AI" search. Customers sign up for a 30-day trial.

## Working rules (keep token use low)
- **Don't read whole large files.** `backend/src/index.ts` (~3000 lines) and
  `frontend/src/UserDashboard.tsx` (~2200) are big. Grep for the route/function first,
  then read only that line range.
- Make targeted edits; don't re-print or rewrite whole files.
- Keep commit messages to a short subject + a few lines of body.
- `main` **auto-deploys to production on Railway**. Work on a branch; only merge to main
  when asked.

## Layout
- `backend/src/index.ts` — Express app: DB setup (top), PDF/report HTML + Puppeteer
  (`launchBrowser`), `/api/uploads`, `/api/reports`, `/api/databases`, `/api/feedback`,
  `/api/nl-search` (Ask AI, Claude Haiku). Section headers look like `// ==== NAME ====`.
- `backend/src/users.ts` — customer accounts, trial/paid logic (`hasAccess`), email
  verification + password reset (`email_tokens` table), `requireUser`.
- `backend/src/auth.ts` — admin login (`ADMIN_PASSWORD(S)`), `requireAdmin`, `rateLimit`.
- `backend/src/sessions.ts` — SQLite-backed sessions for both admin and customers.
- `backend/src/dropbox.ts` — weekly CSVs from Dropbox → databases; `/api/dropbox/*`.
- `backend/src/photos.ts`, `notesAi.ts`, `stats.ts`, `usage.ts`, `mail.ts` (nodemailer).
- `frontend/src/App.tsx` — routing/shell; `UserDashboard.tsx` — customer search (filters
  client-side over `/api/uploads/:id/data`); `PropertyPage.tsx`; `Admin*.tsx`, `FeedbackList.tsx`.
- `frontend/src/SearchComps.tsx` — old screen, not imported anywhere.
- SQLite file lives under `DATA_DIR` (Railway volume).

## Build & test
- Root: `npm run build` (frontend then backend). Railway uses nixpacks + system Chromium.
- Backend: `cd backend && PUPPETEER_SKIP_DOWNLOAD=true npm ci && npm test && npm run build`.
  Run `npm run build` too — `tsc --noEmit` alone missed a test-file error that broke a deploy.
- Frontend: `cd frontend && npm test && npm run build` (vitest, `tsc -b && vite build`).

## Known open items (from the Sep 25 security review)
- `/api/uploads/:id/data` still sends every row (contact columns stripped) — needs
  server-side search + paging.
- Dependency upgrades (`xlsx` 0.18.5, express, puppeteer), one shared Puppeteer browser,
  DB backups, error alerts.
