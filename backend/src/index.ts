import 'dotenv/config';
import express, { Request, Response } from 'express';
import multer from 'multer';
import cors from 'cors';
import helmet from 'helmet';
import * as XLSX from 'xlsx';
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
import puppeteer, { type Browser, type Page } from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { registerDropboxRoutes, dropboxConfigured, latestSheet, uploadWeek, backfillWeekFromExcel, isTestRecord, DATABASES } from './dropbox';
import * as dropboxAsk from './dropbox';
import { registerAuthRoutes, requireAdmin, rateLimit } from './auth';
import { registerBackupRoutes, startBackups } from './backup';
import { errorMiddleware, installProcessAlerts } from './alerts';
import { registerSearchRoutes } from './search/routes';
import { stripSensitiveColumns } from './columns';

installProcessAlerts();
import { sendFeedbackMail, mailConfigured, FEEDBACK_TO } from './mail';
import { registerPhotoRoutes, photosConfigured, getApprovedPhoto, fetchStaticMap, queuePhotoIfMissing } from './photos';
import { registerUserRoutes, requireUser, currentUserEmail } from './users';
import { registerNotesAiRoutes } from './notesAi';
import { registerStatsRoutes } from './stats';
import { registerUsageRoutes, recordUsage } from './usage';
const Database = require('better-sqlite3');

const app = express();
const port = process.env.PORT || 3001;

// ==================== DATABASE SETUP ====================
// Use DATA_DIR env var for production (Railway volume), fallback to local path
const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'databank.db');
const db: any = new Database(dbPath);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    upload_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    file_size INTEGER,
    sheet_count INTEGER,
    row_count INTEGER
  );

  CREATE TABLE IF NOT EXISTS excel_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id INTEGER NOT NULL,
    row_index INTEGER NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS saved_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id INTEGER NOT NULL,
    report_name TEXT NOT NULL,
    selected_dates TEXT NOT NULL,
    created_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    property_count INTEGER,
    FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    contact TEXT,
    page TEXT,
    database_type TEXT,
    created_date DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_upload_id ON excel_data(upload_id);
  CREATE INDEX IF NOT EXISTS idx_upload_date ON uploads(upload_date DESC);
  CREATE INDEX IF NOT EXISTS idx_report_upload ON saved_reports(upload_id);
  CREATE INDEX IF NOT EXISTS idx_report_date ON saved_reports(created_date DESC);
`);

// Migration: add database_type column to uploads if it doesn't exist
try {
  db.exec(`ALTER TABLE uploads ADD COLUMN database_type TEXT NOT NULL DEFAULT 'apartments'`);
  console.log('✅ Added database_type column to uploads table');
} catch (e) {
  // Column already exists
}

const DATABASE_TYPES = ['apartments', 'franchise', 'industrial', 'land', 'offices', 'retail'];

// Prepared statements for better performance
const insertUploadStmt: any = db.prepare(`
  INSERT INTO uploads (filename, original_filename, file_size, sheet_count, row_count, database_type)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertExcelDataStmt: any = db.prepare(`
  INSERT INTO excel_data (upload_id, row_index, data)
  VALUES (?, ?, ?)
`);

const getUploadsStmt: any = db.prepare(`
  SELECT * FROM uploads ORDER BY upload_date DESC LIMIT ? OFFSET ?
`);

const getUploadsByTypeStmt: any = db.prepare(`
  SELECT * FROM uploads WHERE database_type = ? ORDER BY upload_date DESC LIMIT ? OFFSET ?
`);

const getUploadByIdStmt: any = db.prepare(`
  SELECT * FROM uploads WHERE id = ?
`);

const getExcelDataStmt: any = db.prepare(`
  SELECT * FROM excel_data WHERE upload_id = ? ORDER BY row_index
`);

const deleteUploadStmt: any = db.prepare(`
  DELETE FROM uploads WHERE id = ?
`);

const insertReportStmt: any = db.prepare(`
  INSERT INTO saved_reports (upload_id, report_name, selected_dates, property_count)
  VALUES (?, ?, ?, ?)
`);

const getReportsStmt: any = db.prepare(`
  SELECT sr.*, u.original_filename, u.upload_date as source_upload_date, u.database_type,
    CASE WHEN sr.upload_id = (
      SELECT id FROM uploads u2 WHERE u2.database_type = u.database_type
      ORDER BY u2.upload_date DESC, u2.id DESC LIMIT 1
    ) THEN 1 ELSE 0 END as is_latest
  FROM saved_reports sr
  JOIN uploads u ON sr.upload_id = u.id
  ORDER BY sr.created_date DESC
  LIMIT ? OFFSET ?
`);

const getReportByIdStmt: any = db.prepare(`
  SELECT sr.*, u.original_filename, u.upload_date as source_upload_date, u.database_type
  FROM saved_reports sr
  JOIN uploads u ON sr.upload_id = u.id
  WHERE sr.id = ?
`);

const deleteReportStmt: any = db.prepare(`
  DELETE FROM saved_reports WHERE id = ?
`);

// Database helper functions
function normalizeDatabaseType(value: any): string {
  const type = String(value || '').trim().toLowerCase();
  return DATABASE_TYPES.includes(type) ? type : 'apartments';
}

function saveUploadToDb(filename: string, originalFilename: string, fileSize: number, sheetCount: number, excelData: any[][], databaseType: string = 'apartments'): number {
  const transaction = db.transaction(() => {
    // Insert upload metadata
    const result = insertUploadStmt.run(
      filename,
      originalFilename,
      fileSize,
      sheetCount,
      excelData.length,
      normalizeDatabaseType(databaseType)
    );
    const uploadId = result.lastInsertRowid as number;

    // Insert Excel rows
    for (let i = 0; i < excelData.length; i++) {
      insertExcelDataStmt.run(
        uploadId,
        i,
        JSON.stringify(excelData[i])
      );
    }

    return uploadId;
  });

  return transaction();
}

function getUploadsFromDb(limit: number = 50, offset: number = 0, databaseType?: string): any[] {
  if (databaseType) {
    return getUploadsByTypeStmt.all(normalizeDatabaseType(databaseType), limit, offset);
  }
  return getUploadsStmt.all(limit, offset);
}

function getUploadByIdFromDb(id: number): any {
  return getUploadByIdStmt.get(id);
}

function getExcelDataFromDb(uploadId: number): any[][] {
  const rows = getExcelDataStmt.all(uploadId) as any[];
  const data: any[][] = rows.map((row: any) => JSON.parse(row.data));
  const nameIdx = (data[0] ?? []).findIndex((h: unknown) => String(h ?? '').trim() === 'P NAME');
  if (nameIdx < 0) return data;
  return data.filter((r, i) => i === 0 || !isTestRecord(r[nameIdx]));
}

function deleteUploadFromDb(id: number): boolean {
  const result = deleteUploadStmt.run(id);
  return result.changes > 0;
}

function getUploadCountFromDb(): number {
  const result = db.prepare('SELECT COUNT(*) as count FROM uploads').get() as { count: number };
  return result.count;
}

function saveReportToDb(uploadId: number, reportName: string, selectedDates: string[], propertyCount: number): number {
  // Dedupe: one report per (upload, date selection) - refresh the existing one instead of inserting a duplicate
  const existing = db.prepare(`
    SELECT id FROM saved_reports WHERE upload_id = ? AND selected_dates = ?
  `).get(uploadId, JSON.stringify(selectedDates)) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE saved_reports
      SET report_name = ?, property_count = ?, created_date = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reportName, propertyCount, existing.id);
    return existing.id;
  }

  const result = insertReportStmt.run(
    uploadId,
    reportName,
    JSON.stringify(selectedDates),
    propertyCount
  );
  return result.lastInsertRowid as number;
}

function getReportsFromDb(limit: number = 50, offset: number = 0): any[] {
  return getReportsStmt.all(limit, offset);
}

function getReportByIdFromDb(id: number): any {
  return getReportByIdStmt.get(id);
}

function deleteReportFromDb(id: number): boolean {
  const result = deleteReportStmt.run(id);
  return result.changes > 0;
}

function getReportCountFromDb(): number {
  const result = db.prepare('SELECT COUNT(*) as count FROM saved_reports').get() as { count: number };
  return result.count;
}

console.log('✅ Database initialized at:', dbPath);

// Helper function to sanitize text for PDF encoding
function sanitizeText(text: string): string {
  if (!text) return '';
  // Replace special characters that WinAnsi can't encode
  return text
    .toString()
    .replace(/[^\x00-\x7F]/g, '') // Remove non-ASCII characters
    .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control characters
    .trim();
}

// Field mapping configuration
const FIELD_MAPPING = {
  propertyProfile: [
    { excel: 'P NAME', label: 'Property Name' },
    { excel: 'P STREET NUMBER', label: 'Address', concat: 'P STREET NAME' as string | undefined },
    { excel: 'P CITY', label: 'City' },
    { excel: 'COUNTY', label: 'County' },
    { excel: 'MARKET AREA', label: 'Market Area' },
    { excel: 'P ZIP', label: 'Zip' },
    { excel: 'DISTRICT2', label: 'District' },
    { excel: 'P CROSS STREET NAME', label: 'Cross Road' },
    { excel: 'PARCEL', label: 'Parcel' },
  ],
  propertyDetails: [
    { excel: 'INSIDER DATE', label: 'Insider Date' },
    { excel: 'P TYPE', label: 'Insider Description' },
    { excel: 'UNITS COMPLETED', label: 'Units / $ Unit', concat: '$ UNIT PROJECT', format: 'units' },
    { excel: 'TAX OWNER', label: 'Tax Owner' },
    { excel: 'ONSITE PHONE', label: 'Onsite Telephone' },
    { excel: '# ACRES', label: 'Acres / $ Per Acre', concat: '$ ACRE', format: 'acres' },
    { excel: 'HEATED SF', label: 'Square Ft' },
    { excel: '$ LOAN', label: 'Loan Amount', format: 'currency' },
    { excel: 'ATTORNEY', label: 'Attorney Name' },
    { excel: 'ATTORNEY PHONE', label: 'Attorney Telephone' },
  ],
  financialHighlights: [
    { excel: 'SALE PRICE', label: 'Property Sale Amount', format: 'currency' },
    { excel: 'SALE DATE', label: 'Property Sale Date' },
    { excel: 'LAND SALE PRICE', label: 'Land Sale Amount', format: 'currency' },
    { excel: 'LAND SALE DATE', label: 'Land Sale Date' },
    { excel: '$ EQUITY', label: 'Equity', format: 'currency' },
    { excel: '$ DOWNPAYMENT', label: 'Down Payment', format: 'currency' },
    { excel: '$ PURCHASE NOTE', label: 'Purchase Note', format: 'currency' },
    { excel: 'UTILITIES', label: 'Utility' },
    { excel: 'APPLICATION FEE', label: 'Application Fee', format: 'currency' },
    { excel: 'REFUND', label: 'Refund Amount', format: 'currency' },
    { excel: 'MONTHLY INCOME', label: 'Monthly Income', format: 'currency' },
    { excel: 'YEARLY INCOME', label: 'Yearly Income', format: 'currency' },
  ],
  unitBreakout: [] as any[],
  owner: [] as any[],
  broker: [] as any[],
  leasingCompany: [] as any[],
  seller: [] as any[],
  lender: [] as any[],
  comments: { excel: 'M1', label: 'Comments' }
};

