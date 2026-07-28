import { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { Search, Download, FileSpreadsheet, Upload, Loader2, AlertCircle, ChevronDown, ChevronUp, Database } from 'lucide-react';
import { formatExcelDate } from './utils/excelDate';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

interface Property {
  id: number;
  propertyName: string;
  city: string;
  county: string;
  marketArea: string;
  insiderDate: string;
  propertyType: string;
  salePrice: string;
  saleDate: string;
  units: string;
  address: string;
  zip: string;
  taxOwner: string;
}

interface Filters {
  cities: string[];
  counties: string[];
  marketAreas: string[];
  dates: string[];
  priceRange: { min: number; max: number };
  unitsRange: { min: number; max: number };
}

interface SavedUpload {
  id: number;
  filename: string;
  original_filename: string;
  upload_date: string;
  file_size: number;
  sheet_count: number;
  row_count: number;
}

function SearchComps() {
  const [databaseType, setDatabaseType] = useState<'apartments' | 'industrial'>('apartments');
  const [file, setFile] = useState<File | null>(null);
  const [savedUploads, setSavedUploads] = useState<SavedUpload[]>([]);
  const [selectedUploadId, setSelectedUploadId] = useState<number | null>(null);
  const [selectedUploadName, setSelectedUploadName] = useState<string>('');
  const [properties, setProperties] = useState<Property[]>([]);
  const [filteredProperties, setFilteredProperties] = useState<Property[]>([]);
  const [filters, setFilters] = useState<Filters | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [selectedProperties, setSelectedProperties] = useState<Set<number>>(new Set());
  
  // Filter states
  const [searchText, setSearchText] = useState('');
  const [selectedCity, setSelectedCity] = useState('');
  const [selectedCounty, setSelectedCounty] = useState('');
  const [selectedMarketArea, setSelectedMarketArea] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minUnits, setMinUnits] = useState('');
  const [maxUnits, setMaxUnits] = useState('');
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchSavedUploads();
  }, [databaseType]);

  const fetchSavedUploads = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/uploads?database_type=${databaseType}`);
      setSavedUploads(response.data.uploads);
    } catch (err) {
      console.error('Error fetching saved uploads:', err);
    }
  };

  const loadFromDatabase = async (uploadId: number) => {
    setLoading(true);
    setError(null);

    try {
      const response = await axios.get(`${API_URL}/api/uploads/${uploadId}/data`);
      const data = response.data.data;
      
      // Process the data similar to the /api/search endpoint
      const headers = data[0];
      const rows = data.slice(1);
      
      const getColIndex = (colName: string) => headers.findIndex((h: string) => h && h.trim() === colName);
      const getCellValue = (row: any[], colName: string) => {
        const idx = getColIndex(colName);
        if (idx === -1 || row[idx] === undefined || row[idx] === null || row[idx] === '') return '';
        if (colName.toUpperCase().includes('DATE')) {
          return formatExcelDate(row[idx]);
        }
        return String(row[idx]).trim();
      };

      const processedProperties = rows.map((row: any[], index: number) => ({
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
      })).filter((p: Property) => p.propertyName);

      // Extract filters
      const cities = [...new Set(processedProperties.map((p: Property) => p.city).filter(Boolean))] as string[];
      cities.sort();
      const counties = [...new Set(processedProperties.map((p: Property) => p.county).filter(Boolean))] as string[];
      counties.sort();
      const marketAreas = [...new Set(processedProperties.map((p: Property) => p.marketArea).filter(Boolean))] as string[];
      marketAreas.sort();
      const dates = [...new Set(processedProperties.map((p: Property) => p.insiderDate).filter(Boolean))] as string[];
      dates.sort().reverse();

      const prices = processedProperties.map((p: Property) => parseFloat(p.salePrice?.replace(/[^0-9.-]/g, '') || '0')).filter((p: number) => p > 0);
      const priceRange = prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : { min: 0, max: 0 };

      const unitsValues = processedProperties.map((p: Property) => parseInt(p.units?.replace(/[^0-9]/g, '') || '0')).filter((u: number) => u > 0);
      const unitsRange = unitsValues.length > 0 ? { min: Math.min(...unitsValues), max: Math.max(...unitsValues) } : { min: 0, max: 0 };

      setProperties(processedProperties);
      setFilteredProperties(processedProperties);
      setFilters({ cities, counties, marketAreas, dates, priceRange, unitsRange });
      setSelectedUploadId(uploadId);
      
      // Store the upload name for display
      const upload = savedUploads.find(u => u.id === uploadId);
      if (upload) {
        setSelectedUploadName(upload.original_filename);
      }
    } catch (err: any) {
      console.error('Error loading from database:', err);
      setError('Failed to load data from database');
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      const validTypes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'];
      if (!validTypes.includes(selectedFile.type) && !selectedFile.name.endsWith('.xlsx') && !selectedFile.name.endsWith('.xls')) {
        setError('Please upload a valid Excel file (.xlsx or .xls)');
        return;
      }
      setFile(selectedFile);
      setError(null);
      await loadData(selectedFile);
    }
  };

  const loadData = async (uploadFile: File) => {
    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.append('file', uploadFile);

    try {
      const response = await axios.post(`${API_URL}/api/search`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      setProperties(response.data.properties);
      setFilteredProperties(response.data.properties);
      setFilters(response.data.filters);
    } catch (err: any) {
      console.error('Error loading data:', err);
      setError(err.response?.data?.error || 'Failed to load data from file');
    } finally {
      setLoading(false);
    }
  };

  const applyFilters = () => {
    let filtered = [...properties];

    // Tokenized text search: every word must match at least one field
    if (searchText.trim()) {
      const tokens = searchText.toLowerCase().split(/\s+/).filter(Boolean);
      filtered = filtered.filter(p => {
        const haystack = [
          p.propertyName,
          p.city,
          p.address,
          p.county,
          p.marketArea,
          p.taxOwner,
        ].filter(Boolean).join(' ').toLowerCase();
        return tokens.every(token => haystack.includes(token));
      });
    }

    if (selectedCity) {
      filtered = filtered.filter(p => p.city === selectedCity);
    }

    if (selectedCounty) {
      filtered = filtered.filter(p => p.county === selectedCounty);
    }

    if (selectedMarketArea) {
      filtered = filtered.filter(p => p.marketArea === selectedMarketArea);
    }

    if (selectedDate) {
      filtered = filtered.filter(p => p.insiderDate === selectedDate);
    }

    if (minPrice) {
      const min = parseFloat(minPrice);
      filtered = filtered.filter(p => {
        const price = parseFloat(p.salePrice?.replace(/[^0-9.-]/g, '') || '0');
        return price >= min;
      });
    }

    if (maxPrice) {
      const max = parseFloat(maxPrice);
      filtered = filtered.filter(p => {
        const price = parseFloat(p.salePrice?.replace(/[^0-9.-]/g, '') || '0');
        return price <= max;
      });
    }

    if (minUnits) {
      const min = parseInt(minUnits);
      filtered = filtered.filter(p => {
        const units = parseInt(p.units?.replace(/[^0-9]/g, '') || '0');
        return units >= min;
      });
    }

    if (maxUnits) {
      const max = parseInt(maxUnits);
      filtered = filtered.filter(p => {
        const units = parseInt(p.units?.replace(/[^0-9]/g, '') || '0');
        return units <= max;
      });
    }

    setFilteredProperties(filtered);
  };

  const clearFilters = () => {
    setSearchText('');
    setSelectedCity('');
    setSelectedCounty('');
    setSelectedMarketArea('');
    setSelectedDate('');
    setMinPrice('');
    setMaxPrice('');
    setMinUnits('');
    setMaxUnits('');
    setFilteredProperties(properties);
  };

  const togglePropertySelection = (id: number) => {
    const newSelected = new Set(selectedProperties);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedProperties(newSelected);
  };

  const selectAll = () => {
    if (selectedProperties.size === filteredProperties.length) {
      setSelectedProperties(new Set());
    } else {
      setSelectedProperties(new Set(filteredProperties.map(p => p.id)));
    }
  };

  const formatCurrency = (value: string) => {
    if (!value) return '-';
    const num = parseFloat(value.replace(/[^0-9.-]/g, ''));
    if (isNaN(num)) return '-';
    return `$${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  };

  return (
    <div className="space-y-6">
      {/* Database Type Selector */}
      <div className="flex justify-center">
        <div className="inline-flex rounded-xl bg-white shadow-md p-1">
          <button
            onClick={() => setDatabaseType('apartments')}
            className={`px-6 py-3 rounded-lg font-semibold transition-all ${
              databaseType === 'apartments'
                ? 'bg-blue-600 text-white shadow-md'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            🏢 Apartments
          </button>
          <button
            onClick={() => setDatabaseType('industrial')}
            className={`px-6 py-3 rounded-lg font-semibold transition-all ${
              databaseType === 'industrial'
                ? 'bg-blue-600 text-white shadow-md'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            🏭 Industrial
          </button>
        </div>
      </div>

      {/* Upload Section */}
      {!file && !selectedUploadId && (
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <h2 className="text-2xl font-bold text-gray-800 mb-4">Databank Comps Search</h2>
          <p className="text-gray-600 mb-6">Select a saved upload or upload a new Excel file to start searching</p>
          
          {/* Saved Uploads */}
          {savedUploads.length > 0 && (
            <div className="mb-8">
              <div className="flex items-center gap-2 mb-4">
                <Database className="w-5 h-5 text-blue-600" />
                <h3 className="font-semibold text-gray-800">Saved Uploads ({savedUploads.length})</h3>
              </div>
              <div className="grid gap-3 mb-6">
                {savedUploads.map((upload) => (
                  <button
                    key={upload.id}
                    onClick={() => loadFromDatabase(upload.id)}
                    className="flex items-center gap-4 p-4 border-2 border-gray-200 rounded-lg hover:border-blue-400 hover:bg-blue-50 transition-all text-left"
                  >
                    <FileSpreadsheet className="w-8 h-8 text-green-600 flex-shrink-0" />
                    <div className="flex-1">
                      <p className="font-medium text-gray-800">{upload.original_filename}</p>
                      <p className="text-sm text-gray-500">
                        {upload.row_count.toLocaleString()} rows • {new Date(upload.upload_date).toLocaleDateString()}
                      </p>
                    </div>
                    <ChevronDown className="w-5 h-5 text-gray-400 rotate-[-90deg]" />
                  </button>
                ))}
              </div>
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-300"></div>
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-2 bg-white text-gray-500">OR</span>
                </div>
              </div>
            </div>
          )}

          {/* Upload New File */}
          <div className="border-2 border-dashed border-gray-300 rounded-xl p-12 text-center hover:border-blue-400 hover:bg-blue-50 transition-all">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              className="hidden"
              id="search-file-upload"
            />
            <label htmlFor="search-file-upload" className="cursor-pointer">
              <Upload className="w-16 h-16 mx-auto text-gray-400 mb-4" />
              <p className="text-lg font-medium text-gray-700 mb-2">
                Upload New Excel File
              </p>
              <p className="text-sm text-gray-500">Drop file here or click to browse</p>
            </label>
          </div>
        </div>
      )}

      {/* Search and Filters */}
      {(file || selectedUploadId) && properties.length > 0 && (
        <div className="bg-white rounded-2xl shadow-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <FileSpreadsheet className="w-6 h-6 text-blue-600" />
              <div>
                <h3 className="font-semibold text-gray-800">{file ? file.name : selectedUploadName}</h3>
                <p className="text-sm text-gray-500">{properties.length} properties loaded</p>
              </div>
            </div>
            <button
              onClick={() => {
                setFile(null);
                setSelectedUploadId(null);
                setSelectedUploadName('');
                setProperties([]);
                setFilteredProperties([]);
                setFilters(null);
                clearFilters();
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              className="text-red-500 hover:text-red-700 text-sm font-medium"
            >
              Change Source
            </button>
          </div>

          {/* Search Bar */}
          <div className="mb-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="text"
                value={searchText}
                onChange={(e) => {
                  setSearchText(e.target.value);
                  setTimeout(() => applyFilters(), 300);
                }}
                placeholder="Search properties, cities, addresses..."
                className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>

          {/* Filters */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <select
              value={selectedCity}
              onChange={(e) => { setSelectedCity(e.target.value); applyFilters(); }}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
            >
              <option value="">All Cities</option>
              {filters?.cities.map(city => (
                <option key={city} value={city}>{city}</option>
              ))}
            </select>

            <select
              value={selectedCounty}
              onChange={(e) => { setSelectedCounty(e.target.value); applyFilters(); }}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
            >
              <option value="">All Counties</option>
              {filters?.counties.map(county => (
                <option key={county} value={county}>{county}</option>
              ))}
            </select>

            <select
              value={selectedMarketArea}
              onChange={(e) => { setSelectedMarketArea(e.target.value); applyFilters(); }}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
            >
              <option value="">All Market Areas</option>
              {filters?.marketAreas.map(area => (
                <option key={area} value={area}>{area}</option>
              ))}
            </select>

            <select
              value={selectedDate}
              onChange={(e) => { setSelectedDate(e.target.value); applyFilters(); }}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
            >
              <option value="">All Dates</option>
              {filters?.dates.map(date => (
                <option key={date} value={date}>{date}</option>
              ))}
            </select>
          </div>

          {/* Price and Units Range */}
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div className="flex gap-2 items-center">
              <input
                type="number"
                value={minPrice}
                onChange={(e) => { setMinPrice(e.target.value); applyFilters(); }}
                placeholder="Min Price"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              />
              <span className="text-gray-500">-</span>
              <input
                type="number"
                value={maxPrice}
                onChange={(e) => { setMaxPrice(e.target.value); applyFilters(); }}
                placeholder="Max Price"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              />
            </div>

            <div className="flex gap-2 items-center">
              <input
                type="number"
                value={minUnits}
                onChange={(e) => { setMinUnits(e.target.value); applyFilters(); }}
                placeholder="Min Units"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              />
              <span className="text-gray-500">-</span>
              <input
                type="number"
                value={maxUnits}
                onChange={(e) => { setMaxUnits(e.target.value); applyFilters(); }}
                placeholder="Max Units"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              Showing {filteredProperties.length} of {properties.length} properties
              {selectedProperties.size > 0 && (
                <span className="ml-2 text-blue-600 font-medium">
                  ({selectedProperties.size} selected)
                </span>
              )}
            </p>
            <button
              onClick={clearFilters}
              className="text-sm text-gray-600 hover:text-gray-800 font-medium"
            >
              Clear Filters
            </button>
          </div>
        </div>
      )}

      {/* Results Table */}
      {filteredProperties.length > 0 && (
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
          <div className="p-4 border-b border-gray-200 flex items-center justify-between">
            <h3 className="font-semibold text-gray-800">Search Results</h3>
            <div className="flex gap-2">
              <button
                onClick={selectAll}
                className="px-4 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
              >
                {selectedProperties.size === filteredProperties.length ? 'Deselect All' : 'Select All'}
              </button>
              <button
                disabled={selectedProperties.size === 0}
                className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors flex items-center gap-2 ${
                  selectedProperties.size === 0
                    ? 'bg-gray-300 cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                <Download className="w-4 h-4" />
                Generate PDF ({selectedProperties.size})
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    <input
                      type="checkbox"
                      checked={selectedProperties.size === filteredProperties.length && filteredProperties.length > 0}
                      onChange={selectAll}
                      className="w-4 h-4 text-blue-600 rounded"
                    />
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Property Name</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">City</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Sale Price</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Units</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredProperties.map((property) => (
                  <>
                    <tr
                      key={property.id}
                      className={`hover:bg-gray-50 transition-colors ${
                        selectedProperties.has(property.id) ? 'bg-blue-50' : ''
                      }`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedProperties.has(property.id)}
                          onChange={() => togglePropertySelection(property.id)}
                          className="w-4 h-4 text-blue-600 rounded"
                        />
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">
                        {property.propertyName || '-'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{property.city || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-900 font-medium">
                        {formatCurrency(property.salePrice)}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{property.units || '-'}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{property.insiderDate || '-'}</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setExpandedRow(expandedRow === property.id ? null : property.id)}
                          className="text-blue-600 hover:text-blue-700"
                        >
                          {expandedRow === property.id ? (
                            <ChevronUp className="w-5 h-5" />
                          ) : (
                            <ChevronDown className="w-5 h-5" />
                          )}
                        </button>
                      </td>
                    </tr>
                    {expandedRow === property.id && (
                      <tr className="bg-gray-50">
                        <td colSpan={7} className="px-4 py-4">
                          <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                              <p className="text-gray-500 text-xs">Address</p>
                              <p className="font-medium">{property.address || '-'}</p>
                            </div>
                            <div>
                              <p className="text-gray-500 text-xs">County</p>
                              <p className="font-medium">{property.county || '-'}</p>
                            </div>
                            <div>
                              <p className="text-gray-500 text-xs">Market Area</p>
                              <p className="font-medium">{property.marketArea || '-'}</p>
                            </div>
                            <div>
                              <p className="text-gray-500 text-xs">Property Type</p>
                              <p className="font-medium">{property.propertyType || '-'}</p>
                            </div>
                            <div>
                              <p className="text-gray-500 text-xs">Tax Owner</p>
                              <p className="font-medium">{property.taxOwner || '-'}</p>
                            </div>
                            <div>
                              <p className="text-gray-500 text-xs">Sale Date</p>
                              <p className="font-medium">{property.saleDate || '-'}</p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="bg-white rounded-2xl shadow-xl p-12 text-center">
          <Loader2 className="w-12 h-12 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-gray-600">Loading data...</p>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
          <p className="text-red-700">{error}</p>
        </div>
      )}
    </div>
  );
}

export default SearchComps;