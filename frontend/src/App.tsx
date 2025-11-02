import { useState, useRef } from 'react';
import axios from 'axios';
import { Upload, FileSpreadsheet, Download, Loader2, CheckCircle, AlertCircle } from 'lucide-react';

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [availableDates, setAvailableDates] = useState<Array<{ date: string; count: number }>>([]);
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [step, setStep] = useState<'upload' | 'select' | 'convert'>('upload');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      // Validate file type
      const validTypes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'];
      if (!validTypes.includes(selectedFile.type) && !selectedFile.name.endsWith('.xlsx') && !selectedFile.name.endsWith('.xls')) {
        setError('Please upload a valid Excel file (.xlsx or .xls)');
        return;
      }
      setFile(selectedFile);
      setError(null);
      setSuccess(false);
      
      // Automatically fetch available dates
      await fetchDates(selectedFile);
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      const validTypes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'];
      if (!validTypes.includes(droppedFile.type) && !droppedFile.name.endsWith('.xlsx') && !droppedFile.name.endsWith('.xls')) {
        setError('Please upload a valid Excel file (.xlsx or .xls)');
        return;
      }
      setFile(droppedFile);
      setError(null);
      setSuccess(false);
      
      // Automatically fetch available dates
      await fetchDates(droppedFile);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const fetchDates = async (uploadFile: File) => {
    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.append('file', uploadFile);

    try {
      const response = await axios.post('http://localhost:3001/api/dates', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      setAvailableDates(response.data.dates);
      setStep('select');
    } catch (err: any) {
      console.error('Error fetching dates:', err);
      setError(err.response?.data?.error || 'Failed to extract dates from file. Make sure there is an "Insider Date" column.');
    } finally {
      setLoading(false);
    }
  };

  const handleDateToggle = (date: string) => {
    setSelectedDates(prev => 
      prev.includes(date) 
        ? prev.filter(d => d !== date)
        : [...prev, date]
    );
  };

  const handleSelectAll = () => {
    if (selectedDates.length === availableDates.length) {
      setSelectedDates([]);
    } else {
      setSelectedDates(availableDates.map(d => d.date));
    }
  };

  const handleConvert = async () => {
    if (!file) return;

    setLoading(true);
    setError(null);
    setSuccess(false);

    const formData = new FormData();
    formData.append('file', file);
    
    // Add selected date if any (only the first one for MVP)
    if (selectedDates.length > 0) {
      formData.append('insiderDate', selectedDates[0]);
    }

    try {
      const response = await axios.post('http://localhost:3001/api/convert', formData, {
        responseType: 'blob',
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      // Create a download link for the PDF
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${file.name.replace(/\.[^/.]+$/, '')}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      setSuccess(true);
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (err) {
      console.error('Error converting file:', err);
      setError('Failed to convert file. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="max-w-2xl w-full bg-white rounded-2xl shadow-xl p-8">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-800 mb-2">Excel to PDF Converter</h1>
          <p className="text-gray-600">
            {step === 'upload' && 'Upload your Excel file and select reports by Insider Date'}
            {step === 'select' && 'Select the Insider Dates you want to include'}
          </p>
        </div>

        {/* Upload Area */}
        {step === 'upload' && (
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className={`border-2 border-dashed rounded-xl p-12 text-center transition-all ${
            file 
              ? 'border-green-400 bg-green-50' 
              : 'border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileChange}
            className="hidden"
            id="file-upload"
          />
          
          {!file ? (
            <label htmlFor="file-upload" className="cursor-pointer">
              <Upload className="w-16 h-16 mx-auto text-gray-400 mb-4" />
              <p className="text-lg font-medium text-gray-700 mb-2">
                Drop your Excel file here or click to browse
              </p>
              <p className="text-sm text-gray-500">Supports .xlsx and .xls files</p>
            </label>
          ) : (
            <div className="flex items-center justify-center gap-3">
              <FileSpreadsheet className="w-12 h-12 text-green-600" />
              <div className="text-left">
                <p className="font-medium text-gray-800">{file.name}</p>
                <p className="text-sm text-gray-500">
                  {(file.size / 1024).toFixed(2)} KB
                </p>
              </div>
              {loading && (
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              )}
            </div>
          )}
        </div>
        )}

        {/* Date Selection */}
        {step === 'select' && availableDates.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-800">
                Available Insider Dates ({availableDates.length})
              </h2>
              <button
                onClick={handleSelectAll}
                className="text-sm text-blue-600 hover:text-blue-700 font-medium"
              >
                {selectedDates.length === availableDates.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>
            
            <div className="max-h-96 overflow-y-auto space-y-2 border border-gray-200 rounded-lg p-4">
              {availableDates.map(({ date, count }) => (
                <label
                  key={date}
                  className="flex items-center gap-3 p-3 hover:bg-gray-50 rounded-lg cursor-pointer transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selectedDates.includes(date)}
                    onChange={() => handleDateToggle(date)}
                    className="w-5 h-5 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="flex-1 flex items-center justify-between">
                    <span className="text-gray-800 font-medium">{date}</span>
                    <span className="text-sm text-gray-500 bg-gray-100 px-2 py-1 rounded">
                      {count} report{count !== 1 ? 's' : ''}
                    </span>
                  </div>
                </label>
              ))}
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setStep('upload');
                  setSelectedDates([]);
                  setAvailableDates([]);
                  setFile(null);
                  if (fileInputRef.current) {
                    fileInputRef.current.value = '';
                  }
                }}
                className="flex-1 py-3 rounded-xl font-semibold text-gray-700 bg-gray-200 hover:bg-gray-300 transition-colors"
              >
                Upload Different File
              </button>
              <button
                onClick={() => setStep('convert')}
                disabled={selectedDates.length === 0}
                className={`flex-2 py-3 px-6 rounded-xl font-semibold text-white transition-colors ${
                  selectedDates.length === 0
                    ? 'bg-gray-300 cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                Continue with {selectedDates.length} date{selectedDates.length !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        )}

        {/* Convert Confirmation */}
        {step === 'convert' && (
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
              <p className="text-sm text-blue-800">
                <strong>Selected Date:</strong> {selectedDates[0]}
              </p>
              <p className="text-xs text-blue-600 mt-1">
                PDF will include: Property Profile, Property Details, Financial Highlights, and Comments
              </p>
              <p className="text-xs text-blue-600 mt-1">
                Table of Contents + Individual reports for each property
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep('select')}
                className="flex-1 py-3 rounded-xl font-semibold text-gray-700 bg-gray-200 hover:bg-gray-300 transition-colors"
              >
                Back to Selection
              </button>
              <button
                onClick={handleConvert}
                disabled={loading}
                className={`flex-2 py-3 px-6 rounded-xl font-semibold text-white transition-all flex items-center justify-center gap-2 ${
                  loading
                    ? 'bg-gray-300 cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-700 shadow-lg hover:shadow-xl'
                }`}
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Converting...
                  </>
                ) : (
                  <>
                    <Download className="w-5 h-5" />
                    Generate PDF
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
            <p className="text-red-700">{error}</p>
          </div>
        )}

        {/* Success Message */}
        {success && (
          <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
            <p className="text-green-700">PDF generated and downloaded successfully!</p>
          </div>
        )}

      </div>
    </div>
  );
}

export default App;
