import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Loader2, FileSpreadsheet, Calendar, FileArchive, Layers, FileText, AlertCircle, RefreshCw, Upload, CheckCircle } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

interface LatestUpload {
  id: number;
  original_filename: string;
  upload_date: string;
  file_size: number;
  sheet_count: number;
  row_count: number;
}

interface DatabaseInfo {
  database_type: string;
  latest_upload: LatestUpload | null;
  upload_count: number;
  report_count: number;
}

const DATABASE_META: Record<string, { label: string; icon: string; color: string }> = {
  apartments: { label: 'Apartments', icon: '🏢', color: 'border-blue-500' },
  franchise: { label: 'Franchise', icon: '🏪', color: 'border-orange-500' },
  industrial: { label: 'Industrial', icon: '🏭', color: 'border-gray-500' },
  land: { label: 'Land', icon: '🌳', color: 'border-green-500' },
  offices: { label: 'Offices', icon: '🏛️', color: 'border-purple-500' },
  retail: { label: 'Retail', icon: '🛍️', color: 'border-pink-500' },
};

function DatabaseStatus() {
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadingType, setUploadingType] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const handleFileSelected = async (databaseType: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');
    if (!isExcel) {
      setError('Please upload a valid Excel file (.xlsx or .xls)');
      e.target.value = '';
      return;
    }

    setUploadingType(databaseType);
    setError(null);
    setUploadSuccess(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      await axios.post(`${API_URL}/api/databases/${databaseType}/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setUploadSuccess(databaseType);
      await fetchDatabases();
    } catch (err: any) {
      console.error('Error uploading file:', err);
      setError(err.response?.data?.error || 'Failed to upload file. Please try again.');
    } finally {
      setUploadingType(null);
      e.target.value = '';
    }
  };

  const fetchDatabases = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`${API_URL}/api/databases`);
      setDatabases(response.data.databases);
    } catch (err) {
      console.error('Error fetching database status:', err);
      setError('Failed to load database status. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDatabases();
  }, []);

  const formatFileSize = (bytes: number) => {
    if (!bytes) return '—';
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
      hour12: true,
    });
  };

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-bold text-gray-800 mb-1">Database Status</h2>
          <p className="text-gray-600">Current file/version attached to each database</p>
        </div>
        <button
          onClick={fetchDatabases}
          className="px-4 py-2 bg-white text-gray-700 rounded-lg hover:bg-gray-50 border border-gray-200 transition-colors flex items-center gap-2 text-sm font-medium shadow-sm"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
          <p className="text-red-700">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-10 h-10 animate-spin text-blue-600" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {databases.map((dbInfo) => {
            const meta = DATABASE_META[dbInfo.database_type] || {
              label: dbInfo.database_type,
              icon: '📁',
              color: 'border-gray-300',
            };
            const upload = dbInfo.latest_upload;

            return (
              <div
                key={dbInfo.database_type}
                className={`bg-white rounded-2xl shadow-lg p-6 border-t-4 ${meta.color} hover:shadow-xl transition-shadow`}
              >
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">{meta.icon}</span>
                    <h3 className="text-xl font-bold text-gray-900">{meta.label}</h3>
                  </div>
                  {upload ? (
                    <span className="bg-green-100 text-green-700 px-3 py-1 rounded-full text-xs font-semibold">
                      Active
                    </span>
                  ) : (
                    <span className="bg-gray-100 text-gray-500 px-3 py-1 rounded-full text-xs font-semibold">
                      No File
                    </span>
                  )}
                </div>

                <input
                  ref={(el) => { fileInputRefs.current[dbInfo.database_type] = el; }}
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={(e) => handleFileSelected(dbInfo.database_type, e)}
                  className="hidden"
                />

                {upload ? (
                  <div className="space-y-3">
                    <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                      <FileSpreadsheet className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800 truncate" title={upload.original_filename}>
                          {upload.original_filename}
                        </p>
                        <p className="text-xs text-gray-500">Current attached file</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-gray-600">
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-gray-400" />
                        <span>{formatDate(upload.upload_date)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <FileArchive className="w-4 h-4 text-gray-400" />
                        <span>{formatFileSize(upload.file_size)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Layers className="w-4 h-4 text-gray-400" />
                        <span>{(upload.row_count ?? 0).toLocaleString()} rows</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-gray-400" />
                        <span>{dbInfo.report_count} report{dbInfo.report_count !== 1 ? 's' : ''}</span>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
                      <span>Version #{dbInfo.upload_count}</span>
                      <span>{dbInfo.upload_count} upload{dbInfo.upload_count !== 1 ? 's' : ''} total</span>
                    </div>

                    <button
                      onClick={() => fileInputRefs.current[dbInfo.database_type]?.click()}
                      disabled={uploadingType !== null}
                      className={`w-full py-2.5 rounded-lg font-semibold text-sm transition-all flex items-center justify-center gap-2 ${
                        uploadingType === dbInfo.database_type
                          ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                          : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                      }`}
                    >
                      {uploadingType === dbInfo.database_type ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Uploading...
                        </>
                      ) : (
                        <>
                          <Upload className="w-4 h-4" />
                          Upload New Version
                        </>
                      )}
                    </button>

                    {uploadSuccess === dbInfo.database_type && (
                      <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">
                        <CheckCircle className="w-4 h-4 flex-shrink-0" />
                        New version attached successfully
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-6">
                    <FileSpreadsheet className="w-10 h-10 mx-auto text-gray-300 mb-2" />
                    <p className="text-sm text-gray-500 mb-4">No file attached yet</p>
                    <button
                      onClick={() => fileInputRefs.current[dbInfo.database_type]?.click()}
                      disabled={uploadingType !== null}
                      className={`px-5 py-2.5 rounded-lg font-semibold text-sm transition-all flex items-center gap-2 mx-auto ${
                        uploadingType === dbInfo.database_type
                          ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                          : 'bg-blue-600 text-white hover:bg-blue-700 shadow-md'
                      }`}
                    >
                      {uploadingType === dbInfo.database_type ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Uploading...
                        </>
                      ) : (
                        <>
                          <Upload className="w-4 h-4" />
                          Attach File
                        </>
                      )}
                    </button>
                    {uploadSuccess === dbInfo.database_type && (
                      <div className="mt-3 flex items-center justify-center gap-2 text-sm text-green-700">
                        <CheckCircle className="w-4 h-4" />
                        File attached successfully
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default DatabaseStatus;
