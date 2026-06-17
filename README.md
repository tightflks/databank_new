# Databank

A modern property analysis platform that converts Excel files to professional PDF reports and provides powerful search capabilities for real estate comparables.

## Tech Stack

### Backend
- **Node.js** with **Express** - Fast, minimal web framework
- **TypeScript** - Type safety and better developer experience
- **better-sqlite3** - Fast SQLite database for data persistence
- **xlsx** - Excel file parsing
- **pdf-lib** - PDF generation
- **multer** - File upload handling
- **cors** - Cross-origin resource sharing

### Frontend
- **React 19** - Modern UI library
- **Vite** - Next-generation frontend tooling
- **TypeScript** - Type safety
- **TailwindCSS** - Utility-first CSS framework
- **Lucide React** - Beautiful icon library
- **Axios** - HTTP client

## Project Structure

```
excel-to-pdf/
├── backend/
│   ├── src/
│   │   └── index.ts        # Main server file
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx         # Main React component
│   │   ├── index.css       # TailwindCSS imports
│   │   └── main.tsx        # React entry point
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── tsconfig.json
└── README.md
```

## Getting Started

### Prerequisites
- Node.js (v18 or higher)
- npm or yarn

### Installation

1. **Install Backend Dependencies**
   ```bash
   cd backend
   npm install
   ```

2. **Install Frontend Dependencies**
   ```bash
   cd frontend
   npm install
   ```

### Running the Application

1. **Start the Backend Server** (Terminal 1)
   ```bash
   cd backend
   npm run dev
   ```
   Server runs on: `http://localhost:3001`

2. **Start the Frontend** (Terminal 2)
   ```bash
   cd frontend
   npm run dev
   ```
   App runs on: `http://localhost:3000`

3. **Open your browser** and navigate to `http://localhost:3000`

## Usage

1. **Upload** - Drag and drop an Excel file or click to browse
2. **Select Date** - Choose which Insider Date to filter by
3. **Generate** - Click "Generate PDF" to create structured reports
4. **Download** - The PDF will automatically download with:
   - Table of Contents page
   - Individual property reports with organized sections

## Features

✅ **Smart Excel Parsing**
- Supports .xlsx and .xls files
- Automatic Excel date conversion
- Handles 200+ column spreadsheets
- Finds "Insider Date" column automatically

✅ **Date-Based Filtering**
- Extract unique dates from Excel
- Sort dates (latest first)
- Show report count per date
- Filter data by selected date

✅ **Professional PDF Reports**
- Table of Contents with all properties
- Individual property pages with sections:
  - Property Profile
  - Property Details  
  - Financial Highlights
  - Comments
- Two-column layout for efficient space usage
- Currency formatting ($XX,XXX.XX)
- Automatic text wrapping and truncation
- Automatic pagination

✅ **Modern UI/UX**
- Drag-and-drop file upload
- Multi-step workflow (Upload → Select → Generate)
- File validation
- Loading states
- Error handling
- Success feedback
- Responsive design

## API Endpoints

### `POST /api/dates`
Extract unique Insider Dates from Excel file.

**Request:**
- Method: `POST`
- Content-Type: `multipart/form-data`
- Body: `file` (Excel file)

**Response:**
```json
{
  "dates": [
    { "date": "12/31/2021", "count": 5 },
    { "date": "11/15/2021", "count": 3 }
  ],
  "columnIndex": 163
}
```

### `POST /api/convert`
Converts Excel file to structured PDF reports.

**Request:**
- Method: `POST`
- Content-Type: `multipart/form-data`
- Body: 
  - `file` (Excel file)
  - `insiderDate` (optional, filters by date)

**Response:**
- Content-Type: `application/pdf`
- Body: PDF file buffer

### `GET /api/health`
Health check endpoint.

**Response:**
```json
{ 
  "status": "ok",
  "database": "connected",
  "uploadCount": 5
}
```

### Database Management Endpoints

#### `GET /api/uploads`
Get all saved Excel uploads.

**Query Parameters:**
- `limit` (optional, default: 50) - Number of results per page
- `offset` (optional, default: 0) - Pagination offset

**Response:**
```json
{
  "uploads": [
    {
      "id": 1,
      "filename": "properties.xlsx",
      "original_filename": "properties.xlsx",
      "upload_date": "2024-01-15 10:30:00",
      "file_size": 245760,
      "sheet_count": 1,
      "row_count": 150
    }
  ],
  "total": 10,
  "limit": 50,
  "offset": 0
}
```

#### `GET /api/uploads/:id`
Get details of a specific upload.

**Response:**
```json
{
  "id": 1,
  "filename": "properties.xlsx",
  "original_filename": "properties.xlsx",
  "upload_date": "2024-01-15 10:30:00",
  "file_size": 245760,
  "sheet_count": 1,
  "row_count": 150
}
```

#### `GET /api/uploads/:id/data`
Get Excel data for a specific upload.

**Response:**
```json
{
  "upload": { /* upload metadata */ },
  "data": [
    ["Header1", "Header2", "Header3"],
    ["Value1", "Value2", "Value3"]
  ],
  "rowCount": 150
}
```

#### `DELETE /api/uploads/:id`
Delete a saved upload and its data.

**Response:**
```json
{
  "success": true,
  "message": "Upload deleted successfully"
}
```

## Data Persistence

✅ **SQLite Database**
- All Excel uploads are automatically saved to a local SQLite database
- Data persists across server restarts
- Database location: `backend/data/databank.db`
- Uses WAL mode for better performance
- Automatic indexing for fast queries

**Database Schema:**
- `uploads` - Stores upload metadata (filename, date, size, etc.)
- `excel_data` - Stores the actual Excel rows as JSON
- Foreign key constraints ensure data integrity

## Development

### Backend Development
```bash
cd backend
npm run dev    # Starts with nodemon for auto-reload
```

### Frontend Development
```bash
cd frontend
npm run dev    # Starts Vite dev server with HMR
```

### Building for Production

**Backend:**
```bash
cd backend
npm run build  # Compiles TypeScript to JavaScript
npm run serve  # Runs the compiled version
```

**Frontend:**
```bash
cd frontend
npm run build  # Builds optimized production bundle
npm run preview # Preview production build
```

## Future Enhancements (Post-MVP)

- 🎨 Multiple style templates (professional, modern, classic)
- 📊 Chart generation from Excel data
- 🖼️ Logo/image embedding
- 📝 Custom headers and footers
- 🎯 Column width customization
- 📋 Multi-sheet support
- 💾 Save conversion preferences
- 🔐 User authentication
- ☁️ Cloud storage integration

## Best Practices Implemented

- ✅ **TypeScript** throughout for type safety
- ✅ **Modular architecture** for easy maintenance
- ✅ **Error handling** on both frontend and backend
- ✅ **CORS** configured for security
- ✅ **Validation** on file types and sizes
- ✅ **Modern UI/UX** with loading and success states
- ✅ **Clean code** with clear separation of concerns
- ✅ **Scalable structure** ready for new features

## Troubleshooting

### Port Already in Use
If port 3001 (backend) or 3000 (frontend) is already in use:

**Backend:** Change port in `backend/src/index.ts`:
```typescript
const port = process.env.PORT || 3002;
```

**Frontend:** Change port in `frontend/vite.config.ts`:
```typescript
server: {
  port: 3001,
}
```

### CORS Errors
Ensure the backend is running on `http://localhost:3001` or update the API URL in `frontend/src/App.tsx`.

## License

MIT