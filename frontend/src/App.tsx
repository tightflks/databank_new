import { useState, useEffect } from 'react';
import axios from 'axios';

import { FileSpreadsheet, Download, Loader2, CheckCircle, AlertCircle, FileText, Eye, Database, Calendar, FileArchive, Users, LogOut } from 'lucide-react';
import UserDashboard from './UserDashboard';
import DatabaseStatus from './DatabaseStatus';
import AdminLogin from './AdminLogin';

axios.defaults.withCredentials = true;

const DATABASE_OPTIONS = [
  { value: 'apartments', label: '🏢 Apartments' },
  { value: 'franchise', label: '🏪 Franchise' },
  { value: 'industrial', label: '🏭 Industrial' },
  { value: 'land', label: '🌳 Land' },
  { value: 'offices', label: '🏛️ Offices' },
  { value: 'retail', label: '🛍️ Retail' },
];

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

interface SavedUpload {
  id: number;
  filename: string;
  original_filename: string;
  upload_date: string;
  file_size: number;
  sheet_count: number;
  row_count: number;
  database_type: string;
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
  database_type?: string;
  is_latest?: number;
}

const databaseLabel = (value?: string) => {
  const option = DATABASE_OPTIONS.find(o => o.value === value);
  return option ? option.label : value || '';
};

// Customers land on / (User View only); administrators use /admin.
const ADMIN_ROUTE = window.location.pathname.replace(/\/+$/, '') === '/admin';

