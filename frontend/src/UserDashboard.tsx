import { useState, useEffect } from 'react';
import axios from 'axios';
import { FileText, Eye, Calendar, Search, Loader2, TrendingUp, Database, ChevronDown, ChevronUp, X, DollarSign, MapPin } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

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

interface Property {
  propertyName: string;
  city: string;
  county: string;
  marketArea: string;
  insiderDate: string;
  salePrice: string;
  units: string;
  [key: string]: any;
}

interface Filters {
  cities: string[];
  counties: string[];
  marketAreas: string[];
  dates: string[];
  priceRange: { min: number; max: number };
  unitsRange: { min: number; max: number };
}

function UserDashboard() {
  const [activeView, setActiveView] = useState<'reports' | 'search'>('reports');
  const [databaseType, setDatabaseType] = useState<'apartments' | 'industrial'>('apartments');
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [filteredReports, setFilteredReports] = useState<SavedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchText, setSearchText] = useState('');
  
  // Property search states
  const [properties, setProperties] = useState<Property[]>([]);
  const [filteredProperties, setFilteredProperties] = useState<Property[]>([]);
  const [filters, setFilters] = useState<Filters | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [propertySearchText, setPropertySearchText] = useState('');
  const [selectedCity, setSelectedCity] = useState('');
  const [selectedCounty, setSelectedCounty] = useState('');
  const [selectedMarketArea, setSelectedMarketArea] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minUnits, setMinUnits] = useState('');
  const [maxUnits, setMaxUnits] = useState('');
  const [showCountyBreakdown, setShowCountyBreakdown] = useState(false);
  const [showZipBreakdown, setShowZipBreakdown] = useState(false);
  const [propertyHistories, setPropertyHistories] = useState<Record<number, any[]>>({});

  useEffect(() => {
    fetchReports();
    loadLatestUpload();
  }, [databaseType]);

  useEffect(() => {
    filterReports();
  }, [searchText, reports]);

  useEffect(() => {
    applyPropertyFilters();
  }, [propertySearchText, selectedCity, selectedCounty, selectedMarketArea, selectedDate, minPrice, maxPrice, minUnits, maxUnits, properties]);

  const fetchReports = async () => {
    setLoading(true);
    try {
      const response = await axios.get(`${API_URL}/api/reports?database_type=${databaseType}`);
      setReports(response.data.reports);
      setFilteredReports(response.data.reports);
    } catch (err) {
      console.error('Error fetching reports:', err);
    } finally {
      setLoading(false);
    }
  };

  const filterReports = () => {
    if (!searchText.trim()) {
      setFilteredReports(reports);
      return;
    }

    const filtered = reports.filter(report => 
      report.report_name.toLowerCase().includes(searchText.toLowerCase()) ||
      report.original_filename.toLowerCase().includes(searchText.toLowerCase()) ||
      report.selected_dates.some(date => date.includes(searchText))
    );
    setFilteredReports(filtered);
  };

  const loadLatestUpload = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/properties/search`);
      const processedProperties = response.data.properties;
      
      const { cities, counties, marketAreas, dates, priceRange, unitsRange } = response.data.filters;
      
      setProperties(processedProperties);
      setFilteredProperties(processedProperties);
      setFilters({ cities, counties, marketAreas, dates, priceRange, unitsRange });
    } catch (err) {
      console.error('Error loading properties database:', err);
    }
  };

  const fetchPropertyHistory = async (propertyId: number) => {
    if (propertyHistories[propertyId]) return;
    try {
      const response = await axios.get(`${API_URL}/api/properties/${propertyId}/history`);
      setPropertyHistories(prev => ({
        ...prev,
        [propertyId]: response.data.history
      }));
    } catch (err) {
      console.error('Error fetching history:', err);
    }
  };

  const applyPropertyFilters = () => {
    let filtered = [...properties];
    
    if (propertySearchText.trim()) {
      const searchTerms = propertySearchText.toLowerCase().trim().split(' ').filter(t => t.length > 0);
      filtered = filtered.filter(p => {
        const searchableText = [
          p.propertyName,
          p.city,
          p.address,
          p.county,
          p.marketArea,
          p.historyText
        ].filter(Boolean).join(' ').toLowerCase();
        
        return searchTerms.every(term => searchableText.includes(term));
      });
    }
    
    if (selectedCity) filtered = filtered.filter(p => p.city === selectedCity);
    if (selectedCounty) filtered = filtered.filter(p => p.county === selectedCounty);
    if (selectedMarketArea) filtered = filtered.filter(p => p.marketArea === selectedMarketArea);
    if (selectedDate) filtered = filtered.filter(p => p.insiderDate === selectedDate);
    
    if (minPrice) {
      filtered = filtered.filter(p => {
        const price = parseFloat(p.salePrice?.replace(/[^0-9.-]/g, '') || '0');
        return price >= parseFloat(minPrice);
      });
    }
    
    if (maxPrice) {
      filtered = filtered.filter(p => {
        const price = parseFloat(p.salePrice?.replace(/[^0-9.-]/g, '') || '0');
        return price <= parseFloat(maxPrice);
      });
    }
    
    if (minUnits) {
      filtered = filtered.filter(p => {
        const units = parseInt(p.units?.replace(/[^0-9]/g, '') || '0');
        return units >= parseInt(minUnits);
      });
    }
    
    if (maxUnits) {
      filtered = filtered.filter(p => {
        const units = parseInt(p.units?.replace(/[^0-9]/g, '') || '0');
        return units <= parseInt(maxUnits);
      });
    }
    
    setFilteredProperties(filtered);
  };

  const clearPropertyFilters = () => {
    setPropertySearchText('');
    setSelectedCity('');
    setSelectedCounty('');
    setSelectedMarketArea('');
    setSelectedDate('');
    setMinPrice('');
    setMaxPrice('');
    setMinUnits('');
    setMaxUnits('');
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50">
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">Property Reports</h1>
          <p className="text-lg text-gray-600">
            {activeView === 'reports' ? 'Browse and access available property reports' : 'Search the latest property database'}
          </p>
        </div>

        {/* Database Type Selector */}
        <div className="flex justify-center mb-6">
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

        {/* View Toggle */}
        <div className="flex gap-4 mb-6">
          <button
            onClick={() => setActiveView('reports')}
            className={`flex-1 py-4 px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeView === 'reports'
                ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            <FileText className="w-5 h-5" />
            View Reports
          </button>
          <button
            onClick={() => setActiveView('search')}
            className={`flex-1 py-4 px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeView === 'search'
                ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            <Search className="w-5 h-5" />
            Search Properties
          </button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <div className="bg-white rounded-2xl shadow-lg p-6 border-l-4 border-blue-500">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600 mb-1">Total Reports</p>
                <p className="text-3xl font-bold text-gray-900">{reports.length}</p>
              </div>
              <FileText className="w-12 h-12 text-blue-500 opacity-20" />
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-lg p-6 border-l-4 border-green-500">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600 mb-1">Total Properties</p>
                <p className="text-3xl font-bold text-gray-900">
                  {reports.reduce((sum, r) => sum + r.property_count, 0).toLocaleString()}
                </p>
              </div>
              <Database className="w-12 h-12 text-green-500 opacity-20" />
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-lg p-6 border-l-4 border-purple-500">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600 mb-1">Latest Report</p>
                <p className="text-lg font-semibold text-gray-900">
                  {reports.length > 0 ? formatDate(reports[0].created_date).split(',')[0] : 'N/A'}
                </p>
              </div>
              <TrendingUp className="w-12 h-12 text-purple-500 opacity-20" />
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-lg p-6 border-l-4 border-yellow-500">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600 mb-1">Total Sales Value</p>
                <p className="text-2xl font-bold text-gray-900">
                  {(() => {
                    const total = properties.reduce((sum, p) => {
                      const price = parseFloat(p.salePrice?.replace(/[^0-9.-]/g, '') || '0');
                      return sum + (isNaN(price) ? 0 : price);
                    }, 0);
                    return total > 0 ? `$${total.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '$0';
                  })()}
                </p>
              </div>
              <DollarSign className="w-12 h-12 text-yellow-500 opacity-20" />
            </div>
          </div>
        </div>

        {/* County and Zip Code Breakdown */}
        {properties.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            {/* County Breakdown */}
            <div className="bg-white rounded-2xl shadow-lg p-6">
              <button
                onClick={() => setShowCountyBreakdown(!showCountyBreakdown)}
                className="w-full flex items-center justify-between mb-4"
              >
                <div className="flex items-center gap-3">
                  <MapPin className="w-6 h-6 text-blue-600" />
                  <h3 className="text-lg font-bold text-gray-800">Properties by County</h3>
                </div>
                {showCountyBreakdown ? (
                  <ChevronUp className="w-5 h-5 text-gray-400" />
                ) : (
                  <ChevronDown className="w-5 h-5 text-gray-400" />
                )}
              </button>
              {showCountyBreakdown && (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {(() => {
                    const countyCounts = properties.reduce((acc, p) => {
                      const county = p.county || 'Unknown';
                      acc[county] = (acc[county] || 0) + 1;
                      return acc;
                    }, {} as Record<string, number>);
                    
                    return Object.entries(countyCounts)
                      .sort(([, a], [, b]) => b - a)
                      .map(([county, count]) => (
                        <div key={county} className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                          <span className="font-medium text-gray-700">{county}</span>
                          <span className="text-sm font-semibold text-blue-600">{count.toLocaleString()} properties</span>
                        </div>
                      ));
                  })()}
                </div>
              )}
            </div>

            {/* Zip Code Breakdown */}
            <div className="bg-white rounded-2xl shadow-lg p-6">
              <button
                onClick={() => setShowZipBreakdown(!showZipBreakdown)}
                className="w-full flex items-center justify-between mb-4"
              >
                <div className="flex items-center gap-3">
                  <MapPin className="w-6 h-6 text-green-600" />
                  <h3 className="text-lg font-bold text-gray-800">Properties by Zip Code</h3>
                </div>
                {showZipBreakdown ? (
                  <ChevronUp className="w-5 h-5 text-gray-400" />
                ) : (
                  <ChevronDown className="w-5 h-5 text-gray-400" />
                )}
              </button>
              {showZipBreakdown && (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {(() => {
                    const zipCounts = properties.reduce((acc, p) => {
                      const zip = p.zip || 'Unknown';
                      acc[zip] = (acc[zip] || 0) + 1;
                      return acc;
                    }, {} as Record<string, number>);
                    
                    return Object.entries(zipCounts)
                      .sort(([, a], [, b]) => b - a)
                      .map(([zip, count]) => (
                        <div key={zip} className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                          <span className="font-medium text-gray-700">{zip}</span>
                          <span className="text-sm font-semibold text-green-600">{count.toLocaleString()} properties</span>
                        </div>
                      ));
                  })()}
                </div>
              )}
            </div>
          </div>
        )}

        {activeView === 'reports' ? (
          <>
            {/* Search Bar */}
            <div className="mb-6">
              <div className="relative">
                <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="Search reports by name, date, or source file..."
                  className="w-full pl-12 pr-4 py-4 bg-white border-2 border-gray-200 rounded-2xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-lg shadow-sm"
                />
              </div>
            </div>

            {/* Reports List */}
        <div className="bg-white rounded-2xl shadow-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-gray-800">Available Reports</h2>
            <span className="text-sm text-gray-500">
              {filteredReports.length} {filteredReports.length === 1 ? 'report' : 'reports'}
            </span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-10 h-10 animate-spin text-blue-600" />
            </div>
          ) : filteredReports.length === 0 ? (
            <div className="text-center py-16">
              <FileText className="w-16 h-16 mx-auto text-gray-300 mb-4" />
              <h3 className="text-lg font-semibold text-gray-800 mb-2">
                {searchText ? 'No matching reports found' : 'No reports available'}
              </h3>
              <p className="text-gray-500">
                {searchText ? 'Try adjusting your search terms' : 'Reports will appear here once they are generated'}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredReports.map((report) => (
                <div
                  key={report.id}
                  className="group border-2 border-gray-200 rounded-xl p-6 hover:border-blue-400 hover:shadow-lg transition-all duration-200"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="text-xl font-bold text-gray-900 mb-2 group-hover:text-blue-600 transition-colors">
                        {report.report_name}
                      </h3>
                      <p className="text-sm text-gray-600 mb-3">
                        Source: <span className="font-medium">{report.original_filename}</span>
                      </p>
                      <div className="flex flex-wrap gap-4 text-sm text-gray-600">
                        <div className="flex items-center gap-2">
                          <Calendar className="w-4 h-4" />
                          <span>{formatDate(report.created_date)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Database className="w-4 h-4" />
                          <span>{report.property_count.toLocaleString()} properties</span>
                        </div>
                        {report.selected_dates.length > 0 && (
                          <div className="flex items-center gap-2">
                            <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">
                              {report.selected_dates.join(', ')}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="ml-6">
                      <button
                        onClick={() => window.open(`${API_URL}/api/reports/${report.id}/view`, '_blank')}
                        className="px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-xl hover:from-blue-700 hover:to-indigo-700 transition-all duration-200 flex items-center gap-2 font-semibold shadow-md hover:shadow-lg"
                      >
                        <Eye className="w-5 h-5" />
                        View Report
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
          </>
        ) : (
          <div className="bg-white rounded-2xl shadow-xl p-6">
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-gray-800 mb-2">Property Database Search</h2>
              <p className="text-gray-600">Searching the latest uploaded data with {properties.length.toLocaleString()} properties</p>
            </div>

            {/* Property Search Bar */}
            <div className="mb-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  value={propertySearchText}
                  onChange={(e) => setPropertySearchText(e.target.value)}
                  placeholder="Search properties, cities, addresses..."
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>

            {/* Filters */}
            {filters && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                <select
                  value={selectedCity}
                  onChange={(e) => setSelectedCity(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="">All Cities</option>
                  {filters.cities.map(city => (
                    <option key={city} value={city}>{city}</option>
                  ))}
                </select>

                <select
                  value={selectedCounty}
                  onChange={(e) => setSelectedCounty(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="">All Counties</option>
                  {filters.counties.map(county => (
                    <option key={county} value={county}>{county}</option>
                  ))}
                </select>

                <select
                  value={selectedMarketArea}
                  onChange={(e) => setSelectedMarketArea(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="">All Market Areas</option>
                  {filters.marketAreas.map(area => (
                    <option key={area} value={area}>{area}</option>
                  ))}
                </select>

                <select
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="">All Dates</option>
                  {filters.dates.map(date => (
                    <option key={date} value={date}>{date}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Price and Units Range */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  value={minPrice}
                  onChange={(e) => setMinPrice(e.target.value)}
                  placeholder="Min Price"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                />
                <span className="text-gray-500">-</span>
                <input
                  type="number"
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value)}
                  placeholder="Max Price"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                />
              </div>
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  value={minUnits}
                  onChange={(e) => setMinUnits(e.target.value)}
                  placeholder="Min Units"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                />
                <span className="text-gray-500">-</span>
                <input
                  type="number"
                  value={maxUnits}
                  onChange={(e) => setMaxUnits(e.target.value)}
                  placeholder="Max Units"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                />
              </div>
            </div>

            {/* Results */}
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm text-gray-600">
                Showing <span className="font-semibold">{filteredProperties.length.toLocaleString()}</span> of <span className="font-semibold">{properties.length.toLocaleString()}</span> properties
              </p>
              <button
                onClick={clearPropertyFilters}
                className="text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1"
              >
                <X className="w-4 h-4" />
                Clear Filters
              </button>
            </div>

            {/* Property List */}
            <div className="max-h-[600px] overflow-y-auto">
              <table className="w-full">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Property</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">City</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">County</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Units</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Price</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Date</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Updates</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {filteredProperties.map((property, idx) => (
                    <>
                      <tr 
                        key={idx} 
                        className="hover:bg-gray-50 cursor-pointer" 
                        onClick={() => {
                          const isExpanding = expandedRow !== idx;
                          setExpandedRow(isExpanding ? idx : null);
                          if (isExpanding && property.id) {
                            fetchPropertyHistory(property.id);
                          }
                        }}
                      >
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">{property.propertyName}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{property.city}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{property.county}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{property.units}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{property.salePrice}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{property.insiderDate}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded-full text-xs font-medium">
                            {property.update_count || 1}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {expandedRow === idx ? (
                            <ChevronUp className="w-5 h-5 text-gray-400" />
                          ) : (
                            <ChevronDown className="w-5 h-5 text-gray-400" />
                          )}
                        </td>
                      </tr>
                      {expandedRow === idx && (
                        <tr>
                          <td colSpan={8} className="px-4 py-4 bg-gray-50">
                            <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                              <div><span className="font-semibold">Address:</span> {property.address}</div>
                              <div><span className="font-semibold">Zip:</span> {property.zip}</div>
                              <div><span className="font-semibold">Market Area:</span> {property.marketArea}</div>
                              <div><span className="font-semibold">District:</span> {property.district}</div>
                              <div><span className="font-semibold">Parcel:</span> {property.parcel}</div>
                              <div><span className="font-semibold">Tax Owner:</span> {property.taxOwner}</div>
                              <div><span className="font-semibold">Loan Amount:</span> {property.loanAmount}</div>
                            </div>

                            <div className="mt-4 pt-4 border-t border-gray-200">
                              <h4 className="font-semibold text-gray-800 mb-3">Update History</h4>
                              {!propertyHistories[property.id] ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                  Loading history...
                                </div>
                              ) : propertyHistories[property.id].length === 0 ? (
                                <p className="text-gray-500">No history available</p>
                              ) : (
                                <div className="overflow-x-auto">
                                  <table className="w-full text-sm bg-white rounded-lg overflow-hidden border border-gray-200">
                                    <thead className="bg-gray-100">
                                      <tr>
                                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Date</th>
                                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Source File</th>
                                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Sale Price</th>
                                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Insider Date</th>
                                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Units</th>
                                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">District</th>
                                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Loan</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                      {propertyHistories[property.id].map(hist => (
                                        <tr key={hist.id}>
                                          <td className="px-3 py-2">{new Date(hist.snapshot_date).toLocaleDateString()}</td>
                                          <td className="px-3 py-2 text-gray-500">{hist.original_filename}</td>
                                          <td className="px-3 py-2 font-medium">{hist.salePrice}</td>
                                          <td className="px-3 py-2">{hist.insiderDate || '-'}</td>
                                          <td className="px-3 py-2">{hist.units || '-'}</td>
                                          <td className="px-3 py-2">{hist.district || '-'}</td>
                                          <td className="px-3 py-2">{hist.loanAmount || '-'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
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

        {/* Footer */}
        <div className="mt-8 text-center text-gray-500 text-sm">
          <p>© 2025 Databank Property Reports. All rights reserved.</p>
        </div>
      </div>
    </div>
  );
}

export default UserDashboard;
