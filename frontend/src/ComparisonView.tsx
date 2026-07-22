import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Loader2, PlusCircle, RefreshCw, Trash2, CheckCircle2, ChevronRight, ChevronDown, Check, X, FileSpreadsheet } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

interface ComparisonData {
  upload: any;
  summary: {
    added: number;
    updated: number;
    deleted: number;
  };
  data: {
    added: any[];
    updated: any[];
    deleted: any[];
  };
}

export default function ComparisonView({ uploadId }: { uploadId: number }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ComparisonData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'added' | 'updated' | 'deleted'>('added');
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fetchComparison = async () => {
      try {
        setLoading(true);
        const response = await axios.get(`${API_URL}/api/comparison/${uploadId}`);
        setData(response.data);
        
        // Auto-select tab with data
        if (response.data.summary.added > 0) setActiveTab('added');
        else if (response.data.summary.updated > 0) setActiveTab('updated');
        else if (response.data.summary.deleted > 0) setActiveTab('deleted');
        
      } catch (err: any) {
        setError(err.response?.data?.error || 'Failed to fetch comparison data');
      } finally {
        setLoading(false);
      }
    };
    
    if (uploadId) fetchComparison();
  }, [uploadId]);

  const toggleRow = (id: string) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(id)) newExpanded.delete(id);
    else newExpanded.add(id);
    setExpandedRows(newExpanded);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-gray-500">
        <Loader2 className="h-12 w-12 animate-spin text-blue-500 mb-4" />
        <p className="text-lg font-medium text-gray-700">Analyzing dataset changes...</p>
        <p className="text-sm text-gray-400 mt-2">Comparing against previous snapshots</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-8 bg-red-50 text-red-700 rounded-xl border border-red-100 flex items-center justify-center">
        <X className="w-6 h-6 mr-3" />
        <span className="font-semibold">{error || 'Unknown error occurred'}</span>
      </div>
    );
  }

  const currentDataList = data.data[activeTab] || [];

  return (
    <div className="max-w-7xl mx-auto space-y-8 animate-in fade-in duration-500">
      {/* Header Info */}
      <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-2xl shadow-xl overflow-hidden text-white relative">
        <div className="absolute top-0 right-0 p-8 opacity-10">
          <FileSpreadsheet className="w-48 h-48" />
        </div>
        <div className="relative z-10 p-8">
          <div className="flex items-center space-x-3 mb-2">
            <CheckCircle2 className="text-emerald-400 w-6 h-6" />
            <span className="text-emerald-400 font-semibold uppercase tracking-wider text-sm">Processing Complete</span>
          </div>
          <h2 className="text-3xl font-bold mb-2">Data Comparison Report</h2>
          <p className="text-gray-400 max-w-2xl text-lg">
            Uploaded file <span className="text-white font-medium">{data.upload.original_filename}</span> 
            has been compared against the active database state.
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div 
          onClick={() => setActiveTab('added')}
          className={`cursor-pointer group relative overflow-hidden bg-white p-6 rounded-2xl border-2 transition-all duration-300 shadow-sm hover:shadow-md ${activeTab === 'added' ? 'border-emerald-500 ring-4 ring-emerald-500/10 scale-105 z-10' : 'border-transparent hover:border-emerald-200'}`}
        >
          <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
            <PlusCircle className="w-24 h-24 text-emerald-600" />
          </div>
          <div className="flex items-center justify-between mb-4 relative z-10">
            <div className="w-12 h-12 bg-emerald-100 rounded-xl flex items-center justify-center text-emerald-600">
              <PlusCircle className="w-6 h-6" />
            </div>
            <span className="text-4xl font-black text-emerald-600 tracking-tight">{data.summary.added}</span>
          </div>
          <h3 className="text-lg font-bold text-gray-900 relative z-10">Added Records</h3>
          <p className="text-gray-500 text-sm mt-1 relative z-10">New properties discovered</p>
        </div>

        <div 
          onClick={() => setActiveTab('updated')}
          className={`cursor-pointer group relative overflow-hidden bg-white p-6 rounded-2xl border-2 transition-all duration-300 shadow-sm hover:shadow-md ${activeTab === 'updated' ? 'border-blue-500 ring-4 ring-blue-500/10 scale-105 z-10' : 'border-transparent hover:border-blue-200'}`}
        >
          <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
            <RefreshCw className="w-24 h-24 text-blue-600" />
          </div>
          <div className="flex items-center justify-between mb-4 relative z-10">
            <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center text-blue-600">
              <RefreshCw className="w-6 h-6" />
            </div>
            <span className="text-4xl font-black text-blue-600 tracking-tight">{data.summary.updated}</span>
          </div>
          <h3 className="text-lg font-bold text-gray-900 relative z-10">Updated Records</h3>
          <p className="text-gray-500 text-sm mt-1 relative z-10">Existing properties with modifications</p>
        </div>

        <div 
          onClick={() => setActiveTab('deleted')}
          className={`cursor-pointer group relative overflow-hidden bg-white p-6 rounded-2xl border-2 transition-all duration-300 shadow-sm hover:shadow-md ${activeTab === 'deleted' ? 'border-red-500 ring-4 ring-red-500/10 scale-105 z-10' : 'border-transparent hover:border-red-200'}`}
        >
          <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
            <Trash2 className="w-24 h-24 text-red-600" />
          </div>
          <div className="flex items-center justify-between mb-4 relative z-10">
            <div className="w-12 h-12 bg-red-100 rounded-xl flex items-center justify-center text-red-600">
              <Trash2 className="w-6 h-6" />
            </div>
            <span className="text-4xl font-black text-red-600 tracking-tight">{data.summary.deleted}</span>
          </div>
          <h3 className="text-lg font-bold text-gray-900 relative z-10">Deleted Records</h3>
          <p className="text-gray-500 text-sm mt-1 relative z-10">Properties no longer in dataset</p>
        </div>

        <div className="relative overflow-hidden bg-gray-50 p-6 rounded-2xl border-2 border-transparent transition-all duration-300">
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 bg-gray-200 rounded-xl flex items-center justify-center text-gray-500">
              <Check className="w-6 h-6" />
            </div>
            <span className="text-4xl font-black text-gray-400 tracking-tight">
              {(data.upload.row_count || 0) - data.summary.added - data.summary.updated}
            </span>
          </div>
          <h3 className="text-lg font-bold text-gray-500">Unchanged</h3>
          <p className="text-gray-400 text-sm mt-1">Properties skipped (identical hash)</p>
        </div>
      </div>

      {/* Data Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
          <h3 className="text-lg font-bold text-gray-800 capitalize flex items-center">
            {activeTab === 'added' && <PlusCircle className="w-5 h-5 text-emerald-500 mr-2" />}
            {activeTab === 'updated' && <RefreshCw className="w-5 h-5 text-blue-500 mr-2" />}
            {activeTab === 'deleted' && <Trash2 className="w-5 h-5 text-red-500 mr-2" />}
            {activeTab} Records ({currentDataList.length})
          </h3>
        </div>

        {currentDataList.length === 0 ? (
          <div className="py-16 text-center text-gray-500">
            <p>No {activeTab} records found in this upload.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-gray-50 text-gray-500 uppercase tracking-wider text-xs font-semibold">
                <tr>
                  <th className="px-6 py-4 rounded-tl-lg">Property Name</th>
                  <th className="px-6 py-4">Address</th>
                  <th className="px-6 py-4">City</th>
                  <th className="px-6 py-4">Sale Price</th>
                  <th className="px-6 py-4">Sale Date</th>
                  {activeTab === 'updated' && <th className="px-6 py-4 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {currentDataList.map((row, idx) => (
                  <React.Fragment key={row.businessKey || idx}>
                    <tr 
                      className={`hover:bg-gray-50/50 transition-colors ${activeTab === 'updated' ? 'cursor-pointer' : ''}`}
                      onClick={() => activeTab === 'updated' && toggleRow(row.businessKey)}
                    >
                      <td className="px-6 py-4 font-medium text-gray-900">
                        {row.propertyName || 'N/A'}
                      </td>
                      <td className="px-6 py-4 text-gray-600">{row.address || row.businessKey}</td>
                      <td className="px-6 py-4 text-gray-600">{row.city}</td>
                      <td className="px-6 py-4 font-medium text-gray-800">{row.salePrice}</td>
                      <td className="px-6 py-4 text-gray-500">{row.saleDate}</td>
                      {activeTab === 'updated' && (
                        <td className="px-6 py-4 text-right">
                          <button className="text-gray-400 hover:text-blue-600 transition-colors bg-gray-100 hover:bg-blue-50 p-2 rounded-lg">
                            {expandedRows.has(row.businessKey) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                        </td>
                      )}
                    </tr>
                    
                    {/* Expanded History for Updated Row */}
                    {activeTab === 'updated' && expandedRows.has(row.businessKey) && (
                      <tr className="bg-blue-50/30 border-y border-blue-100">
                        <td colSpan={6} className="px-8 py-6">
                          <div className="bg-white rounded-xl shadow-sm border border-blue-100 overflow-hidden">
                            <div className="bg-blue-50 px-4 py-3 border-b border-blue-100">
                              <h4 className="text-sm font-semibold text-blue-800 flex items-center">
                                <RefreshCw className="w-4 h-4 mr-2" />
                                Modified Fields
                              </h4>
                            </div>
                            <div className="p-4">
                              {row.changes && row.changes.length > 0 ? (
                                <div className="grid gap-3">
                                  {row.changes.map((change: any, cidx: number) => (
                                    <div key={cidx} className="flex items-center text-sm p-3 rounded-lg bg-gray-50">
                                      <span className="font-semibold text-gray-700 min-w-[200px]">{change.field}</span>
                                      <div className="flex-1 flex items-center bg-red-50 text-red-700 px-4 py-2 rounded border border-red-100 line-through decoration-red-300">
                                        {change.old_value || <span className="text-red-300 italic">Empty</span>}
                                      </div>
                                      <ChevronRight className="w-5 h-5 text-gray-400 mx-4" />
                                      <div className="flex-1 flex items-center bg-emerald-50 text-emerald-700 px-4 py-2 rounded border border-emerald-100 font-medium">
                                        {change.new_value || <span className="text-emerald-300 italic">Empty</span>}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="text-gray-500 italic text-sm p-2">Change details not available for this record.</p>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