function App() {
  const [activeTab, setActiveTab] = useState<'generate' | 'history' | 'user' | 'databases'>(ADMIN_ROUTE ? 'generate' : 'user');
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    axios.get(`${API_URL}/api/auth/me`)
      .then(r => setIsAdmin(Boolean(r.data?.admin)))
      .catch(() => setIsAdmin(false));
  }, []);

  const logout = async () => {
    await axios.post(`${API_URL}/api/auth/logout`).catch(() => undefined);
    setIsAdmin(false);
    setActiveTab('generate');
  };
  const [selectedDatabase, setSelectedDatabase] = useState('apartments');
  const [uploads, setUploads] = useState<SavedUpload[]>([]);
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [loadingUploads, setLoadingUploads] = useState(false);
  const [loadingReports, setLoadingReports] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [availableDates, setAvailableDates] = useState<Array<{ date: string; count: number }>>([]);
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [step, setStep] = useState<'select' | 'convert'>('select');
  const [attachedUpload, setAttachedUpload] = useState<SavedUpload | null>(null);
  const [loadingAttached, setLoadingAttached] = useState(false);
  const [historyFilter, setHistoryFilter] = useState('');

  // Load the attached file + its insider dates for the selected database
  useEffect(() => {
    if (activeTab !== 'generate') return;

    const loadAttachedUpload = async () => {
      setLoadingAttached(true);
      setError(null);
      setAttachedUpload(null);
      setAvailableDates([]);
      setSelectedDates([]);
      setStep('select');
      setSuccess(false);

      try {
        const uploadsResponse = await axios.get(`${API_URL}/api/uploads?database_type=${selectedDatabase}&limit=1`);
        const latest = uploadsResponse.data.uploads?.[0];
        if (!latest) {
          return;
        }
        setAttachedUpload(latest);

        const datesResponse = await axios.get(`${API_URL}/api/uploads/${latest.id}/dates`);
        setAvailableDates(datesResponse.data.dates);
      } catch (err: any) {
        console.error('Error loading attached upload:', err);
        setError(err.response?.data?.error || 'Failed to load the attached file for this database.');
      } finally {
        setLoadingAttached(false);
      }
    };

    loadAttachedUpload();
  }, [activeTab, selectedDatabase]);

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
    if (!attachedUpload) return;

    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const response = await axios.post(
        `${API_URL}/api/uploads/${attachedUpload.id}/generate-pdf`,
        { filterDate: selectedDates.length > 0 ? selectedDates[0] : undefined },
        { responseType: 'blob' }
      );

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
    } catch (err) {
      console.error('Error generating PDF:', err);
      setError('Failed to generate PDF. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const fetchUploads = async (databaseType?: string) => {
    setLoadingUploads(true);
    try {
      const query = databaseType ? `?database_type=${databaseType}` : '';
      const response = await axios.get(`${API_URL}/api/uploads${query}`);
      setUploads(response.data.uploads);
    } catch (err) {
      console.error('Error fetching uploads:', err);
    } finally {
      setLoadingUploads(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'history') {
      fetchUploads(historyFilter || undefined);
      fetchReports(historyFilter || undefined);
    }
  }, [activeTab, historyFilter]);

  const fetchReports = async (databaseType?: string) => {
    setLoadingReports(true);
    try {
      const query = databaseType ? `?database_type=${databaseType}` : '';
      const response = await axios.get(`${API_URL}/api/reports${query}`);
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

  const handleDeleteReport = async (reportId: number) => {
    if (!window.confirm('Delete this report? Users will no longer see it in Available Reports.')) return;
    try {
      await axios.delete(`${API_URL}/api/reports/${reportId}`);
      setReports(prev => prev.filter(r => r.id !== reportId));
    } catch (err) {
      console.error('Error deleting report:', err);
      alert('Failed to delete report. Please try again.');
    }
  };

  const handlePreview = () => {
    if (!attachedUpload) return;
    const filterParam = selectedDates.length > 0 ? `?filterDate=${encodeURIComponent(selectedDates[0])}` : '';
    const newWindow = window.open(`${API_URL}/api/uploads/${attachedUpload.id}/preview${filterParam}`, '_blank');
    if (!newWindow) {
      setError('Please allow pop-ups to preview reports online');
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

        {/* Navigation Tabs (admin only) */}
        {ADMIN_ROUTE && <div className="grid grid-cols-3 gap-4 mb-6">
          <button
            onClick={() => setActiveTab('generate')}
            className={`py-4 px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeTab === 'generate'
                ? 'bg-white text-blue-600 shadow-lg'
                : 'bg-white/50 text-gray-600 hover:bg-white/80'
            }`}
          >
            <FileText className="w-5 h-5" />
            Generate
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
          <button
            onClick={() => setActiveTab('databases')}
            className={`py-4 px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeTab === 'databases'
                ? 'bg-white text-blue-600 shadow-lg'
                : 'bg-white/50 text-gray-600 hover:bg-white/80'
            }`}
          >
            <FileArchive className="w-5 h-5" />
            Databases
          </button>
        </div>}

        {ADMIN_ROUTE && isAdmin && (
          <div className="flex justify-end mb-4 gap-4 text-sm">
            <a href="/" className="text-gray-600 hover:text-gray-900 flex items-center gap-1">
              <Users className="w-4 h-4" /> Open User View
            </a>
            <button onClick={logout} className="text-gray-600 hover:text-gray-900 flex items-center gap-1">
              <LogOut className="w-4 h-4" /> Sign out
            </button>
          </div>
        )}

        {/* Tab Content */}
        {!ADMIN_ROUTE ? (
          <UserDashboard />
        ) : !isAdmin ? (
          isAdmin === null ? null : <AdminLogin onLogin={() => setIsAdmin(true)} />
        ) : activeTab === 'generate' ? (
          <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-xl p-8">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-gray-800 mb-2">Generate PDF Reports</h2>
              <p className="text-gray-600">
                {step === 'select' && 'Pick a database and select the Insider Dates you want to include'}
                {step === 'convert' && 'Ready to generate your reports'}
              </p>
            </div>

        {/* Database Selector */}
        {step === 'select' && (
          <div className="mb-6">
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Database
            </label>
            <div className="grid grid-cols-3 gap-2">
              {DATABASE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setSelectedDatabase(option.value)}
                  className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                    selectedDatabase === option.value
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Attached File Info */}
        {attachedUpload && (
          <div className="mb-6 flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-xl">
            <FileSpreadsheet className="w-8 h-8 text-green-600 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-gray-800 truncate">{attachedUpload.original_filename}</p>
              <p className="text-sm text-gray-500">
                Attached file · {attachedUpload.row_count.toLocaleString()} rows · uploaded {formatDate(attachedUpload.upload_date)}
              </p>
            </div>
          </div>
        )}

        {/* Loading attached file */}
        {loadingAttached && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        )}

        {/* No file attached */}
        {!loadingAttached && !attachedUpload && (
          <div className="text-center py-8">
            <AlertCircle className="w-16 h-16 mx-auto text-yellow-500 mb-4" />
            <h3 className="text-lg font-semibold text-gray-800 mb-2">No File Attached</h3>
            <p className="text-gray-600 mb-4">This database has no file attached yet. Attach one from the Databases tab.</p>
            <button
              onClick={() => setActiveTab('databases')}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Go to Databases
            </button>
          </div>
        )}

        {/* Date Selection */}
        {!loadingAttached && attachedUpload && step === 'select' && (
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
                onClick={() => setStep('convert')}
                disabled={selectedDates.length === 0}
                className={`flex-1 py-3 px-6 rounded-xl font-semibold text-white transition-colors ${
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
              <p className="text-gray-600 mb-4">The attached file doesn't contain any "Insider Date" column or the dates couldn't be extracted.</p>
              <button
                onClick={() => setActiveTab('databases')}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Upload a Different File
              </button>
            </div>
          )
        )}

        {/* Convert Confirmation */}
        {attachedUpload && step === 'convert' && (
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
        ) : activeTab === 'user' ? (
          <UserDashboard />
        ) : activeTab === 'databases' ? (
          <DatabaseStatus />
        ) : (
          <div className="space-y-6">
            {/* Database Filter */}
            <div className="flex justify-center">
              <div className="inline-flex flex-wrap justify-center rounded-xl bg-white shadow-md p-1 gap-1">
                <button
                  onClick={() => setHistoryFilter('')}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                    historyFilter === ''
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  All Databases
                </button>
                {DATABASE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => setHistoryFilter(option.value)}
                    className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                      historyFilter === option.value
                        ? 'bg-blue-600 text-white shadow-md'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

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
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="text-lg font-semibold text-gray-800">
                                {report.report_name}
                              </h3>
                              {report.database_type && (
                                <span className="bg-indigo-100 text-indigo-700 px-2.5 py-0.5 rounded-full text-xs font-semibold">
                                  {databaseLabel(report.database_type)}
                                </span>
                              )}
                              {report.is_latest === 0 && (
                                <span className="bg-amber-100 text-amber-700 px-2.5 py-0.5 rounded-full text-xs font-semibold">
                                  Previous version
                                </span>
                              )}
                            </div>
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
                          <button
                            className="px-4 py-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors text-sm font-medium"
                            onClick={() => handleDeleteReport(report.id)}
                          >
                            Delete
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
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="text-lg font-semibold text-gray-800 truncate">
                                {upload.original_filename}
                              </h3>
                              {upload.database_type && (
                                <span className="bg-indigo-100 text-indigo-700 px-2.5 py-0.5 rounded-full text-xs font-semibold">
                                  {databaseLabel(upload.database_type)}
                                </span>
                              )}
                            </div>
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
