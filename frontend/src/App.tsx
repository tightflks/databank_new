import { useState, useRef, useEffect } from 'react';
import axios from 'axios';

import { Upload, FileSpreadsheet, Download, Loader2, CheckCircle, AlertCircle, FileText, Search, Eye, Database, Calendar, FileArchive, Users } from 'lucide-react';
import SearchComps from './SearchComps';
import UserDashboard from './UserDashboard';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

interface SavedUpload {
  id: number;
  filename: string;
  original_filename: string;
  upload_date: string;
  file_size: number;
  sheet_count: number;
  row_count: number;
}

interface SavedReport {
  id: number;
  upload_id: number;
  report_name: string;
  selected_dates: string[];
  created_date: string;
  property_count: number;
  original_filename: string;
  source_upload_date: string;
}

function App() {
  const [activeTab, setActiveTab] = useState<'generate' | 'search' | 'history' | 'user'>('generate');
  const [uploads, setUploads] = useState<SavedUpload[]>([]);
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [loadingUploads, setLoadingUploads] = useState(false);
  const [loadingReports, setLoadingReports] = useState(false);
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
      const response = await axios.post(`${API_URL}/api/dates`, formData, {
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
    
    // Add selected date if any
    if (selectedDates.length > 0) {
      formData.append('filterDate', selectedDates[0]);
    }

    try {
      const response = await axios.post(`${API_URL}/api/convert-html`, formData, {
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
      link.download = 'databank-property-reports.pdf';
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

  const fetchUploads = async () => {
    setLoadingUploads(true);
    try {
      const response = await axios.get(`${API_URL}/api/uploads`);
      setUploads(response.data.uploads);
    } catch (err) {
      console.error('Error fetching uploads:', err);
    } finally {
      setLoadingUploads(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'history') {
      fetchUploads();
      fetchReports();
    }
  }, [activeTab]);

  const fetchReports = async () => {
    setLoadingReports(true);
    try {
      const response = await axios.get(`${API_URL}/api/reports`);
      setReports(response.data.reports);
    } catch (err) {
      console.error('Error fetching reports:', err);
    } finally {
      setLoadingReports(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const handlePreview = async () => {
    if (!file) return;

    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.append('file', file);
    
    // Add selected date if any
    if (selectedDates.length > 0) {
      formData.append('filterDate', selectedDates[0]);
    }

    try {
      const response = await axios.post(`${API_URL}/api/preview-html`, formData, {
        responseType: 'text',
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      // Open HTML in new tab
      const newWindow = window.open();
      if (newWindow) {
        newWindow.document.write(response.data);
        newWindow.document.close();
      } else {
        setError('Please allow pop-ups to preview reports online');
      }
    } catch (err) {
      console.error('Error generating preview:', err);
      setError('Failed to generate preview. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            {activeTab === 'user' ? 'User Dashboard' : 'Databank Generator (Admin)'}
          </h1>
          <p className="text-lg text-gray-600">
            {activeTab === 'user' 
              ? 'Browse and access property reports' 
              : 'Transform your Excel data into professional PDF reports'}
          </p>
        </div>

        {/* Navigation Tabs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <button
            onClick={() => setActiveTab('user')}
            className={`py-4 px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeTab === 'user'
                ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg'
                : 'bg-white/50 text-gray-600 hover:bg-white/80'
            }`}
          >
            <Users className="w-5 h-5" />
            User View
          </button>
          <button
            onClick={() => setActiveTab('generate')}
            className={`py-4 px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeTab === 'generate'
                ? 'bg-white text-blue-600 shadow-lg'
                : 'bg-white/50 text-gray-600 hover:bg-white/80'
            }`}
          >
            <Upload className="w-5 h-5" />
            Generate
          </button>
          <button
            onClick={() => setActiveTab('search')}
            className={`py-4 px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeTab === 'search'
                ? 'bg-white text-blue-600 shadow-lg'
                : 'bg-white/50 text-gray-600 hover:bg-white/80'
            }`}
          >
            <Search className="w-5 h-5" />
            Search
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`py-4 px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeTab === 'history'
                ? 'bg-white text-blue-600 shadow-lg'
                : 'bg-white/50 text-gray-600 hover:bg-white/80'
            }`}
          >
            <Database className="w-5 h-5" />
            History
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === 'generate' ? (
          <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-xl p-8">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-gray-800 mb-2">Generate PDF Reports</h2>
              <p className="text-gray-600">
                {step === 'upload' && 'Upload your Excel file and select reports by Insider Date'}
                {step === 'select' && 'Select the Insider Dates you want to include'}
                {step === 'convert' && 'Ready to generate your reports'}
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
        {step === 'select' && (
          availableDates.length > 0 ? (
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
          ) : (
            <div className="text-center py-8">
              <AlertCircle className="w-16 h-16 mx-auto text-yellow-500 mb-4" />
              <h3 className="text-lg font-semibold text-gray-800 mb-2">No Insider Dates Found</h3>
              <p className="text-gray-600 mb-4">The uploaded file doesn't contain any "Insider Date" column or the dates couldn't be extracted.</p>
              <button
                onClick={() => {
                  setStep('upload');
                  setFile(null);
                  if (fileInputRef.current) {
                    fileInputRef.current.value = '';
                  }
                }}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Upload Different File
              </button>
            </div>
          )
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
                onClick={handlePreview}
                disabled={loading}
                className={`flex-1 py-3 px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
                  loading
                    ? 'bg-gray-300 cursor-not-allowed'
                    : 'bg-green-600 hover:bg-green-700 text-white shadow-lg hover:shadow-xl'
                }`}
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Loading...
                  </>
                ) : (
                  <>
                    <Eye className="w-5 h-5" />
                    Preview Online
                  </>
                )}
              </button>
              <button
                onClick={handleConvert}
                disabled={loading}
                className={`flex-1 py-3 px-6 rounded-xl font-semibold text-white transition-all flex items-center justify-center gap-2 ${
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
        ) : activeTab === 'search' ? (
          <SearchComps />
        ) : activeTab === 'user' ? (
          <UserDashboard />
        ) : (
          <div className="space-y-6">
            {/* Saved Reports Section */}
            <div className="bg-white rounded-2xl shadow-xl p-8">
              <div className="text-center mb-8">
                <h2 className="text-2xl font-bold text-gray-800 mb-2">Saved Reports</h2>
                <p className="text-gray-600">Previously generated PDF configurations you can regenerate</p>
              </div>

              {loadingReports ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                </div>
              ) : reports.length === 0 ? (
                <div className="text-center py-12">
                  <FileText className="w-16 h-16 mx-auto text-gray-400 mb-4" />
                  <h3 className="text-lg font-semibold text-gray-800 mb-2">No Saved Reports Yet</h3>
                  <p className="text-gray-600">Generate a PDF to save report configurations</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {reports.map((report) => (
                    <div
                      key={report.id}
                      className="border border-gray-200 rounded-lg p-6 hover:shadow-md transition-shadow"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-4 flex-1">
                          <FileText className="w-10 h-10 text-blue-600 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <h3 className="text-lg font-semibold text-gray-800">
                              {report.report_name}
                            </h3>
                            <p className="text-sm text-gray-600 mt-1">
                              Source: {report.original_filename}
                            </p>
                            <div className="grid grid-cols-2 gap-x-6 gap-y-2 mt-3 text-sm text-gray-600">
                              <div className="flex items-center gap-2">
                                <Calendar className="w-4 h-4" />
                                <span>{formatDate(report.created_date)}</span>
                              </div>
                              <div>
                                <span className="font-medium">Properties:</span> {report.property_count.toLocaleString()}
                              </div>
                              {report.selected_dates.length > 0 && (
                                <div className="col-span-2">
                                  <span className="font-medium">Dates:</span> {report.selected_dates.join(', ')}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col gap-2 ml-4">
                          <button
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium flex items-center gap-2 justify-center"
                            onClick={() => window.open(`${API_URL}/api/reports/${report.id}/view`, '_blank')}
                          >
                            <Eye className="w-4 h-4" />
                            View Online
                          </button>
                          <button
                            className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium flex items-center gap-2 justify-center"
                            onClick={() => {
                              // Create a form and submit to generate PDF
                              const form = document.createElement('form');
                              form.method = 'POST';
                              form.action = `${API_URL}/api/reports/` + report.id + '/regenerate-pdf';
                              form.target = '_blank';
                              document.body.appendChild(form);
                              form.submit();
                              document.body.removeChild(form);
                            }}
                          >
                            <Download className="w-4 h-4" />
                            Download PDF
                          </button>
                          <button
                            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors text-sm font-medium"
                            onClick={() => {
                              const link = `${API_URL}/api/reports/${report.id}/view`;
                              navigator.clipboard.writeText(link);
                              alert('Link copied to clipboard!');
                            }}
                          >
                            Copy Link
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Upload History Section */}
            <div className="bg-white rounded-2xl shadow-xl p-8">
              <div className="text-center mb-8">
                <h2 className="text-2xl font-bold text-gray-800 mb-2">Upload History</h2>
                <p className="text-gray-600">All Excel files saved in the database</p>
              </div>

              {loadingUploads ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                </div>
              ) : uploads.length === 0 ? (
                <div className="text-center py-12">
                  <FileArchive className="w-16 h-16 mx-auto text-gray-400 mb-4" />
                  <h3 className="text-lg font-semibold text-gray-800 mb-2">No Uploads Yet</h3>
                  <p className="text-gray-600">Upload an Excel file to see it saved here</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {uploads.map((upload) => (
                    <div
                      key={upload.id}
                      className="border border-gray-200 rounded-lg p-6 hover:shadow-md transition-shadow"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-4 flex-1">
                          <FileSpreadsheet className="w-10 h-10 text-green-600 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <h3 className="text-lg font-semibold text-gray-800 truncate">
                              {upload.original_filename}
                            </h3>
                            <div className="grid grid-cols-2 gap-x-6 gap-y-2 mt-2 text-sm text-gray-600">
                              <div className="flex items-center gap-2">
                                <Calendar className="w-4 h-4" />
                                <span>{formatDate(upload.upload_date)}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <FileArchive className="w-4 h-4" />
                                <span>{formatFileSize(upload.file_size)}</span>
                              </div>
                              <div>
                                <span className="font-medium">Rows:</span> {upload.row_count.toLocaleString()}
                              </div>
                              <div>
                                <span className="font-medium">Sheets:</span> {upload.sheet_count}
                              </div>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 ml-4">
                          <span className="bg-green-100 text-green-700 px-3 py-1 rounded-full text-sm font-medium">
                            Saved
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