// Helper function to truncate text to fit within a width
// Excel PROPER()-equivalent: capitalize the first letter after every non-letter boundary,
// lowercase the rest. Matches Excel's actual behavior (including its well-known quirk of also
// capitalizing the letter right after an apostrophe, e.g. "MCDONALD'S" -> "Mcdonald'S") rather
// than a "smarter" version, since that's explicitly what was asked for. Only meant for
// person/company/place names pulled straight from the source data — never call this on the
// free-text Comments field, which keeps its own raw formatting.
function properCase(s: string): string {
  return s.toLowerCase().replace(/\p{L}+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

function truncateText(text: string, maxWidth: number, font: any, fontSize: number): string {
  if (!text) return '';
  
  let truncated = text;
  let width = font.widthOfTextAtSize(truncated, fontSize);
  
  // If text fits, return as is
  if (width <= maxWidth) return truncated;
  
  // Otherwise, truncate and add ellipsis
  while (width > maxWidth && truncated.length > 0) {
    truncated = truncated.slice(0, -1);
    width = font.widthOfTextAtSize(truncated + '...', fontSize);
  }
  
  return truncated + '...';
}

// HTML Template Generator for Property Reports
// Railway's Nix Chromium ships without system fonts, so the report embeds its own — and this
// also matters in a normal browser (e.g. Blake viewing /api/reports/:id/view directly): CSS
// asked for font-weight: 600 on some elements (.field-value) but only 400 and 700 were ever
// registered, so a viewer had to guess/synthesize the missing weight, which can render
// inconsistently depending on browser and OS. Registering the same two files again at 500 and
// 600 makes every weight actually used in these templates (400, 600, 700) resolve to an exact,
// explicit face — no synthesis, no guessing, no per-browser variation.
let fontCssCache: string | null = null;
function embeddedFontCss(): string {
  if (fontCssCache !== null) return fontCssCache;
  const dir = path.join(__dirname, '../fonts');
  const face = (file: string, weight: number) => {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return '';
    const b64 = fs.readFileSync(p).toString('base64');
    return `@font-face { font-family: 'Inter'; font-weight: ${weight}; src: url(data:font/ttf;base64,${b64}) format('truetype'); }`;
  };
  const regular = face('LiberationSans-Regular.ttf', 400) + face('LiberationSans-Regular.ttf', 500);
  const bold = face('LiberationSans-Bold.ttf', 600) + face('LiberationSans-Bold.ttf', 700);
  fontCssCache = regular + bold;
  return fontCssCache;
}

let logoCache: string | null = null;
function reportBrand(): string {
  if (logoCache === null) {
    const p = path.join(__dirname, '../fonts/databank-logo.png');
    logoCache = fs.existsSync(p) ? `<img class="logo" src="data:image/png;base64,${fs.readFileSync(p).toString('base64')}" alt="Databank">` : '<b>DATABANK ATLANTA</b>';
  }
  return logoCache;
}
const BRAND_CSS = '.brand .logo { height: 34px; display: block; }';

function generatePropertyReportHTML(properties: any[], fieldMapping: any): string {
  const propertiesHTML = properties.map((prop, index) => `
    <div class="property-page">
      <div class="property-header">
        <h2 class="property-title">${prop.propertyName || `Property ${index + 1}`}</h2>
      </div>

      <div class="section">
        <h3 class="section-title">Property Profile</h3>
        <div class="two-column">
          ${prop.profileFields.map((field: any) => `
            <div class="field">
              <span class="field-label">${field.label}:</span>
              <span class="field-value">${field.value || '-'}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="section">
        <h3 class="section-title">Property Details</h3>
        <div class="two-column">
          ${prop.detailsFields.map((field: any) => `
            <div class="field">
              <span class="field-label">${field.label}:</span>
              <span class="field-value">${field.value || '-'}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="section">
        <h3 class="section-title">Financial Highlights</h3>
        <div class="two-column">
          ${prop.financialFields.map((field: any) => `
            <div class="field">
              <span class="field-label">${field.label}:</span>
              <span class="field-value">${field.value || '-'}</span>
            </div>
          `).join('')}
        </div>
      </div>

      ${prop.comments ? `
        <div class="section">
          <h3 class="section-title">Comments</h3>
          <div class="comments">${prop.comments}</div>
        </div>
      ` : ''}
    </div>
  `).join('');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Databank Property Reports</title>
      <style>
        ${embeddedFontCss()}
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        body {
          font-family: 'Inter', 'Liberation Sans', 'Segoe UI', 'Helvetica Neue', 'Arial', sans-serif;
          font-size: 11pt;
          line-height: 1.6;
          color: #1e293b;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }

        .toc-page {
          page-break-after: always;
          padding: 60px 50px;
          background: white;
          min-height: 100vh;
          position: relative;
        }

        .toc-page::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 200px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          z-index: 0;
        }

        .main-title {
          font-size: 42pt;
          font-weight: 700;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          margin-bottom: 10px;
          position: relative;
          z-index: 1;
          color: white;
          -webkit-text-fill-color: white;
        }

        .subtitle {
          font-size: 18pt;
          color: white;
          margin-bottom: 50px;
          font-weight: 400;
          position: relative;
          z-index: 1;
        }

        .toc-title {
          font-size: 28pt;
          font-weight: 700;
          color: #1e293b;
          margin-bottom: 10px;
          position: relative;
          z-index: 1;
        }

        .toc-count {
          font-size: 14pt;
          color: #64748b;
          margin-bottom: 30px;
          font-weight: 600;
          position: relative;
          z-index: 1;
          padding: 8px 16px;
          background: #f1f5f9;
          border-radius: 6px;
          display: inline-block;
        }

        .toc-item {
          padding: 12px 16px;
          font-size: 11pt;
          color: #475569;
          background: #f8fafc;
          margin-bottom: 8px;
          border-radius: 8px;
          border-left: 4px solid #667eea;
          transition: all 0.2s;
          position: relative;
          z-index: 1;
        }

        .toc-item:hover {
          background: #f1f5f9;
          transform: translateX(4px);
        }

        .property-page {
          page-break-after: always;
          padding: 40px;
          background: white;
          min-height: 100vh;
        }

        .property-header {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          padding: 25px 30px;
          margin: -40px -40px 30px -40px;
          border-radius: 0;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }

        .property-title {
          font-size: 24pt;
          font-weight: 700;
          color: white;
          text-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }

        .section {
          margin-bottom: 30px;
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 20px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
        }

        .section:nth-child(even) {
          background: #f8fafc;
        }

        .section-title {
          font-size: 14pt;
          font-weight: 700;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          margin-bottom: 18px;
          padding-bottom: 10px;
          border-bottom: 3px solid #e2e8f0;
          display: flex;
          align-items: center;
        }

        .section-title::before {
          content: '▸';
          margin-right: 8px;
          color: #667eea;
        }

        .two-column {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px 30px;
        }

        .field {
          display: flex;
          flex-direction: column;
          padding: 10px 12px;
          background: white;
          border-radius: 6px;
          border: 1px solid #e2e8f0;
          transition: all 0.2s;
        }

        .section:nth-child(even) .field {
          background: #ffffff;
        }

        .field:hover {
          border-color: #667eea;
          box-shadow: 0 2px 4px rgba(102, 126, 234, 0.1);
        }

        .field-label {
          font-size: 8.5pt;
          color: #64748b;
          font-weight: 700;
          margin-bottom: 4px;
          text-transform: uppercase;
          letter-spacing: 0.8px;
        }

        .field-value {
          font-size: 10.5pt;
          color: #1e293b;
          font-weight: 600;
        }

        .comments {
          background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
          border: 2px solid #e2e8f0;
          border-radius: 12px;
          padding: 20px;
          font-size: 10pt;
          color: #475569;
          line-height: 1.8;
          white-space: pre-wrap;
          box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.05);
        }

        @media print {
          .property-page, .toc-page {
            page-break-after: always;
          }
          body {
            background: white;
          }
        }
      </style>
    </head>
    <body>
      <div class="toc-page">
        <h1 class="main-title">Databank</h1>
        <p class="subtitle">Property Reports</p>
        <h2 class="toc-title">Table of Contents</h2>
        <p class="toc-count">${properties.length} Properties</p>
        ${properties.map((prop, index) => `
          <div class="toc-item">${index + 1}. ${prop.propertyName || `Property ${index + 1}`}</div>
        `).join('')}
      </div>
      ${propertiesHTML}
    </body>
    </html>
  `;
}

// Middleware
app.set('trust proxy', 1);
// Standard security headers (HSTS, nosniff, frame and referrer policy). No content security
// policy yet: the pages load Google Fonts, Google Maps embeds and inline styles, which need a
// tested allowlist first.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, referrerPolicy: { policy: 'strict-origin-when-cross-origin' } }));
// Restricted to known domains rather than reflecting any origin (a Sep 25 security review
// flagged cors({ origin: true }) as letting any website make credentialed requests on a
// logged-in user's behalf). ALLOWED_ORIGINS lets this be extended without a code change once
// the site moves off the railway.app subdomain onto its own domain.
const DEFAULT_ORIGINS = [
  'https://databanknew-production.up.railway.app',
  'https://databankinfo.com',
  'https://www.databankinfo.com',
  'http://localhost:5173',
  'http://localhost:3000',
];
const allowedOrigins = new Set([
  ...DEFAULT_ORIGINS,
  ...(process.env.APP_URL ? [new URL(process.env.APP_URL).origin] : []),
  ...(process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
]);
app.use(cors({
  origin: (origin, cb) => {
    // No Origin header = same-origin/non-browser request. An unknown origin gets no CORS
    // headers (so the browser blocks cross-site reads) rather than an error, which would 500
    // the site's own scripts and styles whenever it's served from a domain not listed here.
    cb(null, !origin || allowedOrigins.has(origin));
  },
  credentials: true,
}));
app.use(express.json({ limit: '20mb' }));
registerAuthRoutes(app, db);

// Current search results -> .xlsx. The browser already holds the filtered rows, so it sends them
// as { columns: [{key,label}], rows: [{key: value}] } and gets a workbook back.
app.post('/api/export/xlsx', requireUser, rateLimit(60, 'Export limit reached ({n} an hour)'), (req: Request, res: Response) => {
  const { columns, rows, filename } = req.body as {
    columns?: { key: string; label: string }[];
    rows?: Record<string, string | number | null>[];
    filename?: string;
  };
  if (!Array.isArray(columns) || !columns.length || !Array.isArray(rows)) {
    return res.status(400).json({ error: 'columns and rows are required' });
  }
  if (rows.length > 20000) return res.status(413).json({ error: 'Too many rows to export at once (max 20,000)' });

  const header = columns.map((c) => c.label);
  const body = rows.map((r) => columns.map((c) => {
    const v = r[c.key];
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') return v;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return /^[\s$,\d.-]+$/.test(String(v)) && Number.isFinite(n) ? n : v;
  }));
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  // Dollar signs and commas in Excel itself (Blake, Sep 24), keeping the cells numeric so they
  // still sort and sum. Chosen by column key; years, zips and dates are left as they are.
  const numFmt = (key: string) =>
    /perunit/i.test(key) ? '$#,##0.00' : /price|loan|amount|volume/i.test(key) ? '$#,##0' : /acres/i.test(key) ? '#,##0.##' : /units|sqft|sq_?ft/i.test(key) ? '#,##0' : null;
  columns.forEach((c, ci) => {
    const z = numFmt(c.key);
    if (!z) return;
    for (let ri = 1; ri <= body.length; ri++) {
      const cell = ws[XLSX.utils.encode_cell({ r: ri, c: ci })];
      if (cell && cell.t === 'n') cell.z = z;
    }
  });
  ws['!cols'] = columns.map((c, i) => ({
    wch: Math.min(60, Math.max(c.label.length, ...body.slice(0, 200).map((r) => String(r[i] ?? '').length)) + 2),
  }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: body.length, c: columns.length - 1 } }) };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Properties');
  const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const safe = String(filename || 'databank-export').replace(/[^\w.-]+/g, '-').slice(0, 80);
  recordUsage(req, { kind: 'export', detail: safe, rows: rows.length, databaseType: safe.split('-')[1] });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.xlsx"`);
  res.send(buf);
});

// Feedback from testers: anyone can post, only admins can read.
// Added after the table already existed in production — guarded migrations, not part of the
// CREATE TABLE above, same pattern as users.ts. Must run before the prepare() calls below,
// since prepare() fails immediately if a referenced column doesn't exist yet.
for (const col of [
  'email TEXT', 'screenshot BLOB', 'replied INTEGER NOT NULL DEFAULT 0',
  "status TEXT NOT NULL DEFAULT 'pending'", 'resolution TEXT',
  "source TEXT NOT NULL DEFAULT 'website'",
]) {
  try { db.exec(`ALTER TABLE feedback ADD COLUMN ${col}`); } catch { /* already added */ }
}
const insertFeedbackStmt: any = db.prepare(`INSERT INTO feedback (message, contact, page, database_type, email, screenshot, source) VALUES (?, ?, ?, ?, ?, ?, 'website')`);
const insertManualFeedbackStmt: any = db.prepare(`INSERT INTO feedback (message, contact, page, database_type, source, status, resolution) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const listFeedbackStmt: any = db.prepare(`SELECT id, message, contact, page, database_type, email, replied, status, resolution, source, created_date, screenshot IS NOT NULL as has_screenshot FROM feedback ORDER BY (status = 'pending') DESC, created_date DESC LIMIT 500`);
const deleteFeedbackStmt: any = db.prepare(`DELETE FROM feedback WHERE id = ?`);
const getFeedbackScreenshotStmt: any = db.prepare(`SELECT screenshot FROM feedback WHERE id = ?`);
const setFeedbackRepliedStmt: any = db.prepare(`UPDATE feedback SET replied = ? WHERE id = ?`);
const setFeedbackStatusStmt: any = db.prepare(`UPDATE feedback SET status = ?, resolution = ? WHERE id = ?`);

app.post('/api/feedback', rateLimit(20, 'Feedback limit reached ({n} an hour)'), (req: Request, res: Response) => {
  const { message, contact, page, database_type, screenshot } = req.body as Record<string, unknown>;
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return res.status(400).json({ error: 'message is required' });
  if (text.length > 4000) return res.status(400).json({ error: 'message too long (4,000 characters max)' });
  const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : null);
  // Once someone's logged in, their email is attached automatically — no more asking for
  // "your name or email (optional)" and hoping they fill it in.
  const email = currentUserEmail(req);
  let screenshotBuf: Buffer | null = null;
  if (typeof screenshot === 'string' && screenshot.startsWith('data:image/')) {
    const b64 = screenshot.split(',')[1] || '';
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'Screenshot is too large (8MB max).' });
    screenshotBuf = buf;
  }
  const info = insertFeedbackStmt.run(text, clip(contact, 200), clip(page, 200), clip(database_type, 40), email, screenshotBuf);
  const id = Number(info.lastInsertRowid);
  res.json({ ok: true, id });
  sendFeedbackMail({ id, message: text, contact: email || clip(contact, 200), page: clip(page, 200), databaseType: clip(database_type, 40) })
    .catch((e: unknown) => console.error('Feedback email failed:', e instanceof Error ? e.message : e));
});

app.get('/api/feedback', requireAdmin, (_req: Request, res: Response) => {
  res.json(listFeedbackStmt.all());
});

// Logging a call or other non-website source Blake heard feedback through, so it lands in the
// same list/changelog as what comes through the site's own Feedback button.
app.post('/api/feedback/manual', requireAdmin, (req: Request, res: Response) => {
  const { message, contact, page, source } = req.body as Record<string, unknown>;
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return res.status(400).json({ error: 'message is required' });
  const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : null);
  const src = source === 'call' ? 'call' : 'other';
  const info = insertManualFeedbackStmt.run(text.slice(0, 4000), clip(contact, 200), clip(page, 200), null, src, 'pending', null);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

app.get('/api/feedback/:id/screenshot', requireAdmin, (req: Request, res: Response) => {
  const row = getFeedbackScreenshotStmt.get(Number(req.params.id)) as { screenshot: Buffer | null } | undefined;
  if (!row?.screenshot) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.send(row.screenshot);
});

app.post('/api/feedback/:id/replied', requireAdmin, (req: Request, res: Response) => {
  const replied = req.body?.replied ? 1 : 0;
  setFeedbackRepliedStmt.run(replied, Number(req.params.id));
  res.json({ ok: true, replied: Boolean(replied) });
});

// status: 'pending' | 'solved'. resolution: free text — what actually changed in response to
// this item, so the list doubles as a changelog rather than just a read/unread marker.
app.post('/api/feedback/:id/status', requireAdmin, (req: Request, res: Response) => {
  const status = req.body?.status === 'solved' ? 'solved' : 'pending';
  const resolution = typeof req.body?.resolution === 'string' ? req.body.resolution.trim().slice(0, 4000) : null;
  setFeedbackStatusStmt.run(status, resolution, Number(req.params.id));
  res.json({ ok: true, status, resolution });
});

app.delete('/api/feedback/:id', requireAdmin, (req: Request, res: Response) => {
  deleteFeedbackStmt.run(Number(req.params.id));
  res.json({ ok: true });
});

// Nixpacks installs Chromium into /nix/store (on PATH), not at the /usr/bin path in
// PUPPETEER_EXECUTABLE_PATH; fall back to whatever `chromium` resolves to.
function chromiumPath(): string | undefined {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const candidate = path.join(dir, name);
      if (dir && fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

// One Chromium shared by every PDF route (it used to start a new one per report), and at most
// MAX_PDF_RENDERS pages rendering at once so a busy moment can't exhaust the server's memory.
// launchBrowser() hands out a handle; close() closes only that request's pages and frees its slot.
const MAX_PDF_RENDERS = 3;
let sharedBrowser: Promise<Browser> | null = null;
let activeRenders = 0;
const renderQueue: (() => void)[] = [];

function getSharedBrowser(): Promise<Browser> {
  if (!sharedBrowser) {
    const launching = puppeteer.launch({
      headless: true,
      executablePath: chromiumPath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    sharedBrowser = launching;
    launching.then((b) => b.on('disconnected', () => { if (sharedBrowser === launching) sharedBrowser = null; }))
      .catch(() => { if (sharedBrowser === launching) sharedBrowser = null; });
  }
  return sharedBrowser;
}

async function launchBrowser(): Promise<{ newPage: () => Promise<Page>; close: () => Promise<void> }> {
  if (activeRenders >= MAX_PDF_RENDERS) await new Promise<void>((resolve) => renderQueue.push(resolve));
  activeRenders++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(safety);
    activeRenders--;
    renderQueue.shift()?.();
  };
  const safety = setTimeout(release, 3 * 60 * 1000); // a route that throws before close() can't hold a slot forever
  const pages: Page[] = [];
  try {
    const browser = await getSharedBrowser();
    return {
      newPage: async () => { const page = await browser.newPage(); pages.push(page); return page; },
      close: async () => {
        try { await Promise.all(pages.map((pg) => pg.close().catch(() => undefined))); } finally { release(); }
      },
    };
  } catch (e) {
    release();
    throw e;
  }
}

const ASK_AI_PER_HOUR = Number(process.env.ASK_AI_PER_HOUR) || 30;

// One-page property report PDF for customers (same facts as /api/dropbox/report).
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const money = (v: string) => { const n = Number(v); return v && !Number.isNaN(n) ? '$' + Math.round(n).toLocaleString('en-US') : v || '—'; };
const num = (v: string) => { const n = Number(v); return v && !Number.isNaN(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v || '—'; };
const longDate = (iso: string) => { const d = new Date(iso.length === 10 ? iso + 'T12:00:00Z' : iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };

function propertyReportHtml(r: dropboxAsk.PropertyReport, media: { photo: Buffer | null; map: Buffer | null }, preparedFor: string | null): string {
  const isLand = r.type === 'LANDSALE';
  const noStreetNumber = isLand && !!r.address && !/^\d/.test(r.address.trim());
  const addressLine = noStreetNumber ? `Land on ${r.address}` : r.address;
  const where = [addressLine, r.city, r.county ? `${r.county} County` : '', r.zip].filter(Boolean).join(', ');
  const last = r.saleList[r.saleList.length - 1];
  const sales = [...r.saleList].reverse();
  const owners = [...r.ownerTrail].reverse();
  const isMoney = (label: string) => /price/i.test(label);
  const isDateFact = (label: string) => /published|date/i.test(label);
  // Land parcels don't have a building, so a "Built"/"Year built" fact on a land record is
  // confusing at best (and was showing a construction year years after a land-only sale).
  const shownFacts = isLand ? r.facts.filter((f) => !/built/i.test(f.label)) : r.facts;
  const factValue = (f: { label: string; value: string }) =>
    isMoney(f.label) ? money(f.value) : isDateFact(f.label) ? longDate(f.value) : /built/i.test(f.label) ? f.value : num(f.value);
  const facts = shownFacts.map((f) => `<div class="fact"><div class="k">${esc(f.label)}</div><div class="v">${esc(factValue(f))}</div></div>`).join('');
  const sameOwner = !!last && !!last.buyer && last.buyer.toUpperCase() === last.seller.toUpperCase();
  const lede = last
    ? (sameOwner
      ? `${esc(r.name)} was last recorded on ${esc(longDate(last.date))}${last.price ? ` at ${money(last.price)}` : ''}, staying with ${esc(last.buyer)} (a transfer or refinancing, not a change of owner). `
      : `${esc(r.name)} last sold on ${esc(longDate(last.date))}${last.price ? ` for ${money(last.price)}` : ' (price not on record)'}${last.buyer ? ` to ${esc(last.buyer)}` : ''}${last.seller ? `, purchased from ${esc(last.seller)}` : ''}. `) +
      (r.saleList.length > 1 ? `Databank has ${r.saleList.length} sales on record for this property. ` : '') +
      (owners.length > 1 ? `It has had ${owners.length} owners since Databank started tracking it in ${longDate(r.first)}.` : '')
    : `${esc(r.name)} is owned by ${esc(r.owner || 'an unrecorded owner')}. Databank has no sale on record for it.`;
  const photoUri = media.photo ? `data:image/jpeg;base64,${media.photo.toString('base64')}` : null;
  const mapUri = media.map ? `data:image/png;base64,${media.map.toString('base64')}` : null;
  const mediaHtml = photoUri || mapUri
    ? `<div class="media">${photoUri ? `<div class="shot"><img src="${photoUri}" alt="Street view"><div class="cap">Street view</div><div class="note">From Google, matched by address — may not show the exact property or its current condition.</div></div>` : ''}${mapUri ? `<div class="shot"><img src="${mapUri}" alt="Map"><div class="cap">Location</div></div>` : ''}</div>`
    : '';
  const mapsLink = where ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(where)}` : null;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.name || 'Databank property report')}</title><style>
    ${embeddedFontCss()}
    * { box-sizing: border-box; } body { font-family: Inter, Arial, sans-serif; color: #111827; margin: 0; padding: 40px 44px; font-size: 12.5px; line-height: 1.5; }
    .brand { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #1e3a8a; padding-bottom: 8px; margin-bottom: 18px; } ${BRAND_CSS}
    .brand b { font-size: 15px; color: #1e3a8a; letter-spacing: .01em; } .brand span { color: #6b7280; font-size: 11px; }
    h1 { font-size: 24px; margin: 0 0 2px; } .sub { color: #4b5563; margin-bottom: 4px; } .former { color: #6b7280; font-size: 11.5px; margin-bottom: 14px; }
    .lede { background: #eff6ff; border-left: 4px solid #1e3a8a; padding: 10px 14px; font-size: 14px; margin: 14px 0 20px; }
    .media { display: flex; gap: 14px; margin: 14px 0 20px; } .shot { flex: 1; } .shot img { width: 100%; height: 160px; object-fit: cover; border-radius: 8px; border: 1px solid #e5e7eb; display: block; } .shot .cap { font-size: 10px; text-transform: uppercase; letter-spacing: .01em; color: #6b7280; margin-top: 4px; } .shot .note { font-size: 9.5px; color: #9ca3af; margin-top: 1px; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .01em; color: #1e3a8a; margin: 20px 0 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
    .facts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 16px; } .fact .k { color: #6b7280; font-size: 10.5px; text-transform: uppercase; letter-spacing: .01em; } .fact .v { font-weight: 700; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; } th { text-align: left; color: #6b7280; font-size: 10.5px; text-transform: uppercase; letter-spacing: .01em; padding: 4px 8px 4px 0; border-bottom: 1px solid #e5e7eb; }
    td { padding: 6px 8px 6px 0; border-bottom: 1px solid #f3f4f6; vertical-align: top; } td.n { white-space: nowrap; } .muted { color: #6b7280; } .tag { font-size: 10.5px; color: #92400e; background: #fef3c7; border-radius: 999px; padding: 1px 8px; margin-left: 8px; vertical-align: middle; }
    .foot { margin-top: 28px; color: #6b7280; font-size: 10.5px; border-top: 1px solid #e5e7eb; padding-top: 8px; }
    .foot .protect { margin-bottom: 3px; }
  </style></head><body>
    <div class="brand">${reportBrand()}<span>Property report · ${esc(longDate(new Date().toISOString().slice(0, 10)))}</span></div>
    <h1>${esc(r.name || '(unnamed property)')}${r.removed ? `<span class="tag">no longer on the current list</span>` : ''}</h1>
    <div class="sub">${esc(where)}${r.parcel ? ` · Parcel ${esc(r.parcel)}` : ''}${mapsLink ? ` · <a href="${mapsLink}" style="color:#1e3a8a;">View on Google Maps</a>` : ''}</div>
    ${r.formerNames.length ? `<div class="former">Formerly known as ${esc(r.formerNames.join(', '))}</div>` : ''}
    <div class="lede">${lede}</div>
    ${mediaHtml}
    ${facts ? `<h2>About the property</h2><div class="facts">${facts}</div>` : ''}
    <h2>Ownership</h2>
    <p><b>Current owner:</b> ${esc(r.owner || '—')}</p>
    ${owners.length > 1 ? `<table><tr><th>Since</th><th>Owner</th></tr>${owners.map((o, i) => `<tr><td class="n">${i === owners.length - 1 ? `by ${esc(longDate(o.week))}` : esc(longDate(o.week))}</td><td>${esc(o.value)}</td></tr>`).join('')}</table>
      <p class="muted">"by" = already the owner when Databank's weekly tracking of this property began.</p>` : ''}
    <h2>Sales on record</h2>
    ${sales.length ? `<table><tr><th>Date</th><th>Price</th><th>Buyer</th><th>Seller</th></tr>${sales.map((s) => `<tr><td class="n">${esc(s.date)}</td><td class="n">${esc(money(s.price))}</td><td>${esc(s.buyer || '—')}</td><td>${esc(s.seller || '—')}</td></tr>`).join('')}</table>` : '<p class="muted">No sale recorded.</p>'}
    <h2>Contacts</h2>
    ${r.contacts.length ? `<table>${r.contacts.map((c) => `<tr><td class="n">${esc(c.label)}</td><td>${esc(c.value) || '—'}</td></tr>`).join('')}</table>` : '<p class="muted">No additional contacts on record.</p>'}
    <h2>Financing</h2>
    ${r.loan || r.lender || r.broker
      ? `<p>${r.loan ? `<b>Loan:</b> ${esc(money(r.loan))}` : ''}${r.lender ? ` &nbsp; <b>Lender:</b> ${esc(r.lender)}` : ''}${r.broker ? ` &nbsp; <b>Broker:</b> ${esc(r.broker)}` : ''}</p>`
      : '<p class="muted">No financing recorded.</p>'}
    ${r.comments ? `<h2>Research notes</h2><p>${esc(r.comments)}</p>` : ''}
    <div class="foot">
      ${preparedFor ? `<div class="protect">Prepared for ${esc(preparedFor)} · For internal use — not for redistribution</div>` : ''}
      <div>Source: Databank Atlanta research. www.databankinfo.com · (404) 872-8880 · © ${new Date().getFullYear()} Databank Atlanta</div>
      <div>Report ID: ${esc(r.type)}-${esc(r.id)}-${new Date().toISOString().slice(0, 10)}</div>
    </div>
  </body></html>`;
}

app.get('/api/dropbox/report.pdf', requireUser, rateLimit(60, 'Report limit reached ({n} an hour)'), async (req: Request, res: Response) => {
  const type = typeof req.query.type === 'string' ? req.query.type : '';
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!/^[A-Z0-9]{1,12}$/.test(type) || !/^[A-Z0-9-]{1,32}$/.test(id)) return res.status(400).json({ error: 'type and id are required' });
  try {
    const r = await dropboxAsk.propertyReport(type, id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const dbInfo = DATABASES.find((d) => d.type === type);
    const photo = getApprovedPhoto(db, r.address, r.city, r.zip);
    const map = await fetchStaticMap(r.address, r.city, r.zip).catch(() => null);
    if (!photo) queuePhotoIfMissing(db, { name: r.name, address: r.address, city: r.city, zip: r.zip, databaseType: dbInfo?.id ?? type });
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setContent(propertyReportHtml(r, { photo, map }, currentUserEmail(req)), { waitUntil: 'load' });
      const pdf = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
      const slug = (r.name || r.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 50);
      recordUsage(req, { kind: 'pdf', detail: r.name || r.id, databaseType: dbInfo?.id });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="databank-${slug || 'property'}.pdf"`);
      res.send(Buffer.from(pdf));
    } finally {
      await browser.close();
    }
  } catch (e) {
    console.error('Property report PDF failed:', e);
    res.status(502).json({ error: e instanceof Error ? e.message : 'Report failed' });
  }
});

// Market snapshot PDF: the Dashboard's tiles and breakdowns, computed in the browser
// (already filtered the way the customer sees them) and rendered here as one page.
type SnapshotRow = { label: string; value: string; extra?: string };
type SnapshotSection = { title: string; note?: string; rows: SnapshotRow[] };
type Snapshot = { database: string; scope: string; period: string; source: string; tiles: SnapshotRow[]; sections: SnapshotSection[] };

function parseSnapshot(b: unknown): Snapshot | null {
  if (!b || typeof b !== 'object') return null;
  const o = b as Record<string, unknown>;
  const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '');
  const rows = (v: unknown, max: number): SnapshotRow[] =>
    Array.isArray(v) ? v.slice(0, max).map((r) => { const x = (r || {}) as Record<string, unknown>; return { label: str(x.label), value: str(x.value), extra: str(x.extra) || undefined }; }) : [];
  const sections = Array.isArray(o.sections)
    ? o.sections.slice(0, 8).map((s) => { const x = (s || {}) as Record<string, unknown>; return { title: str(x.title), note: str(x.note) || undefined, rows: rows(x.rows, 15) }; })
    : [];
  return { database: str(o.database), scope: str(o.scope), period: str(o.period), source: str(o.source), tiles: rows(o.tiles, 8), sections };
}

function snapshotHtml(s: Snapshot): string {
  const tiles = s.tiles.map((t) => `<div class="tile"><div class="k">${esc(t.label)}</div><div class="v">${esc(t.value)}</div></div>`).join('');
  const sections = s.sections.filter((x) => x.rows.length).map((x) => `<section><h2>${esc(x.title)}</h2>${x.note ? `<p class="muted">${esc(x.note)}</p>` : ''}<table>${x.rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="n">${esc(r.value)}</td>${r.extra ? `<td class="n green">${esc(r.extra)}</td>` : '<td></td>'}</tr>`).join('')}</table></section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${embeddedFontCss()}
    * { box-sizing: border-box; } body { font-family: Inter, Arial, sans-serif; color: #111827; margin: 0; padding: 40px 44px; font-size: 12px; line-height: 1.45; }
    .brand { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #1e3a8a; padding-bottom: 8px; margin-bottom: 18px; } ${BRAND_CSS}
    .brand b { font-size: 15px; color: #1e3a8a; letter-spacing: .04em; } .brand span { color: #6b7280; font-size: 11px; }
    h1 { font-size: 22px; margin: 0 0 2px; } .sub { color: #4b5563; margin-bottom: 16px; }
    .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 8px; } .tile { background: #eff6ff; border-radius: 10px; padding: 10px 12px; }
    .tile .k { color: #1e3a8a; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; } .tile .v { font-weight: 700; font-size: 18px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 28px; } section { break-inside: avoid; }
    h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #1e3a8a; margin: 18px 0 6px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; } td { padding: 4px 6px 4px 0; border-bottom: 1px solid #f3f4f6; } td.n { white-space: nowrap; text-align: right; font-weight: 600; color: #374151; } td.green { color: #047857; }
    .muted { color: #6b7280; font-size: 10.5px; margin: 0 0 4px; }
    .foot { margin-top: 24px; color: #6b7280; font-size: 10.5px; border-top: 1px solid #e5e7eb; padding-top: 8px; }
  </style></head><body>
    <div class="brand">${reportBrand()}<span>Market snapshot · ${esc(longDate(new Date().toISOString().slice(0, 10)))}</span></div>
    <h1>${esc(s.database)} — ${esc(s.scope || 'All properties')}</h1>
    <div class="sub">${esc(s.period)}</div>
    ${tiles ? `<div class="tiles">${tiles}</div>` : ''}
    <div class="grid">${sections}</div>
    <div class="foot">Source: ${esc(s.source || 'Databank Atlanta weekly research files')}. www.databankinfo.com · (404) 872-8880</div>
  </body></html>`;
}

app.post('/api/market-snapshot.pdf', requireUser, rateLimit(60, 'Report limit reached ({n} an hour)'), async (req: Request, res: Response) => {
  const s = parseSnapshot(req.body);
  if (!s || !s.database) return res.status(400).json({ error: 'snapshot is required' });
  try {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setContent(snapshotHtml(s), { waitUntil: 'load' });
      const pdf = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
      const slug = `${s.database} ${s.scope}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 50);
      recordUsage(req, { kind: 'pdf', detail: `snapshot: ${s.database} ${s.scope}`.trim(), databaseType: s.database.toLowerCase() });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="databank-snapshot-${slug || 'market'}.pdf"`);
      res.send(Buffer.from(pdf));
    } finally {
      await browser.close();
    }
  } catch (e) {
    console.error('Market snapshot PDF failed:', e);
    res.status(502).json({ error: e instanceof Error ? e.message : 'Report failed' });
  }
});

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB — weekly Insider files are a few MB; this is headroom, not a soft cap

// Create uploads directory if it doesn't exist
const uploadDir = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads') : path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Health check endpoint
app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Get available insider dates from Excel file
app.post('/api/dates', requireAdmin, upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Read the Excel file
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

    if (jsonData.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty' });
    }

    // Find the "Insider Date" column index
    const headers = jsonData[0] as string[];
    console.log('Available headers:', headers);
    
    // First try to find exact match "INSIDER DATE"
    let dateColumnIndex = headers.findIndex(h => 
      h && h.toLowerCase().trim() === 'insider date'
    );
    
    // If not found, try partial match (but exclude "previous")
    if (dateColumnIndex === -1) {
      dateColumnIndex = headers.findIndex(h => 
        h && h.toLowerCase().includes('insider') && 
        h.toLowerCase().includes('date') &&
        !h.toLowerCase().includes('previous')
      );
    }

    if (dateColumnIndex === -1) {
      console.log('No "Insider Date" column found. Headers:', headers);
      return res.status(400).json({ error: 'No "Insider Date" column found in Excel file' });
    }
    
    console.log(`Found "Insider Date" column at index ${dateColumnIndex}: "${headers[dateColumnIndex]}"`);

    // Extract unique dates with counts
    const dateMap = new Map<string, number>();
    
    for (let i = 1; i < jsonData.length; i++) {
      const row = jsonData[i];
      if (Array.isArray(row) && row[dateColumnIndex] !== undefined && row[dateColumnIndex] !== null) {
        let dateValue = row[dateColumnIndex];
        
        // Log first few values for debugging
        if (i <= 3) {
          console.log(`Row ${i} date value (raw):`, dateValue, `Type: ${typeof dateValue}`);
        }
        
        // Check if it's an Excel date serial number
        if (typeof dateValue === 'number') {
          // Convert Excel serial date to JavaScript Date
          const excelDate = XLSX.SSF.parse_date_code(dateValue);
          if (excelDate) {
            // Format as MM/DD/YYYY
            dateValue = `${String(excelDate.m).padStart(2, '0')}/${String(excelDate.d).padStart(2, '0')}/${excelDate.y}`;
            if (i <= 3) {
              console.log(`  Converted to: ${dateValue}`);
            }
          }
        }
        
        // Convert to string and trim
        const dateStr = String(dateValue).trim();
        if (dateStr) {
          dateMap.set(dateStr, (dateMap.get(dateStr) || 0) + 1);
        }
      }
    }
    
    console.log('Unique dates found:', Array.from(dateMap.keys()));

    // Convert to array with date and count, then sort by date (latest first)
    const dateEntries = Array.from(dateMap.entries()).map(([date, count]) => ({
      date,
      count,
      sortKey: new Date(date)
    }));
    
    // Sort by date descending (latest first)
    dateEntries.sort((a, b) => {
      // If both are valid dates, sort by date
      if (!isNaN(a.sortKey.getTime()) && !isNaN(b.sortKey.getTime())) {
        return b.sortKey.getTime() - a.sortKey.getTime();
      }
      // Otherwise, sort alphabetically descending
      return b.date.localeCompare(a.date);
    });
    
    // Return array of {date, count}
    const result = dateEntries.map(({ date, count }) => ({ date, count }));
    
    // Save to database
    try {
      const uploadId = saveUploadToDb(
        req.file.originalname,
        req.file.originalname,
        req.file.size,
        workbook.SheetNames.length,
        jsonData,
        req.body.database_type
      );
      console.log(`✅ Saved upload to database with ID: ${uploadId}`);
    } catch (dbError) {
      console.error('⚠️ Failed to save to database:', dbError);
      // Continue even if DB save fails (non-blocking)
    }
    
    res.json({ dates: result, columnIndex: dateColumnIndex });

  } catch (error) {
    console.error('Error extracting dates:', error);
    res.status(500).json({ error: 'Failed to extract dates from file' });
  }
});


// Convert Excel to PDF using HTML template (Puppeteer)
app.post('/api/convert-html', requireAdmin, upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filterDate = req.body.filterDate as string | undefined;

    // Read the Excel file
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

    if (jsonData.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty' });
    }

    // Filter data by insider date if specified
    let filteredData = jsonData;
    if (filterDate) {
      const headers = jsonData[0] as string[];
      const dateColumnIndex = headers.findIndex(h => h && h.toLowerCase().trim() === 'insider date');
      
      if (dateColumnIndex >= 0) {
        const dataRows = jsonData.slice(1).filter(row => {
          if (!Array.isArray(row)) return false;
          let cellValue = row[dateColumnIndex];
          if (cellValue === undefined || cellValue === null) return false;
          
          // Convert Excel serial date to formatted string if needed
          if (typeof cellValue === 'number') {
            const excelDate = XLSX.SSF.parse_date_code(cellValue);
            if (excelDate) {
              cellValue = `${String(excelDate.m).padStart(2, '0')}/${String(excelDate.d).padStart(2, '0')}/${excelDate.y}`;
            }
          }
          
          const cellStr = String(cellValue).trim();
          return cellStr === filterDate || cellStr.includes(filterDate);
        });
        
        filteredData = [headers, ...dataRows];
      }
    }

    const headers = filteredData[0] as string[];
    const dataRows = filteredData.slice(1);

    // Field mapping configuration
    const FIELD_MAPPING = {
      propertyProfile: [
        { excel: 'P NAME', label: 'Property Name' },
        { excel: 'P STREET NUMBER', label: 'Address', concat: 'P STREET NAME' },
        { excel: 'P CITY', label: 'City' },
        { excel: 'COUNTY', label: 'County' },
        { excel: 'MARKET AREA', label: 'Market Area' },
        { excel: 'P ZIP', label: 'Zip' },
        { excel: 'DISTRICT2', label: 'District' },
        { excel: 'P CROSS STREET NAME', label: 'Cross Road' },
        { excel: 'PARCEL', label: 'Parcel' },
      ],
      propertyDetails: [
        { excel: 'INSIDER DATE', label: 'Insider Date' },
        { excel: 'P TYPE', label: 'Insider Description' },
        { excel: 'UNITS COMPLETED', label: 'Units / $ Unit', concat: '$ UNIT PROJECT', format: 'units' },
        { excel: 'TAX OWNER', label: 'Tax Owner' },
        { excel: 'ONSITE PHONE', label: 'Onsite Telephone' },
        { excel: '# ACRES', label: 'Acres / $ Per Acre', concat: '$ ACRE', format: 'acres' },
        { excel: 'HEATED SF', label: 'Square Ft' },
        { excel: '$ LOAN', label: 'Loan Amount', format: 'currency' },
        { excel: 'ATTORNEY', label: 'Attorney Name' },
        { excel: 'ATTORNEY PHONE', label: 'Attorney Telephone' },
      ],
      financialHighlights: [
        { excel: 'SALE PRICE', label: 'Property Sale Amount', format: 'currency' },
        { excel: 'SALE DATE', label: 'Property Sale Date' },
        { excel: 'LAND SALE PRICE', label: 'Land Sale Amount', format: 'currency' },
        { excel: 'LAND SALE DATE', label: 'Land Sale Date' },
        { excel: '$ EQUITY', label: 'Equity', format: 'currency' },
        { excel: '$ DOWNPAYMENT', label: 'Down Payment', format: 'currency' },
        { excel: '$ PURCHASE NOTE', label: 'Purchase Note', format: 'currency' },
        { excel: 'UTILITIES', label: 'Utility' },
        { excel: 'APPLICATION FEE', label: 'Application Fee', format: 'currency' },
        { excel: 'REFUND', label: 'Refund Amount', format: 'currency' },
        { excel: 'MONTHLY INCOME', label: 'Monthly Income', format: 'currency' },
        { excel: 'YEARLY INCOME', label: 'Yearly Income', format: 'currency' },
      ],
      unitBreakout: [] as any[],
      owner: [] as any[],
      broker: [] as any[],
      leasingCompany: [] as any[],
      seller: [] as any[],
      lender: [] as any[],
      comments: { excel: 'M1', label: 'Comments' }
    };

    // Helper functions
    const getColIndex = (colName: string) => headers.findIndex(h => h && h.trim() === colName);
    
    const getCellValue = (row: any[], colName: string) => {
      const idx = getColIndex(colName);
      if (idx === -1) return '';
      const value = row[idx];
      if (value === undefined || value === null) return '';
      
      // Convert Excel dates
      if (typeof value === 'number' && (colName.includes('DATE') || colName.includes('Date'))) {
        const excelDate = XLSX.SSF.parse_date_code(value);
        if (excelDate) {
          return `${String(excelDate.m).padStart(2, '0')}/${String(excelDate.d).padStart(2, '0')}/${excelDate.y}`;
        }
      }
      
      return colName === 'M1' ? String(value).trim() : properCase(String(value).trim());
    };

    const formatValue = (value: string, format?: string, row?: any[], concat?: string) => {
      if (!value) return '';
      
      const formatCurrencyValue = (v: string) => {
        const n = parseFloat(v.replace(/[^0-9.-]/g, ''));
        return isNaN(n) ? v : `$${Math.round(n).toLocaleString('en-US')}`;
      };
      if (concat && row) {
        const concatValue = getCellValue(row, concat);
        if (format === 'units' || format === 'acres') return concatValue ? `${value} / ${formatCurrencyValue(concatValue)}` : value;
        return `${value} ${concatValue}`.trim();
      }
      
      if (format === 'currency' && value) return formatCurrencyValue(value);
      
      return value;
    };

    // Transform data for HTML template
    const properties = dataRows.map((row, index) => {
      const profileFields = FIELD_MAPPING.propertyProfile.map(field => ({
        label: field.label,
        value: field.concat ? formatValue(getCellValue(row, field.excel), undefined, row, field.concat) : getCellValue(row, field.excel)
      }));

      const detailsFields = FIELD_MAPPING.propertyDetails.map((field: any) => ({
        label: field.label,
        value: formatValue(getCellValue(row, field.excel), field.format, row, field.concat)
      }));

      const financialFields = FIELD_MAPPING.financialHighlights.map((field: any) => ({
        label: field.label,
        value: formatValue(getCellValue(row, field.excel), field.format)
      }));

      return {
        propertyName: getCellValue(row, 'P NAME'),
        profileFields,
        detailsFields,
        financialFields,
        comments: getCellValue(row, 'M1')
      };
    });

    // Generate HTML
    const html = generatePropertyReportHTML(properties, FIELD_MAPPING);

    // Launch Puppeteer and generate PDF
    const browser = await launchBrowser();

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    await browser.close();

    // Save report configuration to database
    try {
      // Find or create upload record
      const existingUploads = db.prepare(`
        SELECT id FROM uploads 
        WHERE original_filename = ? AND file_size = ? 
        ORDER BY upload_date DESC LIMIT 1
      `).all(req.file.originalname, req.file.size) as any[];
      
      let uploadId: number;
      if (existingUploads.length > 0) {
        uploadId = existingUploads[0].id;
      } else {
        // Save upload if it doesn't exist
        uploadId = saveUploadToDb(
          req.file.originalname,
          req.file.originalname,
          req.file.size,
          workbook.SheetNames.length,
          jsonData,
          req.body.database_type
        );
      }

      // Save report configuration
      const reportName = filterDate 
        ? `Report - ${filterDate}` 
        : `Report - All Properties`;
      const selectedDates = filterDate ? [filterDate] : [];
      const propertyCount = dataRows.length;

      const reportId = saveReportToDb(uploadId, reportName, selectedDates, propertyCount);
      console.log(`✅ Saved report configuration with ID: ${reportId}`);
    } catch (dbError) {
      console.error('⚠️ Failed to save report configuration:', dbError);
      // Continue even if DB save fails (non-blocking)
    }

    // Send the PDF as a response
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=databank-property-reports.pdf');
    res.send(pdfBuffer);

  } catch (error) {
    console.error('Error converting file with HTML:', error);
    res.status(500).json({ error: 'Failed to convert file' });
  }
});

// Preview HTML template endpoint (for web viewing)
app.post('/api/preview-html', requireAdmin, upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filterDate = req.body.filterDate as string | undefined;

    // Read the Excel file (same logic as above)
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

    if (jsonData.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty' });
    }

    // Filter data (same as above)
    let filteredData = jsonData;
    if (filterDate) {
      const headers = jsonData[0] as string[];
      const dateColumnIndex = headers.findIndex(h => h && h.toLowerCase().trim() === 'insider date');
      
      if (dateColumnIndex >= 0) {
        const dataRows = jsonData.slice(1).filter(row => {
          if (!Array.isArray(row)) return false;
          let cellValue = row[dateColumnIndex];
          if (cellValue === undefined || cellValue === null) return false;
          
          if (typeof cellValue === 'number') {
            const excelDate = XLSX.SSF.parse_date_code(cellValue);
            if (excelDate) {
              cellValue = `${String(excelDate.m).padStart(2, '0')}/${String(excelDate.d).padStart(2, '0')}/${excelDate.y}`;
            }
          }
          
          const cellStr = String(cellValue).trim();
          return cellStr === filterDate || cellStr.includes(filterDate);
        });
        
        filteredData = [headers, ...dataRows];
      }
    }

    const headers = filteredData[0] as string[];
    const dataRows = filteredData.slice(1);

    // Same field mapping and helpers
    const FIELD_MAPPING = {
      propertyProfile: [
        { excel: 'P NAME', label: 'Property Name' },
        { excel: 'P STREET NUMBER', label: 'Address', concat: 'P STREET NAME' },
        { excel: 'P CITY', label: 'City' },
        { excel: 'COUNTY', label: 'County' },
        { excel: 'MARKET AREA', label: 'Market Area' },
        { excel: 'P ZIP', label: 'Zip' },
        { excel: 'DISTRICT2', label: 'District' },
        { excel: 'P CROSS STREET NAME', label: 'Cross Road' },
        { excel: 'PARCEL', label: 'Parcel' },
      ],
      propertyDetails: [
        { excel: 'INSIDER DATE', label: 'Insider Date' },
        { excel: 'P TYPE', label: 'Insider Description' },
        { excel: 'UNITS COMPLETED', label: 'Units / $ Unit', concat: '$ UNIT PROJECT', format: 'units' },
        { excel: 'TAX OWNER', label: 'Tax Owner' },
        { excel: 'ONSITE PHONE', label: 'Onsite Telephone' },
        { excel: '# ACRES', label: 'Acres / $ Per Acre', concat: '$ ACRE', format: 'acres' },
        { excel: 'HEATED SF', label: 'Square Ft' },
        { excel: '$ LOAN', label: 'Loan Amount', format: 'currency' },
        { excel: 'ATTORNEY', label: 'Attorney Name' },
        { excel: 'ATTORNEY PHONE', label: 'Attorney Telephone' },
      ],
      financialHighlights: [
        { excel: 'SALE PRICE', label: 'Property Sale Amount', format: 'currency' },
        { excel: 'SALE DATE', label: 'Property Sale Date' },
        { excel: 'LAND SALE PRICE', label: 'Land Sale Amount', format: 'currency' },
        { excel: 'LAND SALE DATE', label: 'Land Sale Date' },
        { excel: '$ EQUITY', label: 'Equity', format: 'currency' },
        { excel: '$ DOWNPAYMENT', label: 'Down Payment', format: 'currency' },
        { excel: '$ PURCHASE NOTE', label: 'Purchase Note', format: 'currency' },
        { excel: 'UTILITIES', label: 'Utility' },
        { excel: 'APPLICATION FEE', label: 'Application Fee', format: 'currency' },
        { excel: 'REFUND', label: 'Refund Amount', format: 'currency' },
        { excel: 'MONTHLY INCOME', label: 'Monthly Income', format: 'currency' },
        { excel: 'YEARLY INCOME', label: 'Yearly Income', format: 'currency' },
      ],
      unitBreakout: [] as any[],
      owner: [] as any[],
      broker: [] as any[],
      leasingCompany: [] as any[],
      seller: [] as any[],
      lender: [] as any[],
      comments: { excel: 'M1', label: 'Comments' }
    };

    const getColIndex = (colName: string) => headers.findIndex(h => h && h.trim() === colName);
    
    const getCellValue = (row: any[], colName: string) => {
      const idx = getColIndex(colName);
      if (idx === -1) return '';
      const value = row[idx];
      if (value === undefined || value === null) return '';
      
      if (typeof value === 'number' && (colName.includes('DATE') || colName.includes('Date'))) {
        const excelDate = XLSX.SSF.parse_date_code(value);
        if (excelDate) {
          return `${String(excelDate.m).padStart(2, '0')}/${String(excelDate.d).padStart(2, '0')}/${excelDate.y}`;
        }
      }
      
      return colName === 'M1' ? String(value).trim() : properCase(String(value).trim());
    };

    const formatValue = (value: string, format?: string, row?: any[], concat?: string) => {
      if (!value) return '';
      
      const formatCurrencyValue = (v: string) => {
        const n = parseFloat(v.replace(/[^0-9.-]/g, ''));
        return isNaN(n) ? v : `$${Math.round(n).toLocaleString('en-US')}`;
      };
      if (concat && row) {
        const concatValue = getCellValue(row, concat);
        if (format === 'units' || format === 'acres') return concatValue ? `${value} / ${formatCurrencyValue(concatValue)}` : value;
        return `${value} ${concatValue}`.trim();
      }
      
      if (format === 'currency' && value) return formatCurrencyValue(value);
      
      return value;
    };

    const properties = dataRows.map((row, index) => {
      const profileFields = FIELD_MAPPING.propertyProfile.map(field => ({
        label: field.label,
        value: field.concat ? formatValue(getCellValue(row, field.excel), undefined, row, field.concat) : getCellValue(row, field.excel)
      }));

      const detailsFields = FIELD_MAPPING.propertyDetails.map((field: any) => ({
        label: field.label,
        value: formatValue(getCellValue(row, field.excel), field.format, row, field.concat)
      }));

      const financialFields = FIELD_MAPPING.financialHighlights.map((field: any) => ({
        label: field.label,
        value: formatValue(getCellValue(row, field.excel), field.format)
      }));

      const unitBreakout = FIELD_MAPPING.unitBreakout.map((field: any) => ({
        label: field.label,
        value: formatValue(getCellValue(row, field.excel), field.format)
      }));

      const owner = FIELD_MAPPING.owner.map((field: any) => ({
        label: field.label,
        value: getCellValue(row, field.excel)
      }));

      const broker = FIELD_MAPPING.broker.map((field: any) => ({
        label: field.label,
        value: getCellValue(row, field.excel)
      }));

      const leasingCompany = FIELD_MAPPING.leasingCompany.map((field: any) => ({
        label: field.label,
        value: getCellValue(row, field.excel)
      }));

      const seller = FIELD_MAPPING.seller.map((field: any) => ({
        label: field.label,
        value: getCellValue(row, field.excel)
      }));

      const lender = FIELD_MAPPING.lender.map((field: any) => ({
        label: field.label,
        value: getCellValue(row, field.excel)
      }));

      return {
        propertyName: getCellValue(row, 'P NAME'),
        profileFields,
        detailsFields,
        financialFields,
        unitBreakout,
        owner,
        broker,
        leasingCompany,
        seller,
        lender,
        comments: getCellValue(row, 'M1')
      };
    });

    // Generate and return HTML directly
    const html = generatePropertyReportHTML(properties, FIELD_MAPPING);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);

  } catch (error) {
    console.error('Error generating HTML preview:', error);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

// Convert Excel to PDF endpoint (original pdf-lib version - keeping for backwards compatibility)
app.post('/api/convert', requireAdmin, upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Read the Excel file
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

    // Get filter date from request body (if provided)
    const filterDate = req.body.insiderDate;

    // Find the "Insider Date" column index
    let dateColumnIndex = -1;
    if (jsonData.length > 0 && filterDate) {
      const headers = jsonData[0] as string[];
      
      // First try to find exact match "INSIDER DATE"
      dateColumnIndex = headers.findIndex(h => 
        h && h.toLowerCase().trim() === 'insider date'
      );
      
      // If not found, try partial match (but exclude "previous")
      if (dateColumnIndex === -1) {
        dateColumnIndex = headers.findIndex(h => 
          h && h.toLowerCase().includes('insider') && 
          h.toLowerCase().includes('date') &&
          !h.toLowerCase().includes('previous')
        );
      }
      
      console.log(`Convert endpoint - Found column at index ${dateColumnIndex}: "${headers[dateColumnIndex]}"`);
    }

    // Filter data by insider date if specified
    let filteredData = jsonData;
    if (filterDate && dateColumnIndex >= 0) {
      const headerRow = jsonData[0];
      const dataRows = jsonData.slice(1).filter(row => {
        if (!Array.isArray(row)) return false;
        let cellValue = row[dateColumnIndex];
        if (cellValue === undefined || cellValue === null) return false;
        
        // Convert Excel serial date to formatted string if needed
        if (typeof cellValue === 'number') {
          const excelDate = XLSX.SSF.parse_date_code(cellValue);
          if (excelDate) {
            cellValue = `${String(excelDate.m).padStart(2, '0')}/${String(excelDate.d).padStart(2, '0')}/${excelDate.y}`;
          }
        }
        
        // Convert to string and check if it matches the filter
        const cellStr = String(cellValue).trim();
        const match = cellStr === filterDate || cellStr.includes(filterDate);
        
        return match;
      });
      
      console.log(`Filtered ${dataRows.length} rows matching date: ${filterDate}`);
      filteredData = [headerRow, ...dataRows];
    }

    // Create a new PDF document
    const pdfDoc = await PDFDocument.create();
    const titleFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pageWidth = 595.28; // A4 width
    const pageHeight = 841.89; // A4 height
    
    const headers = filteredData[0] as string[];
    const dataRows = filteredData.slice(1);
    
    // Helper function to get column index
    const getColIndex = (colName: string) => {
      return headers.findIndex(h => h && h.trim() === colName);
    };
    
    // Helper function to get cell value
    const getCellValue = (row: any[], colName: string) => {
      const idx = getColIndex(colName);
      if (idx === -1) return '';
      const value = row[idx];
      if (value === undefined || value === null) return '';
      
      // Convert Excel dates
      if (typeof value === 'number' && (colName.includes('DATE') || colName.includes('Date'))) {
        const excelDate = XLSX.SSF.parse_date_code(value);
        if (excelDate) {
          return `${String(excelDate.m).padStart(2, '0')}/${String(excelDate.d).padStart(2, '0')}/${excelDate.y}`;
        }
      }
      
      return colName === 'M1' ? String(value).trim() : properCase(String(value).trim());
    };
    
    // Format value based on type
    const formatValue = (value: string, format?: string, row?: any[], concat?: string) => {
      if (!value) return '';
      
      const formatCurrencyValue = (v: string) => {
        const n = parseFloat(v.replace(/[^0-9.-]/g, ''));
        return isNaN(n) ? v : `$${Math.round(n).toLocaleString('en-US')}`;
      };
      if (concat && row) {
        const concatValue = getCellValue(row, concat);
        if (format === 'units' || format === 'acres') return concatValue ? `${value} / ${formatCurrencyValue(concatValue)}` : value;
        return `${value} ${concatValue}`.trim();
      }
      
      if (format === 'currency' && value) return formatCurrencyValue(value);
      
      return value;
    };
    
    // Create Table of Contents page
    let currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - 40;
    
    // Add Databank header
    currentPage.drawText('Databank', {
      x: 50,
      y,
      size: 28,
      font: titleFont,
      color: rgb(0, 0, 0.8),
    });
    
    y -= 35;
    currentPage.drawText('Property Reports', {
      x: 50,
      y,
      size: 12,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });
    
    y -= 40;
    currentPage.drawText('Table of Contents', {
      x: 50,
      y,
      size: 20,
      font: titleFont,
      color: rgb(0.2, 0.2, 0.6),
    });
    
    y -= 40;
    currentPage.drawText(`${dataRows.length} Properties`, {
      x: 50,
      y,
      size: 12,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });
    
    y -= 30;
    
    // List all property names
    dataRows.forEach((row, index) => {
      if (y < 60) {
        currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - 60;
      }
      
      const propName = sanitizeText(getCellValue(row, 'P NAME')) || `Property ${index + 1}`;
      currentPage.drawText(`${index + 1}. ${propName}`, {
        x: 60,
        y,
        size: 11,
        font,
        color: rgb(0, 0, 0),
      });
      
      y -= 20;
    });

    // Generate individual property reports
    dataRows.forEach((row, index) => {
      // Create new page for each property
      currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
      let y = pageHeight - 50;
      const margin = 50;
      const labelX = margin;
      const valueX = 200;
      const rightLabelX = 320;
      const rightValueX = 470;
      
      // Property name as page title
      const propName = sanitizeText(getCellValue(row, 'P NAME')) || `Property ${index + 1}`;
      currentPage.drawText(propName, {
        x: margin,
        y,
        size: 18,
        font: titleFont,
        color: rgb(0, 0, 0.8),
      });
      
      y -= 35;
      
      // Helper to draw a section header
      const drawSectionHeader = (title: string) => {
        if (y < 100) {
          currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
          y = pageHeight - 50;
        }
        currentPage.drawText(title, {
          x: margin,
          y,
          size: 14,
          font: titleFont,
          color: rgb(0.2, 0.2, 0.6),
        });
        y -= 25;
      };
      
      // Helper to draw a field (two-column layout)
      const drawField = (label: string, value: string, isRightColumn = false) => {
        if (y < 80) {
          currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
          y = pageHeight - 50;
        }
        
        const lx = isRightColumn ? rightLabelX : labelX;
        const vx = isRightColumn ? rightValueX : valueX;
        
        currentPage.drawText(label + ':', {
          x: lx,
          y,
          size: 9,
          font,
          color: rgb(0.4, 0.4, 0.4),
        });
        
        const sanitizedValue = sanitizeText(value);
        const maxWidth = isRightColumn ? 110 : 110;
        const displayValue = truncateText(sanitizedValue, maxWidth, font, 10);
        
        currentPage.drawText(displayValue, {
          x: vx,
          y,
          size: 10,
          font,
          color: rgb(0, 0, 0),
        });
        
        if (!isRightColumn) return false; // Signal to draw right column on same line
        y -= 18; // Move to next line only after right column
        return true;
      };
      
      // Property Profile Section
      drawSectionHeader('Property Profile');
      
      FIELD_MAPPING.propertyProfile.forEach((field: any, idx) => {
        const value = field.concat 
          ? formatValue(getCellValue(row, field.excel), field.format, row, field.concat)
          : formatValue(getCellValue(row, field.excel), field.format);
        
        const isRight = idx % 2 === 1;
        drawField(field.label, value, isRight);
      });
      
      y -= 10;
      
      // Property Details Section
      drawSectionHeader('Property Details');
      
      FIELD_MAPPING.propertyDetails.forEach((field: any, idx) => {
        const value = field.concat 
          ? formatValue(getCellValue(row, field.excel), field.format, row, field.concat)
          : formatValue(getCellValue(row, field.excel), field.format);
        
        const isRight = idx % 2 === 1;
        drawField(field.label, value, isRight);
      });
      
      y -= 10;
      
      // Financial Highlights Section
      drawSectionHeader('Financial Highlights');
      
      FIELD_MAPPING.financialHighlights.forEach((field: any, idx) => {
        const value = formatValue(getCellValue(row, field.excel), field.format);
        const isRight = idx % 2 === 1;
        drawField(field.label, value, isRight);
      });
      
      y -= 10;
      
      // Comments Section
      const comments = getCellValue(row, FIELD_MAPPING.comments.excel);
      if (comments) {
        drawSectionHeader('Comments');
        
        const sanitizedComments = sanitizeText(comments);
        const maxLineLength = 85;
        const words = sanitizedComments.split(' ');
        let currentLine = '';
        
        words.forEach(word => {
          if ((currentLine + ' ' + word).length > maxLineLength) {
            if (y < 60) {
              currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
              y = pageHeight - 50;
            }
            currentPage.drawText(currentLine, {
              x: margin,
              y,
              size: 9,
              font,
              color: rgb(0, 0, 0),
            });
            y -= 14;
            currentLine = word;
          } else {
            currentLine = currentLine ? currentLine + ' ' + word : word;
          }
        });
        
        // Draw remaining text
        if (currentLine && y >= 60) {
          currentPage.drawText(currentLine, {
            x: margin,
            y,
            size: 9,
            font,
            color: rgb(0, 0, 0),
          });
        }
      }
    });

    // Save the PDF to a buffer
    const pdfBytes = await pdfDoc.save();
    
    // Send the PDF as a response
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=databank-property-reports.pdf');
    res.send(Buffer.from(pdfBytes));

  } catch (error) {
    console.error('Error converting file:', error);
    res.status(500).json({ error: 'Failed to convert file' });
  }
});

// ==================== DATABASE ENDPOINTS ====================

// Get all uploads
app.get('/api/uploads', requireUser, (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const databaseType = req.query.database_type as string | undefined;
    
    const uploads = getUploadsFromDb(limit, offset, databaseType);
    const total = getUploadCountFromDb();
    
    res.json({
      uploads,
      total,
      limit,
      offset
    });
  } catch (error) {
    console.error('Error fetching uploads:', error);
    res.status(500).json({ error: 'Failed to fetch uploads' });
  }
});

// Get specific upload by ID
app.get('/api/uploads/:id', requireUser, (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid upload ID' });
    }
    
    const upload = getUploadByIdFromDb(id);
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }
    
    res.json(upload);
  } catch (error) {
    console.error('Error fetching upload:', error);
    res.status(500).json({ error: 'Failed to fetch upload' });
  }
});

// Get Excel data for a specific upload
// Admin only: the whole file in one response. Customers search through /api/search (one page at a time).
app.get('/api/uploads/:id/data', requireAdmin, (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid upload ID' });
    }
    
    const upload = getUploadByIdFromDb(id);
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }
    
    const excelData = stripSensitiveColumns(getExcelDataFromDb(id));
    
    res.json({
      upload,
      data: excelData,
      rowCount: excelData.length
    });
  } catch (error) {
    console.error('Error fetching Excel data:', error);
    res.status(500).json({ error: 'Failed to fetch Excel data' });
  }
});

// Delete an upload
app.delete('/api/uploads/:id', requireAdmin, (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid upload ID' });
    }
    
    const deleted = deleteUploadFromDb(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Upload not found' });
    }
    
    res.json({ success: true, message: 'Upload deleted successfully' });
  } catch (error) {
    console.error('Error deleting upload:', error);
    res.status(500).json({ error: 'Failed to delete upload' });
  }
});

// ==================== SAVED REPORTS ENDPOINTS ====================

// Get database status: which file/version is attached to each database
app.get('/api/databases', requireUser, (req: Request, res: Response) => {
  try {
    const latestUploadStmt = db.prepare(`
      SELECT * FROM uploads WHERE database_type = ? ORDER BY upload_date DESC LIMIT 1
    `);
    const uploadCountStmt = db.prepare(`
      SELECT COUNT(*) as count FROM uploads WHERE database_type = ?
    `);
    const reportCountStmt = db.prepare(`
      SELECT COUNT(*) as count FROM saved_reports sr
      JOIN uploads u ON sr.upload_id = u.id
      WHERE u.database_type = ?
    `);

    const databases = DATABASE_TYPES.map((type) => {
      const latestUpload = latestUploadStmt.get(type) as any;
      const uploadCount = (uploadCountStmt.get(type) as any).count;
      const reportCount = (reportCountStmt.get(type) as any).count;
      return {
        database_type: type,
        latest_upload: latestUpload || null,
        upload_count: uploadCount,
        report_count: reportCount
      };
    });

    res.json({ databases });
  } catch (error) {
    console.error('Error fetching database status:', error);
    res.status(500).json({ error: 'Failed to fetch database status' });
  }
});

// ==================== DROPBOX → DATABASES ====================
// Attach the latest weekly CSV from Dropbox to each database as a new upload version, so Search,
// Generate and Reports run off it exactly like a hand-uploaded .xls. One version per (type, week, file rev).

const DROPBOX_SYNC_MS = 6 * 60 * 60 * 1000;
const findDropboxUploadStmt: any = db.prepare(`SELECT id FROM uploads WHERE database_type = ? AND filename = ?`);

type DropboxSyncResult = { database_type: string; week: string | null; status: 'attached' | 'current' | 'no-file' | 'error'; upload_id?: number; rows?: number; error?: string };

async function syncDatabaseFromDropbox(databaseType: string): Promise<DropboxSyncResult> {
  try {
    const sheet = await latestSheet(databaseType);
    if (!sheet) return { database_type: databaseType, week: null, status: 'no-file' };
    const marker = `dropbox:${sheet.type}:${sheet.week}:${sheet.rev}`;
    const existing = findDropboxUploadStmt.get(databaseType, marker) as any;
    if (existing) return { database_type: databaseType, week: sheet.week, status: 'current', upload_id: existing.id };
    const size = Buffer.byteLength(JSON.stringify(sheet.data));
    const uploadId = saveUploadToDb(marker, `${sheet.file} — Dropbox week ${sheet.week}`, size, 1, sheet.data, databaseType);
    console.log(`✅ Attached Dropbox ${sheet.file} (${sheet.week}) to database "${databaseType}" as upload ${uploadId}`);
    return { database_type: databaseType, week: sheet.week, status: 'attached', upload_id: uploadId, rows: sheet.data.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`Dropbox sync failed for "${databaseType}":`, error);
    return { database_type: databaseType, week: null, status: 'error', error };
  }
}

async function syncAllDatabasesFromDropbox(forceExcelBackup = false): Promise<DropboxSyncResult[]> {
  // A week uploaded to Dropbox but never converted to CSV gets built from its Excel exports.
  await backfillWeekFromExcel(forceExcelBackup).catch((e: unknown) => console.error('Excel backup failed:', e instanceof Error ? e.message : e));
  const results: DropboxSyncResult[] = [];
  for (const type of DATABASE_TYPES) results.push(await syncDatabaseFromDropbox(type));
  return results;
}

app.post('/api/databases/sync-dropbox', requireAdmin, async (req: Request, res: Response) => {
  if (!dropboxConfigured()) {
    return res.status(400).json({ error: 'Dropbox is not configured (DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN)' });
  }
  res.json({ results: await syncAllDatabasesFromDropbox(true) });
});

// Push one week's converted CSVs (APTS.csv, IND.csv, …) into the Dropbox archive by hand — for when the
// scheduled zip→CSV sync did not run — then attach the week to every database.
app.post('/api/databases/upload-week', requireAdmin, upload.array('files', 20), async (req: Request, res: Response) => {
  if (!dropboxConfigured()) {
    return res.status(400).json({ error: 'Dropbox is not configured (DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN)' });
  }
  const week = String(req.body?.week ?? '').trim();
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || !files.length) {
    return res.status(400).json({ error: 'week (YYYY-MM-DD) and at least one .csv file are required' });
  }
  try {
    const uploaded = await uploadWeek(
      week,
      files.map((f) => ({ type: path.basename(f.originalname, path.extname(f.originalname)).toUpperCase(), body: f.buffer })),
    );
    res.json({ uploaded, results: await syncAllDatabasesFromDropbox() });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'Dropbox upload failed' });
  }
});

app.post('/api/databases/:type/sync-dropbox', requireAdmin, async (req: Request, res: Response) => {
  if (!dropboxConfigured()) {
    return res.status(400).json({ error: 'Dropbox is not configured (DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN)' });
  }
  const databaseType = normalizeDatabaseType(req.params.type);
  if (databaseType !== String(req.params.type).trim().toLowerCase()) {
    return res.status(400).json({ error: 'Invalid database type' });
  }
  const result = await syncDatabaseFromDropbox(databaseType);
  if (result.status === 'error') return res.status(502).json({ error: result.error, result });
  res.json({ result, upload: result.upload_id ? getUploadByIdFromDb(result.upload_id) : null });
});

// Upload a new file version directly to a specific database
app.post('/api/databases/:type/upload', requireAdmin, upload.single('file'), (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const databaseType = normalizeDatabaseType(req.params.type);
    if (databaseType !== String(req.params.type).trim().toLowerCase()) {
      return res.status(400).json({ error: 'Invalid database type' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

    if (jsonData.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty' });
    }

    const uploadId = saveUploadToDb(
      req.file.originalname,
      req.file.originalname,
      req.file.size,
      workbook.SheetNames.length,
      jsonData,
      databaseType
    );
    console.log(`✅ Attached upload ${uploadId} to database "${databaseType}"`);

    res.json({
      success: true,
      upload: getUploadByIdFromDb(uploadId)
    });
  } catch (error) {
    console.error('Error uploading to database:', error);
    res.status(500).json({ error: 'Failed to upload file to database' });
  }
});

// Extract insider dates from a stored upload
app.get('/api/uploads/:id/dates', requireUser, (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid upload ID' });
    }

    const uploadRecord = getUploadByIdFromDb(id);
    if (!uploadRecord) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    const excelData = getExcelDataFromDb(id);
    if (excelData.length === 0) {
      return res.status(400).json({ error: 'Upload has no data' });
    }

    const headers = excelData[0] as string[];
    let dateColumnIndex = headers.findIndex(h =>
      h && String(h).toLowerCase().trim() === 'insider date'
    );
    if (dateColumnIndex === -1) {
      dateColumnIndex = headers.findIndex(h =>
        h && String(h).toLowerCase().includes('insider') &&
        String(h).toLowerCase().includes('date') &&
        !String(h).toLowerCase().includes('previous')
      );
    }
    if (dateColumnIndex === -1) {
      return res.status(400).json({ error: 'No "Insider Date" column found in stored data' });
    }

    const dateMap = new Map<string, number>();
    for (let i = 1; i < excelData.length; i++) {
      const row = excelData[i];
      if (Array.isArray(row) && row[dateColumnIndex] !== undefined && row[dateColumnIndex] !== null) {
        let dateValue = row[dateColumnIndex];
        if (typeof dateValue === 'number') {
          const excelDate = XLSX.SSF.parse_date_code(dateValue);
          if (excelDate) {
            dateValue = `${String(excelDate.m).padStart(2, '0')}/${String(excelDate.d).padStart(2, '0')}/${excelDate.y}`;
          }
        }
        const dateStr = String(dateValue).trim();
        if (dateStr) {
          dateMap.set(dateStr, (dateMap.get(dateStr) || 0) + 1);
        }
      }
    }

    // Only include dates strictly before today, keep the 10 most recent
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const dateEntries = Array.from(dateMap.entries())
      .map(([date, count]) => ({
        date,
        count,
        sortKey: new Date(date)
      }))
      .filter(({ sortKey }) => !isNaN(sortKey.getTime()) && sortKey.getTime() < startOfToday.getTime());

    dateEntries.sort((a, b) => b.sortKey.getTime() - a.sortKey.getTime());

    res.json({
      upload: uploadRecord,
      dates: dateEntries.slice(0, 10).map(({ date, count }) => ({ date, count }))
    });
  } catch (error) {
    console.error('Error extracting dates from stored upload:', error);
    res.status(500).json({ error: 'Failed to extract dates from stored upload' });
  }
});

// Report field mappings per database type. Industrial files name several
// columns differently from apartments (sq ft instead of units, PERMANENT LOAN
// instead of $ LOAN, etc.), so each type gets its own mapping.
function getReportFieldMapping(databaseType: string = 'apartments') {
  const propertyProfile = [
    { excel: 'P NAME', label: 'Property Name' },
    { excel: 'P STREET NUMBER', label: 'Address', concat: 'P STREET NAME' },
    { excel: 'P CITY', label: 'City' },
    { excel: 'COUNTY', label: 'County' },
    { excel: 'MARKET AREA', label: 'Market Area' },
    { excel: 'P ZIP', label: 'Zip' },
    { excel: 'DISTRICT2', label: 'District' },
    { excel: 'P CROSS STREET NAME', label: 'Cross Road' },
    { excel: 'PARCEL', label: 'Parcel' },
  ];

  if (databaseType === 'industrial') {
    return {
      propertyProfile,
      propertyDetails: [
        { excel: 'INSIDER DATE', label: 'Insider Date' },
        { excel: 'PROJECT TYPE', label: 'Insider Description' },
        { excel: '# SQ FT BUILT', label: 'Sq Ft / $ SF', concat: 'PRICE PER SF BUILDING', format: 'units' },
        { excel: 'TAX OWNER', label: 'Tax Owner' },
        { excel: '# ACRES', label: 'Acres / $ Per Acre', concat: 'PRICE PER ACRE', format: 'acres' },
        { excel: 'PERMANENT LOAN', label: 'Loan Amount', format: 'currency' },
        { excel: 'ATTORNEY', label: 'Attorney Name' },
        { excel: 'ATTORNEY PHONE', label: 'Attorney Telephone' },
      ],
      financialHighlights: [
        { excel: 'SALE PRICE', label: 'Property Sale Amount', format: 'currency' },
        { excel: 'SALE DATE', label: 'Property Sale Date' },
        { excel: 'LAND SALE PRICE', label: 'Land Sale Amount', format: 'currency' },
        { excel: 'LAND SALE DATE', label: 'Land Sale Date' },
        { excel: 'EQUITY', label: 'Equity', format: 'currency' },
        { excel: 'DOWNPAYMENT', label: 'Down Payment', format: 'currency' },
        { excel: 'PURCHASE NOTE', label: 'Purchase Note', format: 'currency' },
        { excel: 'ASKING PRICE', label: 'Asking Price', format: 'currency' },
        { excel: 'MONTHLY INCOME', label: 'Monthly Income', format: 'currency' },
        { excel: 'YEARLY INCOME', label: 'Yearly Income', format: 'currency' },
      ],
      unitBreakout: [] as any[],
      owner: [] as any[],
      broker: [] as any[],
      leasingCompany: [] as any[],
      seller: [] as any[],
      lender: [] as any[],
      comments: { excel: 'M1', label: 'Comments' }
    };
  }

  return {
    propertyProfile,
    propertyDetails: [
      { excel: 'INSIDER DATE', label: 'Insider Date' },
      { excel: 'P TYPE', label: 'Insider Description' },
      { excel: 'UNITS COMPLETED', label: 'Units / $ Unit', concat: '$ UNIT PROJECT', format: 'units' },
      { excel: 'TAX OWNER', label: 'Tax Owner' },
      { excel: 'ONSITE PHONE', label: 'Onsite Telephone' },
      { excel: '# ACRES', label: 'Acres / $ Per Acre', concat: '$ ACRE', format: 'acres' },
      { excel: 'HEATED SF', label: 'Square Ft' },
      { excel: '$ LOAN', label: 'Loan Amount', format: 'currency' },
      { excel: 'ATTORNEY', label: 'Attorney Name' },
      { excel: 'ATTORNEY PHONE', label: 'Attorney Telephone' },
    ],
    financialHighlights: [
      { excel: 'SALE PRICE', label: 'Property Sale Amount', format: 'currency' },
      { excel: 'SALE DATE', label: 'Property Sale Date' },
      { excel: 'LAND SALE PRICE', label: 'Land Sale Amount', format: 'currency' },
      { excel: 'LAND SALE DATE', label: 'Land Sale Date' },
      { excel: '$ EQUITY', label: 'Equity', format: 'currency' },
      { excel: '$ DOWNPAYMENT', label: 'Down Payment', format: 'currency' },
      { excel: '$ PURCHASE NOTE', label: 'Purchase Note', format: 'currency' },
      { excel: 'UTILITIES', label: 'Utility' },
      { excel: 'APPLICATION FEE', label: 'Application Fee', format: 'currency' },
      { excel: 'REFUND', label: 'Refund Amount', format: 'currency' },
      { excel: 'MONTHLY INCOME', label: 'Monthly Income', format: 'currency' },
      { excel: 'YEARLY INCOME', label: 'Yearly Income', format: 'currency' },
    ],
    unitBreakout: [] as any[],
    owner: [] as any[],
    broker: [] as any[],
    leasingCompany: [] as any[],
    seller: [] as any[],
    lender: [] as any[],
    comments: { excel: 'M1', label: 'Comments' }
  };
}

// Shared: build report properties + HTML from stored Excel data
function buildReportHTMLFromExcelData(excelData: any[][], filterDate?: string, databaseType: string = 'apartments'): { html: string; propertyCount: number } {
  let filteredData = excelData;
  if (filterDate) {
    const headers = excelData[0] as string[];
    const dateColumnIndex = headers.findIndex((h: string) => h && String(h).toLowerCase().trim() === 'insider date');
    if (dateColumnIndex >= 0) {
      const dataRows = excelData.slice(1).filter((row: any[]) => {
        if (!Array.isArray(row)) return false;
        let cellValue = row[dateColumnIndex];
        if (cellValue === undefined || cellValue === null) return false;
        if (typeof cellValue === 'number') {
          const excelDate = XLSX.SSF.parse_date_code(cellValue);
          if (excelDate) {
            cellValue = `${String(excelDate.m).padStart(2, '0')}/${String(excelDate.d).padStart(2, '0')}/${excelDate.y}`;
          }
        }
        const cellStr = String(cellValue).trim();
        return cellStr === filterDate || cellStr.includes(filterDate);
      });
      filteredData = [headers, ...dataRows];
    }
  }

  const headers = filteredData[0] as string[];
  const dataRows = filteredData.slice(1);

  const REPORT_FIELD_MAPPING = getReportFieldMapping(databaseType);

  const getColIndex = (colName: string) => headers.findIndex(h => h && String(h).trim() === colName);

  const getCellValue = (row: any[], colName: string) => {
    const idx = getColIndex(colName);
    if (idx === -1) return '';
    const value = row[idx];
    if (value === undefined || value === null) return '';
    // Convert Excel date serial numbers to MM/DD/YYYY for date columns
    if (typeof value === 'number' && colName.toUpperCase().includes('DATE')) {
      const excelDate = XLSX.SSF.parse_date_code(value);
      if (excelDate) {
        return `${String(excelDate.m).padStart(2, '0')}/${String(excelDate.d).padStart(2, '0')}/${excelDate.y}`;
      }
    }
    return colName === 'M1' ? String(value).trim() : properCase(String(value).trim());
  };

  // One rule everywhere: whole dollars, comma-grouped, "$" prefix — matching the per-property
  // report's money(). Previously this file had three different currency formatters (this one
  // allowed up to 2 decimals; the inline branch below always forced 2 decimals; a third, dead
  // one lived in generatePropertyReportHTML) so the same kind of figure could show with or
  // without cents depending which field it was, and only some fields got a "$" at all.
  const formatCurrencyValue = (value: string) => {
    const num = parseFloat(value.replace(/[^0-9.-]/g, ''));
    if (isNaN(num)) return value;
    return `$${Math.round(num).toLocaleString('en-US')}`;
  };

  const formatValue = (value: string, format?: string, row?: any[], concat?: string) => {
    if (!value) return '';
    if (concat && row) {
      const concatValue = getCellValue(row, concat);
      if (format === 'units' || format === 'acres') {
        return concatValue ? `${value} / ${formatCurrencyValue(concatValue)}` : value;
      }
      return `${value} ${concatValue}`.trim();
    }
    if (format === 'currency' && value) return formatCurrencyValue(value);
    return value;
  };

  const properties = dataRows.map(row => {
    const propertyName = getCellValue(row, 'P NAME');
    if (!propertyName) return null;

    return {
      propertyName,
      profileFields: REPORT_FIELD_MAPPING.propertyProfile.map((field: any) => ({
        label: field.label,
        value: field.concat
          ? `${getCellValue(row, field.excel)} ${getCellValue(row, field.concat)}`.trim()
          : getCellValue(row, field.excel)
      })),
      detailsFields: REPORT_FIELD_MAPPING.propertyDetails.map((field: any) => ({
        label: field.label,
        value: formatValue(getCellValue(row, field.excel), field.format, row, field.concat)
      })),
      financialFields: REPORT_FIELD_MAPPING.financialHighlights.map((field: any) => ({
        label: field.label,
        value: formatValue(getCellValue(row, field.excel), field.format)
      })),
      unitBreakout: [] as any[],
      owner: [] as any[],
      broker: [] as any[],
      leasingCompany: [] as any[],
      seller: [] as any[],
      lender: [] as any[],
      comments: getCellValue(row, 'M1')
    };
  }).filter(Boolean);

  return {
    html: generatePropertyReportHTML(properties, REPORT_FIELD_MAPPING),
    propertyCount: properties.length
  };
}

// AI-powered natural language search: translate a user query into structured filters
// Columns Ask AI already covers with named filters; anything else is offered as a raw column.
const CORE_COLUMNS = new Set([
  'P NAME', 'P TYPE', 'PROJECT TYPE', 'MARKET AREA', 'P STREET NUMBER', 'P STREET NAME', 'P CROSS STREET NAME', 'P CITY', 'P ZIP', 'P STATE', 'COUNTY',
  'DISTRICT', 'DISTRICT2', 'LANDLOT', 'LANDLOT2', 'LAND LOT', 'SQUARE', 'SQUARE2', 'SECTION', 'PARCEL', 'PARCEL2',
  'UNITS COMPLETED:', '# SQ FT BUILT', '# ACRES', 'SF LAND', 'LAND SALE DATE', 'LAND SALE PRICE', 'SALE DATE', 'SALE PRICE',
  '$ UNIT PROJECT', 'PRICE PER SF BUILDING', '$ ACRE', '$ SF', '$ UNIT LAND', 'PRICE PER ACRE', 'PRICE PER SF LAND', 'PRICE PER UNIT',
  'TAX OWNER', 'OWNER', 'OWNER2\\ATTENTION', 'ATTENTION', 'SELLER\\FORECLOSEE', 'SELLER',
  'INSIDER DATE', 'PREVIOUS INSIDER DATE 1', 'PREVIOUS INSIDER DATE 2', 'PREVIOUS INSIDER DATE 3', 'INSIDER SORT', 'RECID',
  'BUILT\\COMPLETE', 'ORIGINALLY BUILT', 'YEAR BUILT', 'AKA', 'DESCRIPTION', 'INSIDER DESCRIPTION',
]);

// Plain-English answer written from the matched archive records only (the
// model sees a digest of the rows, never the whole archive), so every date,
// price and name in the text is one that is also in the table beneath it.
async function summarizeHistoryAnswer(apiKey: string, question: string, answer: Record<string, unknown>): Promise<string | null> {
  const items = Array.isArray(answer.items) ? (answer.items as Record<string, unknown>[]) : [];
  const monthYear = (d: unknown) => (typeof d === 'string' && /^\d{4}-\d{2}/.test(d) ? new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, 15).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : null);
  if (!items.length) {
    const oldest = typeof answer.oldestSale === 'string' ? answer.oldestSale : '';
    const tooEarly = !!oldest && typeof answer.before === 'string' && answer.before < oldest;
    const reach = [
      oldest && `the earliest sale date on record is ${monthYear(oldest)}`,
      answer.firstWeek && `the weekly archive covers ${monthYear(answer.firstWeek)} to ${monthYear(answer.latestWeek)}`,
    ].filter(Boolean).join(', and ');
    return `No matching records${answer.after || answer.before ? ' in that period' : ''}.${reach ? ` ${tooEarly ? "Databank's data does not go back that far: " : ''}${reach}.` : ''}`;
  }
  const digest = items.slice(0, 15).map((it) => {
    if ('count' in it) return { name: it.name, properties_count: it.count };
    const sales = Array.isArray(it.saleList) ? (it.saleList as Record<string, string>[]).map((s) => ({
      date: s.date, price: s.price, seller: s.seller, buyer: s.buyer,
      ...(s.buyer && s.seller && s.buyer.toUpperCase() === s.seller.toUpperCase() ? { same_owner_transfer: true } : {}),
    })) : [];
    const owners = Array.isArray(it.ownerTrail) ? (it.ownerTrail as Record<string, string>[]).map((o) => o.value) : [];
    return {
      name: it.name, address: it.address, city: it.city, county: it.county, size: it.size,
      owner_now: it.owner, in_database_since: it.first, dropped_off: it.removed || undefined, role: it.role,
      sales, owners_over_time: owners,
    };
  });
  const facts = {
    question_type: answer.question, subject: answer.subject, entity: answer.entity, field: answer.field,
    period: { after: answer.after, before: answer.before, archive_from: answer.firstWeek, archive_to: answer.latestWeek, earliest_sale_date_in_database: answer.oldestSale },
    total_matches: answer.total, shown: digest.length, records: digest,
  };
  const system = `You are Databank Atlanta's research analyst. Answer the customer's question in plain English in 1-3 short sentences, using ONLY the facts in the JSON. Prices are in US dollars: write them like $12.5M or $850,000. Dates like "Aug 2022". Name the property/owner/seller exactly as written (title case is fine). Each record's "sales" are in date order, oldest first: the LAST entry is the most recent sale — never call an earlier one the latest. A sale marked same_owner_transfer stayed with the same owner (refinance/internal transfer): still report it as the latest record (e.g. "most recently recorded at $18M in May 2026, staying with X"). If several records match, answer for the best match first and state the exact total_matches count (e.g. "18 properties"), not a smaller number. If the facts don't contain what was asked (e.g. no sale price), say so plainly instead of guessing. If a record has "dropped_off", note it is no longer on the list. If the customer asks how far back the data goes, or asks about a period earlier than earliest_sale_date_in_database, tell them that date and the archive_from week. For question_type sold_once the records are in date order, oldest sale first. No preamble, no bullet points, no markdown.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: `Question: ${question}\n\nFacts:\n${JSON.stringify(facts)}` }]
      })
    });
    if (!r.ok) {
      console.error('Anthropic summary error:', r.status, await r.text());
      return null;
    }
    const j = await r.json() as { content?: { text?: string }[] };
    const text = (j.content?.[0]?.text ?? '').trim();
    return text || null;
  } catch (e) {
    console.error('Anthropic summary failed:', e);
    return null;
  }
}

