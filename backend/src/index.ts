import express, { Request, Response } from 'express';
import multer from 'multer';
import cors from 'cors';
import * as XLSX from 'xlsx';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import path from 'path';
import fs from 'fs';

const app = express();
const port = process.env.PORT || 3001;

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

// Middleware
app.use(cors());
app.use(express.json());

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Create uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, '../../uploads');
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
    
    res.json({ dates: result, columnIndex: dateColumnIndex });

  } catch (error) {
    console.error('Error extracting dates:', error);
    res.status(500).json({ error: 'Failed to extract dates from file' });
  }
});

// Convert Excel to PDF endpoint
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
    let y = pageHeight - 60;
    
    currentPage.drawText('Table of Contents', {
      x: 50,
      y,
      size: 24,
      font: titleFont,
      color: rgb(0, 0, 0.8),
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
    res.setHeader('Content-Disposition', 'attachment; filename=converted.pdf');
    res.send(Buffer.from(pdfBytes));

  } catch (error) {
    console.error('Error converting file:', error);
    res.status(500).json({ error: 'Failed to convert file' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
