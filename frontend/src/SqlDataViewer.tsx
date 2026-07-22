import { useState, useEffect } from 'react';
import axios from 'axios';
import { Database, Loader2, AlertCircle, Search } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

interface SqlTable {
  id: number;
  filename: string;
  original_filename: string;
  upload_date: string;
  file_size: number;
  sheet_count: number;
  row_count: number;
}

export default function SqlDataViewer() {
  const [tables, setTables] = useState<SqlTable[]>([]);
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [tableData, setTableData] = useState<any[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  
  const [loadingList, setLoadingList] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pagination & Search
  const [searchText, setSearchText] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const rowsPerPage = 50;

  useEffect(() => {
    fetchTables();
  }, []);

  const fetchTables = async () => {
    setLoadingList(true);
    try {
      const response = await axios.get(`${API_URL}/api/uploads`);
      // Filter only SQL dumps imported via extract_data.py
      const sqlTables = response.data.uploads.filter((u: SqlTable) => u.filename.endsWith('.sql'));
      setTables(sqlTables);
    } catch (err) {
      console.error('Error fetching tables:', err);
      setError('Failed to fetch SQL tables list.');
    } finally {
      setLoadingList(false);
    }
  };

  const loadTableData = async (id: number) => {
    setSelectedTableId(id);
    setLoadingData(true);
    setError(null);
    setSearchText('');
    setCurrentPage(1);
    
    try {
      const response = await axios.get(`${API_URL}/api/uploads/${id}/data`);
      const data = response.data.data;
      
      if (data && data.length > 0) {
        setHeaders(data[0]);
        setTableData(data.slice(1));
      } else {
        setHeaders([]);
        setTableData([]);
      }
    } catch (err) {
      console.error('Error loading table data:', err);
      setError('Failed to load data for the selected table.');
    } finally {
      setLoadingData(false);
    }
  };

  const getFilteredData = () => {
    if (!searchText) return tableData;
    const lowerSearch = searchText.toLowerCase();
    return tableData.filter(row => 
      row.some((cell: any) => String(cell || '').toLowerCase().includes(lowerSearch))
    );
  };

  const filteredData = getFilteredData();
  const totalPages = Math.ceil(filteredData.length / rowsPerPage);
  const currentData = filteredData.slice((currentPage - 1) * rowsPerPage, currentPage * rowsPerPage);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl shadow-xl p-8">
        <div className="flex items-center gap-3 mb-6">
          <Database className="w-8 h-8 text-blue-600" />
          <div>
            <h2 className="text-2xl font-bold text-gray-800">Live Database</h2>
            <p className="text-gray-600">View and search data directly from the SQL database</p>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
            <p className="text-red-700">{error}</p>
          </div>
        )}

        {loadingList ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : tables.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500">No SQL tables found in the database.</p>
          </div>
        ) : (
          <div className="grid md:grid-cols-4 gap-6">
            {/* Sidebar for Tables */}
            <div className="md:col-span-1 space-y-2">
              <h3 className="font-semibold text-gray-700 mb-3 uppercase text-sm tracking-wider">Available Tables</h3>
              {tables.map(table => {
                const tableName = table.original_filename.replace('.sql', '');
                return (
                  <button
                    key={table.id}
                    onClick={() => loadTableData(table.id)}
                    className={`w-full text-left px-4 py-3 rounded-lg border transition-all ${
                      selectedTableId === table.id
                        ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                        : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <div className="truncate">{tableName}</div>
                    <div className="text-xs text-gray-500 mt-1">{table.row_count.toLocaleString()} rows</div>
                  </button>
                );
              })}
            </div>

            {/* Main Content Area */}
            <div className="md:col-span-3">
              {!selectedTableId ? (
                <div className="h-full flex items-center justify-center border-2 border-dashed border-gray-200 rounded-xl bg-gray-50 min-h-[300px]">
                  <p className="text-gray-500">Select a table from the sidebar to view data</p>
                </div>
              ) : loadingData ? (
                <div className="flex items-center justify-center py-20 border rounded-xl bg-gray-50 min-h-[300px]">
                  <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                </div>
              ) : (
                <div className="border rounded-xl overflow-hidden bg-white shadow-sm">
                  {/* Toolbar */}
                  <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
                    <div className="relative w-64">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <input
                        type="text"
                        placeholder="Search across all columns..."
                        value={searchText}
                        onChange={e => { setSearchText(e.target.value); setCurrentPage(1); }}
                        className="w-full pl-9 pr-3 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div className="text-sm text-gray-600">
                      Showing {filteredData.length} results
                    </div>
                  </div>
                  
                  {/* Table */}
                  <div className="overflow-x-auto max-h-[600px]">
                    <table className="w-full text-sm text-left whitespace-nowrap">
                      <thead className="text-xs text-gray-700 uppercase bg-gray-100 sticky top-0 shadow-sm z-10">
                        <tr>
                          {headers.map((h, i) => (
                            <th key={i} className="px-4 py-3 font-semibold">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {currentData.length === 0 ? (
                          <tr>
                            <td colSpan={headers.length || 1} className="px-4 py-8 text-center text-gray-500">
                              No data matches your search.
                            </td>
                          </tr>
                        ) : (
                          currentData.map((row, rowIndex) => (
                            <tr key={rowIndex} className="hover:bg-gray-50">
                              {headers.map((_, colIndex) => (
                                <td key={colIndex} className="px-4 py-2 text-gray-600 max-w-xs truncate" title={row[colIndex] !== null ? String(row[colIndex]) : ''}>
                                  {row[colIndex] !== null ? String(row[colIndex]) : ''}
                                </td>
                              ))}
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  
                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="p-4 border-t bg-gray-50 flex items-center justify-between">
                      <button
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        className="px-3 py-1 text-sm border rounded hover:bg-gray-200 disabled:opacity-50"
                      >
                        Previous
                      </button>
                      <span className="text-sm text-gray-600">
                        Page {currentPage} of {totalPages}
                      </span>
                      <button
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                        className="px-3 py-1 text-sm border rounded hover:bg-gray-200 disabled:opacity-50"
                      >
                        Next
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