app.post('/api/nl-search', requireUser, rateLimit(ASK_AI_PER_HOUR), async (req: Request, res: Response) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'AI search is not configured. Set ANTHROPIC_API_KEY in backend/.env' });
    }

    const { query, database_type } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'Missing query' });
    }

    const databaseType = normalizeDatabaseType(database_type || 'apartments');
    const latestUpload = db.prepare(`
      SELECT id FROM uploads WHERE database_type = ? ORDER BY upload_date DESC, id DESC LIMIT 1
    `).get(databaseType) as { id: number } | undefined;
    if (!latestUpload) {
      return res.status(404).json({ error: 'No file attached to this database' });
    }

    // Gather known filter values from the stored data
    const excelData = getExcelDataFromDb(latestUpload.id);
    const headers = (excelData[0] as string[]).map(h => String(h || '').trim());
    const colIdx = (name: string) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
    const collectValues = (colName: string | string[], cap: number) => {
      const names = Array.isArray(colName) ? colName : [colName];
      let idx = -1;
      for (const name of names) {
        idx = colIdx(name);
        if (idx !== -1) break;
      }
      if (idx === -1) return [] as string[];
      const values = new Set<string>();
      for (let i = 1; i < excelData.length && values.size < cap; i++) {
        const v = String((excelData[i] as any[])[idx] ?? '').trim();
        if (v) values.add(v);
      }
      return Array.from(values);
    };

    const counties = collectValues('COUNTY', 100);
    const cities = collectValues('P CITY', 300);
    const marketAreas = collectValues('MARKET AREA', 100);
    const zipcodes = collectValues('P ZIP', 500);
    const districts = collectValues('DISTRICT2', 100);
    const landLots = collectValues(['LAND LOT', 'LANDLOT'], 200);

    const today = new Date().toISOString().slice(0, 10);
    const extraColumns = headers.filter((h) => h && !CORE_COLUMNS.has(h.toUpperCase()) && !/^(M\d+|\d .*|.* (\d\d|9\d)|.*PHONE.*|.*FAX|.*STREET NUMBER|.*SUITE NUMBER|.*P O BOX NUMBER|.*ZIP|.*STATE|.*REP2?)$/.test(h.toUpperCase()));
    const systemPrompt = `You translate natural language real-estate database questions into a JSON object. Today's date is ${today}.

There are TWO kinds of questions. Decide first, and set "mode":

(A) mode "current" — a search over this week's list of ${databaseType} properties (the default). Filter fields are below. Each property's SALE DATE is whatever its most recent recorded sale is, however old — so "sold in the last N years/months", "sold since <date>", "sold in <year>" are answered here with sale_date_after/before, NOT mode history, as long as the question is just "which properties sold when" and doesn't ask about repeat sales, prior owners, or rankings (those go to mode history below). A rolling window like "last 2 years" means sale_date_after = today minus that span.

(B) mode "history" — the question needs MORE THAN ONE WEEK of data: previous owners, who bought/sold a specific property, its sale history or timeline, what changed on a record, properties sold MORE THAN ONCE, what appeared or dropped off the list, MOST ACTIVE buyers/sellers over a period (a ranking). For history set:
- question: one of ${JSON.stringify(dropboxAsk.ASK_QUESTIONS)}
    property_history = who owned / bought / sold / paid for a NAMED property, its previous owners, sale history, what changed on it (set subject)
    entity_history   = everything a company or person has bought or sold over time (set entity). Prefer this over mode current when the user says "ever", "history", "over the years", "since <year>"
    repeat_sales     = properties that sold / traded more than once, flipped
    sold_once        = properties sold in a period and NOT sold again since ("never resold", "still held"); also "how far back does the data go" / "oldest sales" (oldest first)
    changes          = records that changed in a period; set field to a column name (e.g. "SALE PRICE", "TAX OWNER", "UNITS COMPLETED:") when the user asks about one kind of change
    new              = properties added to the database / first published in a period
    removed          = properties that dropped off / were removed from the list in a period
    top_buyers       = who bought the most properties in a period (most active buyers)
    top_sellers      = who sold the most properties in a period
- subject: the property as the user named it (name, address or parcel number) — for property_history
- entity: the company / person — for entity_history
- field: column name — for changes
- after / before: ISO dates (YYYY-MM-DD) bounding the period, when the user gives one ("since 2024" -> after 2024-01-01; "in 2023" -> both; "prior to 1970" -> before 1969-12-31). Use ONLY these two keys for dates in history mode.
- area: a city, county, zip, neighbourhood word — OR any other free text to narrow to, such as a company/brand/property name (e.g. "Zaxby's sold more than once" -> area: "Zaxby's"). There is no separate search_text field in history mode; area is the general-purpose text filter here.
Do NOT set the mode-current filters (including search_text) for a history question.

For mode "current", the database contains ${databaseType} properties with these filterable fields:

LOCATION FILTERS (match values EXACTLY as listed, case-sensitive):
- counties: an ARRAY of values from ${JSON.stringify(counties)}. Include ALL variants that match the user's intent.
- city: one of ${JSON.stringify(cities)}
- market_area: one of ${JSON.stringify(marketAreas)}
- zipcode: one or an ARRAY of values from ${JSON.stringify(zipcodes)} (user may name several zip codes)
- district: one of ${JSON.stringify(districts)}
- land_lot: one of ${JSON.stringify(landLots)}

DATE RANGE FILTERS (use ISO format YYYY-MM-DD):
- insider_date_after / insider_date_before: INSIDER DATE (when record was published)
- sale_date_after / sale_date_before: property SALE DATE. "sold before / after / in <year>", "sales prior to <year>", "sold in the last N years/months" ALWAYS mean the SALE DATE, never year built — use min_year_built / max_year_built only when the user says "built" or "constructed". A relative window ("last 2 years") -> sale_date_after = today minus that span.
- land_sale_date_after / land_sale_date_before: LAND SALE DATE

ADDRESS FILTERS (partial, case-insensitive match):
- street: street name, e.g. "Peachtree" matches "PEACHTREE ST NE"

NUMERIC RANGE FILTERS:
- min_sale_price / max_sale_price: property sale price in dollars
- min_land_price / max_land_price: land sale price in dollars
- min_price_per_unit / max_price_per_unit: price per ${databaseType === 'industrial' ? 'square foot of building' : 'unit'} in dollars (calculated as sale price / ${databaseType === 'industrial' ? 'building square feet' : 'number of units'})
- min_units / max_units: ${databaseType === 'industrial' ? 'building size in square feet' : 'number of units'}
- min_acres / max_acres: number of acres
- min_year_built / max_year_built: year built (YYYY)

TEXT SEARCH (searches across ALL fields in the database):
- search_text: free text matched against property name, description, address, owner, seller, the researcher notes, and all other text fields
${databaseType === 'land' ? '- The intended use of a land parcel (apartments, retail, industrial, subdivision, hotel…) is only in the researcher notes, so "apartment land sales" / "land for apartments" -> search_text: "apartments" (the notes use APTS, APARTMENT and APARTMENTS; the search normalises these).\n' : ''}
OWNER / SELLER FILTERS (partial name, case-insensitive match). The OWNER of a property is the BUYER in its most recent sale; the SELLER is who sold it:
- owner: use when the user asks who OWNS or BOUGHT properties (matches owner and tax-owner names)
- seller: use when the user asks who SOLD properties
- entity: use when the role is ambiguous or the user wants ALL activity/history for a company or person (matches owner OR seller). E.g. "history of Novare", "all properties associated with Novare" -> entity: "Novare"

SPECIAL FLAGS:
- show_top_owners: set to true when the user asks WHO owns a lot of / the most properties in an area RIGHT NOW. Combine with the appropriate location filter or search_text for the area, and DO NOT set owner/entity in that case.

ANY OTHER COLUMN (use when the question is about something not covered above — broker, lender, zoning, project type, builder, architect, management or leasing company, occupancy, rents, cap rate, loan, foreclosure, classification, anchors, description…):
- fields: an object { "COLUMN NAME": "text" } — rows whose column CONTAINS the text (case-insensitive). E.g. "brokered by CBRE" -> {"BROKER": "CBRE"}; "financed by Wells Fargo" -> {"LENDER": "WELLS FARGO"}; "zoned M-1" -> {"ZONING": "M-1"}. Use "*" to mean the column has ANY value: "foreclosures" -> {"FORECLOSURE DATE": "*"}; "with an asking price" -> {"ASKING PRICE": "*"}.
- ranges: an object { "COLUMN NAME": { "min": number, "max": number } } for numeric columns, e.g. "loans over $5M" -> {"PERMANENT LOAN": {"min": 5000000}}; "cap rate above 6" -> {"CAP RATE": {"min": 6}}; "more than 90% occupied" -> {"PERCENTAGE OCCUPANCY": {"min": 90}}.
Column names available (use EXACTLY): ${JSON.stringify(extraColumns)}

Respond with ONLY a JSON object: "mode", the applicable fields (omit ones that don't apply) and a short "explanation" of how you read the question. If a location or neighborhood (e.g. "Midtown", "Buckhead") isn't in the lists, use search_text (mode current) or area (mode history) instead.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: query.trim() }]
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error:', response.status, errBody);
      return res.status(502).json({ error: 'AI service error. Please try again.' });
    }

    const result = await response.json() as any;
    const text = result?.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(422).json({ error: 'Could not interpret the query. Try rephrasing.' });
    }

    let filters: any;
    try {
      filters = JSON.parse(jsonMatch[0]);
    } catch {
      return res.status(422).json({ error: 'Could not interpret the query. Try rephrasing.' });
    }

    if (filters.mode === 'history') {
      if (!dropboxConfigured()) {
        return res.status(503).json({ error: 'History questions need the Dropbox archive (Dropbox is not configured)' });
      }
      const type = DATABASES.find((d) => d.id === databaseType)?.type ?? 'APTS';
      const question = dropboxAsk.ASK_QUESTIONS.includes(filters.question) ? filters.question : 'property_history';
      const s = (v: unknown) => (typeof v === 'string' ? v : '');
      const answer = await dropboxAsk.ask({
        type, question,
        subject: s(filters.subject), entity: s(filters.entity), field: s(filters.field), area: s(filters.area),
        after: s(filters.after || filters.sale_date_after || filters.land_sale_date_after),
        before: s(filters.before || filters.sale_date_before || filters.land_sale_date_before),
      });
      const summary = await summarizeHistoryAnswer(apiKey, query.trim(), answer);
      recordUsage(req, { kind: 'ask', detail: query.trim(), databaseType, rows: typeof answer.total === 'number' ? answer.total : null });
      return res.json({ filters, history: summary ? { ...answer, summary } : answer });
    }

    recordUsage(req, { kind: 'ask', detail: query.trim(), databaseType });
    res.json({ filters });
  } catch (error) {
    console.error('Error in NL search:', error);
    res.status(500).json({ error: 'Failed to process natural language search' });
  }
});

// Preview HTML report from a stored upload (no re-upload required)
app.get('/api/uploads/:id/preview', requireAdmin, (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid upload ID' });
    }

    const uploadRecord = getUploadByIdFromDb(id);
    if (!uploadRecord) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    const excelData = getExcelDataFromDb(id);
    if (excelData.length === 0) {
      return res.status(400).json({ error: 'Upload has no data' });
    }

    const filterDate = req.query.filterDate as string | undefined;
    const { html } = buildReportHTMLFromExcelData(excelData, filterDate, uploadRecord.database_type);

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('Error previewing stored upload:', error);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

// Generate PDF from a stored upload (no re-upload required)
app.post('/api/uploads/:id/generate-pdf', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid upload ID' });
    }

    const uploadRecord = getUploadByIdFromDb(id);
    if (!uploadRecord) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    const excelData = getExcelDataFromDb(id);
    if (excelData.length === 0) {
      return res.status(400).json({ error: 'Upload has no data' });
    }

    const filterDate = (req.body?.filterDate || req.query.filterDate) as string | undefined;
    const { html, propertyCount } = buildReportHTMLFromExcelData(excelData, filterDate, uploadRecord.database_type);

    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });
    await browser.close();

    // Save report configuration
    try {
      const reportName = filterDate ? `Report - ${filterDate}` : 'Report - All Properties';
      const selectedDates = filterDate ? [filterDate] : [];
      const reportId = saveReportToDb(id, reportName, selectedDates, propertyCount);
      console.log(`✅ Saved report configuration with ID: ${reportId}`);
    } catch (dbError) {
      console.error('⚠️ Failed to save report configuration:', dbError);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=databank-property-reports.pdf');
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating PDF from stored upload:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// Get all saved reports
app.get('/api/reports', requireUser, (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const databaseType = req.query.database_type as string | undefined;

    if (databaseType) {
      const reports = db.prepare(`
        SELECT sr.*, u.original_filename, u.upload_date as source_upload_date, u.database_type,
          CASE WHEN sr.upload_id = (
            SELECT id FROM uploads u2 WHERE u2.database_type = u.database_type
            ORDER BY u2.upload_date DESC, u2.id DESC LIMIT 1
          ) THEN 1 ELSE 0 END as is_latest
        FROM saved_reports sr
        JOIN uploads u ON sr.upload_id = u.id
        WHERE u.database_type = ?
        ORDER BY sr.created_date DESC
        LIMIT ? OFFSET ?
      `).all(normalizeDatabaseType(databaseType), limit, offset) as any[];

      const reportsWithParsedDates = reports.map((report: any) => ({
        ...report,
        selected_dates: JSON.parse(report.selected_dates)
      }));

      return res.json({
        reports: reportsWithParsedDates,
        total: reportsWithParsedDates.length,
        limit,
        offset
      });
    }
    
    const reports = getReportsFromDb(limit, offset);
    const total = getReportCountFromDb();
    
    const reportsWithParsedDates = reports.map((report: any) => ({
      ...report,
      selected_dates: JSON.parse(report.selected_dates)
    }));
    
    res.json({
      reports: reportsWithParsedDates,
      total,
      limit,
      offset
    });
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// Get specific report by ID
app.get('/api/reports/:id', requireUser, (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid report ID' });
    }
    
    const report = getReportByIdFromDb(id);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    
    report.selected_dates = JSON.parse(report.selected_dates);
    res.json(report);
  } catch (error) {
    console.error('Error fetching report:', error);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

// Delete a saved report
app.delete('/api/reports/:id', requireAdmin, (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid report ID' });
    }
    
    const deleted = deleteReportFromDb(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Report not found' });
    }
    
    res.json({ success: true, message: 'Report deleted successfully' });
  } catch (error) {
    console.error('Error deleting report:', error);
    res.status(500).json({ error: 'Failed to delete report' });
  }
});

// View saved report as HTML
app.get('/api/reports/:id/view', requireUser, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid report ID' });
    }
    
    const report = getReportByIdFromDb(id);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    
    // Get the Excel data from database
    const excelData = getExcelDataFromDb(report.upload_id);
    const selectedDates = JSON.parse(report.selected_dates);
    const filterDate = selectedDates.length > 0 ? selectedDates[0] : undefined;
    
    // Build the HTML with the shared, database-type-aware report builder
    const { html } = buildReportHTMLFromExcelData(excelData, filterDate, report.database_type);

    res.setHeader('Content-Type', 'text/html');
    res.send(html);

  } catch (error) {
    console.error('Error viewing report:', error);
    res.status(500).json({ error: 'Failed to generate report view' });
  }
});

// Regenerate PDF from saved report
app.post('/api/reports/:id/regenerate-pdf', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid report ID' });
    }
    
    const report = getReportByIdFromDb(id);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    
    // Get the Excel data from database
    const excelData = getExcelDataFromDb(report.upload_id);
    const selectedDates = JSON.parse(report.selected_dates);
    const filterDate = selectedDates.length > 0 ? selectedDates[0] : undefined;
    
    // Build the HTML with the shared, database-type-aware report builder
    const { html } = buildReportHTMLFromExcelData(excelData, filterDate, report.database_type);

    // Launch Puppeteer and generate PDF
    const browser = await launchBrowser();

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    await browser.close();

    // Send the PDF as a response
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${report.report_name.replace(/[^a-zA-Z0-9]/g, '-')}.pdf`);
    res.send(pdfBuffer);

  } catch (error) {
    console.error('Error regenerating PDF:', error);
    res.status(500).json({ error: 'Failed to regenerate PDF' });
  }
});

