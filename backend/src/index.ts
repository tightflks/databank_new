import express, { Request, Response } from 'express';
import multer from 'multer';
import cors from 'cors';
import * as XLSX from 'xlsx';
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
import puppeteer from 'puppeteer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
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

  CREATE TABLE IF NOT EXISTS properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unique_id TEXT UNIQUE NOT NULL,
    address TEXT,
    property_name TEXT,
    city TEXT,
    update_count INTEGER DEFAULT 1,
    latest_data TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS property_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER NOT NULL,
    upload_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    snapshot_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
    FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id INTEGER NOT NULL,
    week_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS current_records (
    business_key TEXT PRIMARY KEY,
    row_hash TEXT NOT NULL,
    all_columns TEXT NOT NULL,
    first_seen_week DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_updated_week DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id INTEGER NOT NULL,
    business_key TEXT NOT NULL,
    change_type TEXT NOT NULL,
    change_detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS history_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_key TEXT NOT NULL,
    upload_id INTEGER NOT NULL,
    field_name TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
  CREATE INDEX IF NOT EXISTS idx_property_unique_id ON properties(unique_id);
  CREATE INDEX IF NOT EXISTS idx_property_history_prop_id ON property_history(property_id);
`);

// Prepared statements for better performance
const insertUploadStmt: any = db.prepare(`
  INSERT INTO uploads (filename, original_filename, file_size, sheet_count, row_count)
  VALUES (?, ?, ?, ?, ?)
`);

const insertExcelDataStmt: any = db.prepare(`
  INSERT INTO excel_data (upload_id, row_index, data)
  VALUES (?, ?, ?)
`);

const getPropertyByUniqueIdStmt: any = db.prepare(`
  SELECT * FROM properties WHERE unique_id = ?
`);

const insertPropertyStmt: any = db.prepare(`
  INSERT INTO properties (unique_id, address, property_name, city, update_count, latest_data)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const updatePropertyStmt: any = db.prepare(`
  UPDATE properties 
  SET address = ?, property_name = ?, city = ?, update_count = update_count + 1, latest_data = ?, last_updated = CURRENT_TIMESTAMP
  WHERE unique_id = ?
`);

const insertPropertyHistoryStmt: any = db.prepare(`
  INSERT INTO property_history (property_id, upload_id, data)
  VALUES (?, ?, ?)
`);

const getUploadsStmt: any = db.prepare(`
  SELECT * FROM uploads ORDER BY upload_date DESC LIMIT ? OFFSET ?
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
  SELECT sr.*, u.original_filename, u.upload_date as source_upload_date
  FROM saved_reports sr
  JOIN uploads u ON sr.upload_id = u.id
  ORDER BY sr.created_date DESC
  LIMIT ? OFFSET ?
`);

const getReportByIdStmt: any = db.prepare(`
  SELECT sr.*, u.original_filename, u.upload_date as source_upload_date
  FROM saved_reports sr
  JOIN uploads u ON sr.upload_id = u.id
  WHERE sr.id = ?
`);

const deleteReportStmt: any = db.prepare(`
  DELETE FROM saved_reports WHERE id = ?
`);

const insertSnapshotStmt: any = db.prepare(`
  INSERT INTO snapshots (upload_id)
  VALUES (?)
`);

const insertCurrentRecordStmt: any = db.prepare(`
  INSERT INTO current_records (business_key, row_hash, all_columns, first_seen_week, last_updated_week, is_active)
  VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
  ON CONFLICT(business_key) DO UPDATE SET 
    row_hash=excluded.row_hash, 
    all_columns=excluded.all_columns, 
    last_updated_week=CURRENT_TIMESTAMP, 
    is_active=1
`);

const updateCurrentRecordStmt: any = db.prepare(`
  UPDATE current_records 
  SET row_hash = ?, all_columns = ?, last_updated_week = CURRENT_TIMESTAMP, is_active = 1
  WHERE business_key = ?
`);

const deactivateCurrentRecordStmt: any = db.prepare(`
  UPDATE current_records SET is_active = 0 WHERE business_key = ?
`);

const getCurrentRecordStmt: any = db.prepare(`
  SELECT * FROM current_records WHERE business_key = ?
`);

const getAllCurrentRecordsStmt: any = db.prepare(`
  SELECT business_key, row_hash, all_columns FROM current_records WHERE is_active = 1
`);

const insertChangeLogStmt: any = db.prepare(`
  INSERT INTO change_log (upload_id, business_key, change_type)
  VALUES (?, ?, ?)
`);

const insertHistoryRecordStmt: any = db.prepare(`
  INSERT INTO history_records (business_key, upload_id, field_name, old_value, new_value)
  VALUES (?, ?, ?, ?, ?)
`);

// Database helper functions
function saveUploadToDb(filename: string, originalFilename: string, fileSize: number, sheetCount: number, excelData: any[][]): number {
  const transaction = db.transaction(() => {
    // Insert upload metadata
    const result = insertUploadStmt.run(
      filename,
      originalFilename,
      fileSize,
      sheetCount,
      excelData.length
    );
    const uploadId = result.lastInsertRowid as number;
    
    // Create snapshot record
    insertSnapshotStmt.run(uploadId);

    const headers = excelData[0] || [];
    const getColIndex = (colName: string) => headers.findIndex((h: string) => h && typeof h === 'string' && h.trim() === colName);
    const getCellValue = (row: any[], colName: string) => {
      const idx = getColIndex(colName);
      return idx !== -1 && row[idx] !== undefined && row[idx] !== null ? String(row[idx]).trim() : '';
    };

    // Keep track of keys seen in this upload
    const seenBusinessKeys = new Set<string>();

    // Load existing active current_records for comparison
    const existingRecords = getAllCurrentRecordsStmt.all();
    const existingMap = new Map<string, any>();
    for (const record of existingRecords) {
      existingMap.set(record.business_key, record);
    }

    // Insert Excel rows and properties
    for (let i = 0; i < excelData.length; i++) {
      const rowData = JSON.stringify(excelData[i]);
      insertExcelDataStmt.run(
        uploadId,
        i,
        rowData
      );

      // Skip header row for properties logic
      if (i > 0 && Array.isArray(excelData[i])) {
        const row = excelData[i];
        const propName = getCellValue(row, 'P NAME');
        const streetNumber = getCellValue(row, 'P STREET NUMBER');
        const streetName = getCellValue(row, 'P STREET NAME');
        const city = getCellValue(row, 'P CITY');
        const zip = getCellValue(row, 'P ZIP');
        const parcel = getCellValue(row, 'PARCEL');

        if (propName || streetName) {
          const address = `${streetNumber} ${streetName}`.trim();
          
          // Generate Business Key
          const businessKey = `${address}-${city}-${zip}-${parcel}`.toLowerCase().replace(/[^a-z0-9]/g, '');

          if (businessKey) {
            seenBusinessKeys.add(businessKey);
            
            // Generate Row Hash
            const rowHash = crypto.createHash('sha256').update(rowData).digest('hex');
            
            // Check if it exists
            const existing = existingMap.get(businessKey);

            if (!existing) {
              // ADDED
              insertCurrentRecordStmt.run(businessKey, rowHash, rowData);
              insertChangeLogStmt.run(uploadId, businessKey, 'Added');
              
              // Also keep backward compatibility
              const existingProp = getPropertyByUniqueIdStmt.get(businessKey);
              if (!existingProp) {
                const insertResult = insertPropertyStmt.run(businessKey, address, propName, city, 1, rowData);
                insertPropertyHistoryStmt.run(insertResult.lastInsertRowid, uploadId, rowData);
              } else {
                updatePropertyStmt.run(address, propName, city, rowData, businessKey);
                insertPropertyHistoryStmt.run(existingProp.id, uploadId, rowData);
              }
              
              // Add to map so duplicates in the same file are treated as updates
              existingMap.set(businessKey, {
                business_key: businessKey,
                row_hash: rowHash,
                all_columns: rowData
              });
            } else {
              if (existing.row_hash !== rowHash) {
                // UPDATED
                updateCurrentRecordStmt.run(rowHash, rowData, businessKey);
                insertChangeLogStmt.run(uploadId, businessKey, 'Updated');
                
                // Diff the fields to save to history_records
                try {
                  const oldRow = JSON.parse(existing.all_columns);
                  const newRow = excelData[i];
                  for (let c = 0; c < headers.length; c++) {
                    const header = headers[c];
                    if (header && typeof header === 'string') {
                      const oldVal = String(oldRow[c] || '').trim();
                      const newVal = String(newRow[c] || '').trim();
                      if (oldVal !== newVal) {
                        insertHistoryRecordStmt.run(businessKey, uploadId, header, oldVal, newVal);
                      }
                    }
                  }
                } catch(e) {
                   console.error("Error diffing rows:", e);
                }
                
                // Backward compatibility
                updatePropertyStmt.run(address, propName, city, rowData, businessKey);
                const existingProp = getPropertyByUniqueIdStmt.get(businessKey);
                if (existingProp) insertPropertyHistoryStmt.run(existingProp.id, uploadId, rowData);
              } else {
                // UNCHANGED
                // We do not add to change_log to save space or maybe add 'Unchanged' if needed.
                // Based on diagram we can track unchanged, but usually it's implied.
                
                // Keep backward compatibility so it shows in property history
                const existingProp = getPropertyByUniqueIdStmt.get(businessKey);
                if (existingProp) insertPropertyHistoryStmt.run(existingProp.id, uploadId, rowData);
              }
            }
          }
        }
      }
    }

    // Detect DELETED records
    for (const [businessKey, record] of existingMap.entries()) {
      if (!seenBusinessKeys.has(businessKey)) {
        deactivateCurrentRecordStmt.run(businessKey);
        insertChangeLogStmt.run(uploadId, businessKey, 'Deleted');
      }
    }

    return uploadId;
  });

  return transaction();
}

function getUploadsFromDb(limit: number = 50, offset: number = 0): any[] {
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
app.use(cors());
app.use(express.json());

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
app.post('/api/dates', upload.single('file'), async (req: Request, res: Response) => {
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
        jsonData
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

// Global Search for Properties (across all uploads)
app.get('/api/properties/search', (req: Request, res: Response) => {
  try {
    const props = db.prepare(`
      SELECT p.*, 
             (SELECT upload_id FROM property_history ph WHERE ph.property_id = p.id ORDER BY snapshot_date DESC LIMIT 1) as latest_upload_id
      FROM properties p
    `).all();

    const uploadIds = [...new Set(props.map((p: any) => p.latest_upload_id))];
    const headersMap = new Map();

    for (const uId of uploadIds) {
      if (uId) {
        const headerRow = db.prepare(`SELECT data FROM excel_data WHERE upload_id = ? AND row_index = 0`).get(uId);
        if (headerRow) {
          headersMap.set(uId, JSON.parse(headerRow.data));
        }
      }
    }

    const processedProperties = props.map((p: any) => {
      const row = JSON.parse(p.latest_data);
      const headers = headersMap.get(p.latest_upload_id) || [];
      const getColIndex = (colName: string) => headers.findIndex((h: string) => h && typeof h === 'string' && h.trim() === colName);

      const getCellValue = (colName: string) => {
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

      return {
        id: p.id,
        propertyName: p.property_name,
        city: p.city,
        county: getCellValue('COUNTY'),
        marketArea: getCellValue('MARKET AREA'),
        insiderDate: getCellValue('INSIDER DATE'),
        propertyType: getCellValue('P TYPE'),
        salePrice: getCellValue('SALE PRICE'),
        saleDate: getCellValue('SALE DATE'),
        units: getCellValue('UNITS COMPLETED'),
        address: p.address,
        zip: getCellValue('P ZIP'),
        taxOwner: getCellValue('TAX OWNER'),
        district: getCellValue('DISTRICT2'),
        parcel: getCellValue('PARCEL'),
        loanAmount: getCellValue('$ LOAN'),
        update_count: p.update_count,
        last_updated: p.last_updated,
        historyText: p.history_text || ''
      };
    });

    const cities = [...new Set(processedProperties.map((p: any) => p.city).filter(Boolean))].sort();
    const counties = [...new Set(processedProperties.map((p: any) => p.county).filter(Boolean))].sort();
    const marketAreas = [...new Set(processedProperties.map((p: any) => p.marketArea).filter(Boolean))].sort();
    const dates = [...new Set(processedProperties.map((p: any) => p.insiderDate).filter(Boolean))].sort().reverse();
    
    const prices = processedProperties.map((p: any) => parseFloat(p.salePrice?.replace(/[^0-9.-]/g, '') || '0')).filter((p: number) => p > 0);
    const priceRange = prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : { min: 0, max: 0 };

    const unitsValues = processedProperties.map((p: any) => parseInt(p.units?.replace(/[^0-9]/g, '') || '0')).filter((u: number) => u > 0);
    const unitsRange = unitsValues.length > 0 ? { min: Math.min(...unitsValues), max: Math.max(...unitsValues) } : { min: 0, max: 0 };

    res.json({
      properties: processedProperties,
      filters: { cities, counties, marketAreas, dates, priceRange, unitsRange }
    });

  } catch (error) {
    console.error('Error in property global search:', error);
    res.status(500).json({ error: 'Failed to search properties' });
  }
});

// Get Property History
app.get('/api/properties/:id/history', (req: Request, res: Response) => {
  try {
    const propertyId = req.params.id;
    const history = db.prepare(`
      SELECT ph.*, u.original_filename, u.upload_date 
      FROM property_history ph
      JOIN uploads u ON ph.upload_id = u.id
      WHERE ph.property_id = ?
              ORDER BY ph.snapshot_date DESC
    `).all(propertyId);
    
    const parsedHistory = history.map((h: any) => {
      const row = JSON.parse(h.data);
      const headerRow = db.prepare(`SELECT data FROM excel_data WHERE upload_id = ? AND row_index = 0`).get(h.upload_id);
      const headers = headerRow ? JSON.parse(headerRow.data) : [];
      
      const getColIndex = (colName: string) => headers.findIndex((h: string) => h && typeof h === 'string' && h.trim() === colName);
      const getCellValue = (colName: string) => {
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

      return {
        id: h.id,
        upload_id: h.upload_id,
        original_filename: h.original_filename,
        upload_date: h.upload_date,
        snapshot_date: h.snapshot_date,
        salePrice: getCellValue('SALE PRICE'),
        saleDate: getCellValue('SALE DATE'),
        taxOwner: getCellValue('TAX OWNER'),
        insiderDate: getCellValue('INSIDER DATE'),
        units: getCellValue('UNITS COMPLETED'),
        district: getCellValue('DISTRICT2'),
        loanAmount: getCellValue('$ LOAN')
      };
    });
    
    res.json({ history: parsedHistory });
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch property history' });
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
          return `${ String(excelDate.m).padStart(2, '0') } /${String(excelDate.d).padStart(2, '0')}/${ excelDate.y } `;
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
      address: `${ getCellValue(row, 'P STREET NUMBER') } ${ getCellValue(row, 'P STREET NAME') } `.trim(),
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
        jsonData
      );
      console.log(`✅ Saved upload to database with ID: ${ uploadId } `);
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
app.post('/api/convert-html', upload.single('file'), async (req: Request, res: Response) => {
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
              cellValue = `${ String(excelDate.m).padStart(2, '0') } /${String(excelDate.d).padStart(2, '0')}/${ excelDate.y } `;
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
          return `${ String(excelDate.m).padStart(2, '0') } /${String(excelDate.d).padStart(2, '0')}/${ excelDate.y } `;
        }
      }
      
      return String(value).trim();
    };

    const formatValue = (value: string, format?: string, row?: any[], concat?: string) => {
      if (!value) return '';
      
      if (concat && row) {
        const concatValue = getCellValue(row, concat);
        if (format === 'units') return `${ value } / ${concatValue}`;
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
              jsonData
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
    app.post('/api/preview-html', upload.single('file'), async (req: Request, res: Response) => {
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
    app.post('/api/convert', upload.single('file'), async (req: Request, res: Response) => {
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

        const uploads = getUploadsFromDb(limit, offset);
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
    app.delete('/api/uploads/:id', (req: Request, res: Response) => {
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

    // Get all saved reports
    app.get('/api/reports', (req: Request, res: Response) => {
      try {
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;

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
    app.delete('/api/reports/:id', (req: Request, res: Response) => {
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

        // Filter data by insider date if specified
        let filteredData = excelData;
        if (filterDate) {
          const headers = excelData[0] as string[];
          const dateColumnIndex = headers.findIndex((h: string) => h && h.toLowerCase().trim() === 'insider date');

          if (dateColumnIndex >= 0) {
            const dataRows = excelData.slice(1).filter((row: any[]) => {
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

        // Use the same field mapping from the convert endpoint
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

        const properties = dataRows.map(row => {
          const propertyName = getCellValue(row, 'P NAME');
          if (!propertyName) return null;

          const profileFields = FIELD_MAPPING.propertyProfile.map((field: any) => ({
            label: field.label,
            value: field.concat
              ? `${getCellValue(row, field.excel)} ${getCellValue(row, field.concat)}`.trim()
              : getCellValue(row, field.excel)
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
            value: formatValue(getCellValue(row, field.excel), field.format)
          }));

          const broker = FIELD_MAPPING.broker.map((field: any) => ({
            label: field.label,
            value: formatValue(getCellValue(row, field.excel), field.format)
          }));

          const leasingCompany = FIELD_MAPPING.leasingCompany.map((field: any) => ({
            label: field.label,
            value: formatValue(getCellValue(row, field.excel), field.format)
          }));

          const seller = FIELD_MAPPING.seller.map((field: any) => ({
            label: field.label,
            value: formatValue(getCellValue(row, field.excel), field.format)
          }));

          const lender = FIELD_MAPPING.lender.map((field: any) => ({
            label: field.label,
            value: formatValue(getCellValue(row, field.excel), field.format)
          }));

          const commentsValue = typeof FIELD_MAPPING.comments === 'object' && 'excel' in FIELD_MAPPING.comments
            ? getCellValue(row, FIELD_MAPPING.comments.excel)
            : '';

          return {
            propertyName,
            profileFields,
            detailsFields,
            financialFields,
            unitBreakout,
            owner,
            broker,
            leasingCompany,
            seller,
            lender,
            comments: commentsValue
          };
        }).filter(Boolean);

        // Generate HTML (same template as preview endpoint)
        const html = generatePropertyReportHTML(properties, FIELD_MAPPING);

        res.setHeader('Content-Type', 'text/html');
        res.send(html);

      } catch (error) {
        console.error('Error viewing report:', error);
        res.status(500).json({ error: 'Failed to generate report view' });
      }
    });

    // Regenerate PDF from saved report
    app.post('/api/reports/:id/regenerate-pdf', async (req: Request, res: Response) => {
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

        // Filter data by insider date if specified (same logic as view endpoint)
        let filteredData = excelData;
        if (filterDate) {
          const headers = excelData[0] as string[];
          const dateColumnIndex = headers.findIndex((h: string) => h && h.toLowerCase().trim() === 'insider date');

          if (dateColumnIndex >= 0) {
            const dataRows = excelData.slice(1).filter((row: any[]) => {
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

        // Use the same field mapping
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

        const properties = dataRows.map(row => {
          const propertyName = getCellValue(row, 'P NAME');
          if (!propertyName) return null;

          const profileFields = FIELD_MAPPING.propertyProfile.map((field: any) => ({
            label: field.label,
            value: field.concat
              ? `${getCellValue(row, field.excel)} ${getCellValue(row, field.concat)}`.trim()
              : getCellValue(row, field.excel)
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
            value: formatValue(getCellValue(row, field.excel), field.format)
          }));

          const broker = FIELD_MAPPING.broker.map((field: any) => ({
            label: field.label,
            value: formatValue(getCellValue(row, field.excel), field.format)
          }));

          const leasingCompany = FIELD_MAPPING.leasingCompany.map((field: any) => ({
            label: field.label,
            value: formatValue(getCellValue(row, field.excel), field.format)
          }));

          const seller = FIELD_MAPPING.seller.map((field: any) => ({
            label: field.label,
            value: formatValue(getCellValue(row, field.excel), field.format)
          }));

          const lender = FIELD_MAPPING.lender.map((field: any) => ({
            label: field.label,
            value: formatValue(getCellValue(row, field.excel), field.format)
          }));

          const commentsValue = typeof FIELD_MAPPING.comments === 'object' && 'excel' in FIELD_MAPPING.comments
            ? getCellValue(row, FIELD_MAPPING.comments.excel)
            : '';

          return {
            propertyName,
            profileFields,
            detailsFields,
            financialFields,
            unitBreakout,
            owner,
            broker,
            leasingCompany,
            seller,
            lender,
            comments: commentsValue
          };
        }).filter(Boolean);

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

    // Start the server
    
// ----------------------------------------------------
// COMPARISON ENGINE API
// ----------------------------------------------------
app.get('/api/comparison/:uploadId', (req: Request, res: Response) => {
  try {
    const uploadId = parseInt(req.params.uploadId);
    
    // Get upload info
    const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId);
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    // Get changes
    const changes = db.prepare(`
      SELECT cl.*, cr.all_columns 
      FROM change_log cl
      LEFT JOIN current_records cr ON cl.business_key = cr.business_key
      WHERE cl.upload_id = ?
    `).all(uploadId);

    const added = [];
    const updated = [];
    const deleted = [];

    // Get history for updated
    const historyRows = db.prepare('SELECT * FROM history_records WHERE upload_id = ?').all(uploadId);
    const historyMap = new Map();
    for (const h of historyRows) {
      if (!historyMap.has(h.business_key)) historyMap.set(h.business_key, []);
      historyMap.get(h.business_key).push({
        field: h.field_name,
        old_value: h.old_value,
        new_value: h.new_value
      });
    }

    // Get header for this upload for mapping
    const headerRow = db.prepare(`SELECT data FROM excel_data WHERE upload_id = ? AND row_index = 0`).get(uploadId);
    const headers = headerRow ? JSON.parse(headerRow.data) : [];
    const getColIndex = (colName: string) => headers.findIndex((h: string) => h && typeof h === 'string' && h.trim() === colName);
    
    for (const change of changes) {
      let recordData: any = {};
      if (change.all_columns) {
        const row = JSON.parse(change.all_columns);
        const getCellValue = (colName: string) => {
          const idx = getColIndex(colName);
          return idx !== -1 && row[idx] !== undefined && row[idx] !== null ? String(row[idx]).trim() : '';
        };
        
        recordData = {
          businessKey: change.business_key,
          propertyName: getCellValue('P NAME'),
          city: getCellValue('P CITY'),
          address: `${getCellValue('P STREET NUMBER')} ${getCellValue('P STREET NAME')}`.trim(),
          salePrice: getCellValue('SALE PRICE'),
          saleDate: getCellValue('SALE DATE'),
          units: getCellValue('UNITS COMPLETED'),
        };
      } else {
        recordData = { businessKey: change.business_key, address: change.business_key }; // fallback for deleted
      }

      if (change.change_type === 'Added') {
        added.push(recordData);
      } else if (change.change_type === 'Updated') {
        recordData.changes = historyMap.get(change.business_key) || [];
        updated.push(recordData);
      } else if (change.change_type === 'Deleted') {
        deleted.push(recordData);
      }
    }

    res.json({
      upload,
      summary: {
        added: added.length,
        updated: updated.length,
        deleted: deleted.length
      },
      data: {
        added,
        updated,
        deleted
      }
    });

  } catch (error) {
    console.error('Error fetching comparison:', error);
    res.status(500).json({ error: 'Failed to fetch comparison data' });
  }
});app.listen(port, () => {
      console.log(`Server is running on http://localhost:${port}`);
    });
