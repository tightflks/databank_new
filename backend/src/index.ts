import 'dotenv/config';
import express, { Request, Response } from 'express';
import multer from 'multer';
import cors from 'cors';
import * as XLSX from 'xlsx';
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { registerDropboxRoutes, dropboxConfigured, latestSheet, DATABASES } from './dropbox';
import * as dropboxAsk from './dropbox';
import { registerAuthRoutes, requireAdmin, rateLimit } from './auth';
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
  return rows.map((row: any) => JSON.parse(row.data));
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
function generatePropertyReportHTML(properties: any[], fieldMapping: any): string {
  const formatCurrency = (value: string) => {
    if (!value) return '-';
    const num = parseFloat(value.replace(/[^0-9.-]/g, ''));
    if (isNaN(num)) return '-';
    return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

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
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        body {
          font-family: 'Inter', 'Segoe UI', 'Helvetica Neue', 'Arial', sans-serif;
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
          font-weight: 800;
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
          font-weight: 300;
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
          font-weight: 500;
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
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
registerAuthRoutes(app);

const ASK_AI_PER_HOUR = Number(process.env.ASK_AI_PER_HOUR) || 30;

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

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

// Search/Browse Excel data endpoint
app.post('/api/search', upload.single('file'), async (req: Request, res: Response) => {
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

    const headers = jsonData[0] as string[];
    const dataRows = jsonData.slice(1);

    // Helper to get column index
    const getColIndex = (colName: string) => {
      return headers.findIndex(h => h && h.trim() === colName);
    };

    // Helper to get cell value with date conversion
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
      
      return String(value).trim();
    };

    // Extract all properties with relevant fields
    const properties = dataRows.map((row, index) => ({
      id: index,
      propertyName: getCellValue(row, 'P NAME'),
      city: getCellValue(row, 'P CITY'),
      county: getCellValue(row, 'COUNTY'),
      marketArea: getCellValue(row, 'MARKET AREA'),
      insiderDate: getCellValue(row, 'INSIDER DATE'),
      propertyType: getCellValue(row, 'P TYPE'),
      salePrice: getCellValue(row, 'SALE PRICE'),
      saleDate: getCellValue(row, 'SALE DATE'),
      units: getCellValue(row, 'UNITS COMPLETED'),
      address: `${getCellValue(row, 'P STREET NUMBER')} ${getCellValue(row, 'P STREET NAME')}`.trim(),
      zip: getCellValue(row, 'P ZIP'),
      taxOwner: getCellValue(row, 'TAX OWNER'),
    })).filter(p => p.propertyName); // Only include rows with property names

    // Extract unique filter options
    const cities = [...new Set(properties.map(p => p.city).filter(Boolean))].sort();
    const counties = [...new Set(properties.map(p => p.county).filter(Boolean))].sort();
    const marketAreas = [...new Set(properties.map(p => p.marketArea).filter(Boolean))].sort();
    const dates = [...new Set(properties.map(p => p.insiderDate).filter(Boolean))].sort().reverse();

    // Get price range
    const prices = properties
      .map(p => parseFloat(p.salePrice?.replace(/[^0-9.-]/g, '') || '0'))
      .filter(p => p > 0);
    const priceRange = prices.length > 0 ? {
      min: Math.min(...prices),
      max: Math.max(...prices)
    } : { min: 0, max: 0 };

    // Get units range
    const unitsValues = properties
      .map(p => parseInt(p.units?.replace(/[^0-9]/g, '') || '0'))
      .filter(u => u > 0);
    const unitsRange = unitsValues.length > 0 ? {
      min: Math.min(...unitsValues),
      max: Math.max(...unitsValues)
    } : { min: 0, max: 0 };

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

    res.json({
      properties,
      filters: {
        cities,
        counties,
        marketAreas,
        dates,
        priceRange,
        unitsRange
      },
      total: properties.length
    });

  } catch (error) {
    console.error('Error searching data:', error);
    res.status(500).json({ error: 'Failed to search data' });
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
      
      return String(value).trim();
    };

    const formatValue = (value: string, format?: string, row?: any[], concat?: string) => {
      if (!value) return '';
      
      if (concat && row) {
        const concatValue = getCellValue(row, concat);
        if (format === 'units') return `${value} / ${concatValue}`;
        if (format === 'acres') return `${value} / ${concatValue}`;
        return `${value} ${concatValue}`.trim();
      }
      
      if (format === 'currency' && value) {
        const num = parseFloat(value.replace(/[^0-9.-]/g, ''));
        if (!isNaN(num)) return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }
      
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
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    
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
      
      return String(value).trim();
    };

    const formatValue = (value: string, format?: string, row?: any[], concat?: string) => {
      if (!value) return '';
      
      if (concat && row) {
        const concatValue = getCellValue(row, concat);
        if (format === 'units') return `${value} / ${concatValue}`;
        if (format === 'acres') return `${value} / ${concatValue}`;
        return `${value} ${concatValue}`.trim();
      }
      
      if (format === 'currency' && value) {
        const num = parseFloat(value.replace(/[^0-9.-]/g, ''));
        if (!isNaN(num)) return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }
      
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
      
      return String(value).trim();
    };
    
    // Format value based on type
    const formatValue = (value: string, format?: string, row?: any[], concat?: string) => {
      if (!value) return '';
      
      if (concat && row) {
        const concatValue = getCellValue(row, concat);
        if (format === 'units') return `${value} / ${concatValue}`;
        if (format === 'acres') return `${value} / ${concatValue}`;
        return `${value} ${concatValue}`.trim();
      }
      
      if (format === 'currency' && value) {
        const num = parseFloat(value.replace(/[^0-9.-]/g, ''));
        if (!isNaN(num)) return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }
      
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
app.get('/api/uploads', (req: Request, res: Response) => {
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
app.get('/api/uploads/:id', (req: Request, res: Response) => {
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
app.get('/api/uploads/:id/data', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid upload ID' });
    }
    
    const upload = getUploadByIdFromDb(id);
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }
    
    const excelData = getExcelDataFromDb(id);
    
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
app.get('/api/databases', (req: Request, res: Response) => {
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

async function syncAllDatabasesFromDropbox(): Promise<DropboxSyncResult[]> {
  const results: DropboxSyncResult[] = [];
  for (const type of DATABASE_TYPES) results.push(await syncDatabaseFromDropbox(type));
  return results;
}

app.post('/api/databases/sync-dropbox', requireAdmin, async (req: Request, res: Response) => {
  if (!dropboxConfigured()) {
    return res.status(400).json({ error: 'Dropbox is not configured (DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN)' });
  }
  res.json({ results: await syncAllDatabasesFromDropbox() });
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
app.get('/api/uploads/:id/dates', (req: Request, res: Response) => {
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
    return String(value).trim();
  };

  const formatCurrencyValue = (value: string) => {
    const num = parseFloat(value.replace(/[^0-9.-]/g, ''));
    if (isNaN(num)) return value;
    return `$${num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
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
    if (format === 'currency' && value) {
      const num = parseFloat(value.replace(/[^0-9.-]/g, ''));
      if (!isNaN(num)) return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
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

app.post('/api/nl-search', rateLimit(ASK_AI_PER_HOUR), async (req: Request, res: Response) => {
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

(A) mode "current" — a search over this week's list of ${databaseType} properties (the default). Filter fields are below.

(B) mode "history" — the question needs MORE THAN ONE WEEK of data: previous owners, who bought/sold a specific property, its sale history or timeline, what changed on a record, properties sold more than once, what appeared or dropped off the list, most active buyers/sellers over a period. For history set:
- question: one of ${JSON.stringify(dropboxAsk.ASK_QUESTIONS)}
    property_history = who owned / bought / sold / paid for a NAMED property, its previous owners, sale history, what changed on it (set subject)
    entity_history   = everything a company or person has bought or sold over time (set entity). Prefer this over mode current when the user says "ever", "history", "over the years", "since <year>"
    repeat_sales     = properties that sold / traded more than once, flipped
    changes          = records that changed in a period; set field to a column name (e.g. "SALE PRICE", "TAX OWNER", "UNITS COMPLETED:") when the user asks about one kind of change
    new              = properties added to the database / first published in a period
    removed          = properties that dropped off / were removed from the list in a period
    top_buyers       = who bought the most properties in a period (most active buyers)
    top_sellers      = who sold the most properties in a period
- subject: the property as the user named it (name, address or parcel number) — for property_history
- entity: the company / person — for entity_history
- field: column name — for changes
- after / before: ISO dates (YYYY-MM-DD) bounding the period, when the user gives one ("since 2024" -> after 2024-01-01; "in 2023" -> both)
- area: a city, county, zip, or neighbourhood word to narrow to, if any
Do NOT set the mode-current filters for a history question.

For mode "current", the database contains ${databaseType} properties with these filterable fields:

LOCATION FILTERS (match values EXACTLY as listed, case-sensitive):
- counties: an ARRAY of values from ${JSON.stringify(counties)}. Include ALL variants that match the user's intent.
- city: one of ${JSON.stringify(cities)}
- market_area: one of ${JSON.stringify(marketAreas)}
- zipcode: one of ${JSON.stringify(zipcodes)}
- district: one of ${JSON.stringify(districts)}
- land_lot: one of ${JSON.stringify(landLots)}

DATE RANGE FILTERS (use ISO format YYYY-MM-DD):
- insider_date_after / insider_date_before: INSIDER DATE (when record was published)
- sale_date_after / sale_date_before: property SALE DATE
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
- search_text: free text matched against property name, description, address, owner, seller, and all other text fields

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
        after: s(filters.after), before: s(filters.before),
      });
      return res.json({ filters, history: answer });
    }

    res.json({ filters });
  } catch (error) {
    console.error('Error in NL search:', error);
    res.status(500).json({ error: 'Failed to process natural language search' });
  }
});

// Preview HTML report from a stored upload (no re-upload required)
app.get('/api/uploads/:id/preview', (req: Request, res: Response) => {
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

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
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
app.get('/api/reports', (req: Request, res: Response) => {
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
app.get('/api/reports/:id', (req: Request, res: Response) => {
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
app.get('/api/reports/:id/view', async (req: Request, res: Response) => {
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
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    
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

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
  if (dropboxConfigured()) {
    syncAllDatabasesFromDropbox();
    setInterval(syncAllDatabasesFromDropbox, DROPBOX_SYNC_MS);
  } else {
    console.log('Dropbox not configured — databases stay on manual uploads');
  }
});