// Health check endpoint
app.get('/api/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'ok',
    database: 'connected',
    uploadCount: getUploadCountFromDb()
  });
});

// Property Search over the Dropbox archive (weekly CSVs + per-property history)
registerDropboxRoutes(app);
registerPhotoRoutes(app, db);
registerUserRoutes(app, db);
registerNotesAiRoutes(app, db);
registerStatsRoutes(app, db);
registerUsageRoutes(app, db);
registerBackupRoutes(app, db);
registerSearchRoutes(app, {
  latestUpload: (databaseType) => (getUploadsFromDb(1, 0, databaseType)[0] as { id: number; original_filename: string } | undefined) ?? null,
  uploadData: (uploadId) => stripSensitiveColumns(getExcelDataFromDb(uploadId)) as (string | number | null)[][],
});

// Serve the built frontend (production)
const frontendDist = path.join(__dirname, '../../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req: Request, res: Response) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
  console.log(`✅ Serving frontend from: ${frontendDist}`);
}

app.use(errorMiddleware);

// Start the server
const server = app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
  if (dropboxConfigured()) {
    syncAllDatabasesFromDropbox();
    setInterval(() => syncAllDatabasesFromDropbox(), DROPBOX_SYNC_MS);
    startBackups(db);
  } else {
    console.log('Dropbox not configured — databases stay on manual uploads');
  }
  console.log(
    mailConfigured()
      ? `Feedback emails go to ${FEEDBACK_TO.join(', ')}`
      : 'SMTP_URL not set — feedback is stored on /admin only, no emails'
  );
  console.log(photosConfigured() ? 'Street View photos enabled (admin approval required)' : 'GOOGLE_MAPS_API_KEY not set — property photos off');
});

// Railway stops the previous container with SIGTERM on every deploy; exit cleanly so the
// old deployment is not reported as crashed.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`${sig} received — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
