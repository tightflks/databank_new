import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { FileText, Eye, Calendar, Search, Loader2, TrendingUp, Database, ChevronDown, ChevronUp, X, DollarSign, MapPin, Building2, BarChart3, Sparkles } from 'lucide-react';
import { formatExcelDate } from './utils/excelDate';
import { computePricePerUnit } from './utils/pricePerUnit';

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

const DATABASE_OPTIONS = [
  { value: 'apartments', label: '🏢 Apartments' },
  { value: 'franchise', label: '🏪 Franchise' },
  { value: 'industrial', label: '🏭 Industrial' },
  { value: 'land', label: '🌳 Land' },
  { value: 'offices', label: '🏛️ Offices' },
  { value: 'retail', label: '🛍️ Retail' },
];

interface SavedReport {
  id: number;
  upload_id: number;
  report_name: string;
  selected_dates: string[];
  created_date: string;
  property_count: number;
  original_filename: string;
  source_upload_date: string;
  is_latest?: number;
}

interface Property {
  propertyName: string;
  city: string;
  county: string;
  marketArea: string;
  insiderDate: string;
  lastInsiderDate: string;
  salePrice: string;
  saleDate: string;
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
  const [activeView, setActiveView] = useState<'search' | 'dashboard' | 'reports'>('search');
  const [databaseType, setDatabaseType] = useState('apartments');
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
  const [selectedCounties, setSelectedCounties] = useState<string[]>([]);
  const [countyDropdownOpen, setCountyDropdownOpen] = useState(false);
  const [selectedMarketArea, setSelectedMarketArea] = useState('');
  const [selectedZipcode, setSelectedZipcode] = useState('');
  const [selectedDistrict, setSelectedDistrict] = useState('');
  const [selectedLandLot, setSelectedLandLot] = useState('');
  const [selectedSeller, setSelectedSeller] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const [streetFilter, setStreetFilter] = useState('');
  const [minPricePerUnit, setMinPricePerUnit] = useState('');
  const [maxPricePerUnit, setMaxPricePerUnit] = useState('');
  const [showTopOwners, setShowTopOwners] = useState(false);
  const [selectedDate, setSelectedDate] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minLandPrice, setMinLandPrice] = useState('');
  const [maxLandPrice, setMaxLandPrice] = useState('');
  const [minUnits, setMinUnits] = useState('');
  const [maxUnits, setMaxUnits] = useState('');
  const [minAcres, setMinAcres] = useState('');
  const [maxAcres, setMaxAcres] = useState('');
  const [minYearBuilt, setMinYearBuilt] = useState('');
  const [maxYearBuilt, setMaxYearBuilt] = useState('');
  const [landSaleDateAfter, setLandSaleDateAfter] = useState('');
  const [landSaleDateBefore, setLandSaleDateBefore] = useState('');
  const [latestUploadName, setLatestUploadName] = useState('');
  const [excelHeaders, setExcelHeaders] = useState<string[]>([]);
  const [selectedProperty, setSelectedProperty] = useState<Property | null>(null);

  // AI natural language search states
  const [aiQuery, setAiQuery] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);
  const [saleDateAfter, setSaleDateAfter] = useState('');
  const [saleDateBefore, setSaleDateBefore] = useState('');
  const [insiderDateAfter, setInsiderDateAfter] = useState('');
  const [insiderDateBefore, setInsiderDateBefore] = useState('');

  // Stats over the properties belonging to the 10 most recent insider dates (before today)
  const recentInsiderStats = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const recentDates = Array.from(new Set(properties.map(p => p.insiderDate).filter(Boolean)))
      .filter(d => {
        const t = new Date(d).getTime();
        return !isNaN(t) && t < startOfToday.getTime();
      })
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())
      .slice(0, 10);

    const dateSet = new Set(recentDates);
    const recent = properties.filter(p => dateSet.has(p.insiderDate));

    const parseNum = (value: string) => {
      const n = parseFloat(String(value ?? '').replace(/[^0-9.-]/g, ''));
      return isNaN(n) ? 0 : n;
    };

    const prices = recent.map(p => parseNum(p.salePrice)).filter(n => n > 0);
    prices.sort((a, b) => a - b);
    const totalVolume = prices.reduce((sum, n) => sum + n, 0);
    const avgPrice = prices.length > 0 ? totalVolume / prices.length : 0;
    const medianPrice = prices.length > 0
      ? prices.length % 2 === 1
        ? prices[Math.floor(prices.length / 2)]
        : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
      : 0;

    const totalUnits = recent.reduce((sum, p) => sum + parseNum(p.units), 0);

    const countyMap = new Map<string, { count: number; volume: number }>();
    recent.forEach(p => {
      const county = (p.county || '').trim();
      if (!county) return;
      const entry = countyMap.get(county) || { count: 0, volume: 0 };
      entry.count += 1;
      entry.volume += parseNum(p.salePrice);
      countyMap.set(county, entry);
    });
    const topCounties = Array.from(countyMap.entries())
      .map(([county, { count, volume }]) => ({ county, count, volume }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const cityMap = new Map<string, number>();
    recent.forEach(p => {
      const city = (p.city || '').trim();
      if (city) cityMap.set(city, (cityMap.get(city) || 0) + 1);
    });
    const topCities = Array.from(cityMap.entries())
      .map(([city, count]) => ({ city, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      dates: recentDates,
      propertyCount: recent.length,
      pricedCount: prices.length,
      totalVolume,
      avgPrice,
      medianPrice,
      maxPrice: prices.length > 0 ? prices[prices.length - 1] : 0,
      totalUnits,
      topCounties,
      topCities
    };
  }, [properties]);

  // Top owners across the currently filtered results (answers "who owns a lot of properties in X")
  const topOwners = useMemo(() => {
    const parseNum = (value: string) => {
      const n = parseFloat(String(value ?? '').replace(/[^0-9.-]/g, ''));
      return isNaN(n) ? 0 : n;
    };
    const ownerMap = new Map<string, { count: number; volume: number; units: number }>();
    filteredProperties.forEach(p => {
      const owner = (p.owner || p.taxOwner || '').trim();
      if (!owner) return;
      const entry = ownerMap.get(owner) || { count: 0, volume: 0, units: 0 };
      entry.count += 1;
      entry.volume += parseNum(p.salePrice);
      entry.units += parseNum(p.units);
      ownerMap.set(owner, entry);
    });
    return Array.from(ownerMap.entries())
      .map(([owner, stats]) => ({ owner, ...stats }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);
  }, [filteredProperties]);

  const formatCompactCurrency = (value: number) => {
    if (value <= 0) return '-';
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  };

  useEffect(() => {
    fetchReports();
    loadLatestUpload();
  }, [databaseType]);

  useEffect(() => {
    filterReports();
  }, [searchText, reports]);

  useEffect(() => {
    applyPropertyFilters();
  }, [propertySearchText, selectedCity, selectedCounties, selectedMarketArea, selectedZipcode, selectedDistrict, selectedLandLot, selectedSeller, ownerFilter, entityFilter, streetFilter, selectedDate, minPrice, maxPrice, minLandPrice, maxLandPrice, minPricePerUnit, maxPricePerUnit, minUnits, maxUnits, minAcres, maxAcres, minYearBuilt, maxYearBuilt, saleDateAfter, saleDateBefore, insiderDateAfter, insiderDateBefore, landSaleDateAfter, landSaleDateBefore, properties]);

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
      // Reset state so stale data from another database doesn't persist
      setProperties([]);
      setFilteredProperties([]);
      setFilters(null);
      setLatestUploadName('');
      setExcelHeaders([]);

      const uploadsResponse = await axios.get(`${API_URL}/api/uploads?database_type=${databaseType}`);
      const uploads = uploadsResponse.data.uploads;
      
      if (uploads.length === 0) return;
      
      // Get the latest upload (first one, as they're sorted by date DESC)
      const latestUpload = uploads[0];
      setLatestUploadName(latestUpload.original_filename);
      
      // Load the Excel data
      const dataResponse = await axios.get(`${API_URL}/api/uploads/${latestUpload.id}/data`);
      const excelData = dataResponse.data.data;
      
      if (!excelData || excelData.length === 0) return;
      
      const headers = excelData[0];
      const dataRows = excelData.slice(1);
      setExcelHeaders(headers);
      
      const processedProperties = dataRows.map((row: any[]) => {
        const getCell = (header: string) => {
          const idx = headers.findIndex((h: string) => h && h.trim().toLowerCase() === header.toLowerCase());
          return idx >= 0 ? (row[idx] || '') : '';
        };
        
        // Find "last/previous insider date" column with flexible matching
        const lastInsiderIdx = headers.findIndex((h: string) => {
          if (!h) return false;
          const lower = h.trim().toLowerCase();
          return lower.includes('insider') && lower.includes('date') && (lower.includes('previous') || lower.includes('last'));
        });
        const lastInsiderRaw = lastInsiderIdx >= 0 ? (row[lastInsiderIdx] || '') : '';

        const salePriceStr = String(getCell('SALE PRICE')).trim();
        const unitsStr = String(getCell('UNITS COMPLETED')).trim();
        const pricePerUnit = computePricePerUnit(salePriceStr, unitsStr, String(getCell('$ UNIT PROJECT')).trim());

        return {
          propertyName: String(getCell('P NAME')).trim(),
          description: String(getCell('P TYPE')).trim(),
          streetNumber: String(getCell('P STREET NUMBER')).trim(),
          streetName: String(getCell('P STREET NAME')).trim(),
          city: String(getCell('P CITY')).trim(),
          county: String(getCell('COUNTY')).trim(),
          marketArea: String(getCell('MARKET AREA')).trim(),
          insiderDate: formatExcelDate(getCell('INSIDER DATE')),
          lastInsiderDate: formatExcelDate(lastInsiderRaw),
          salePrice: salePriceStr,
          saleDate: formatExcelDate(getCell('SALE DATE')),
          landSalePrice: String(getCell('LAND SALE PRICE')).trim(),
          landSaleDate: formatExcelDate(getCell('LAND SALE DATE')),
          units: unitsStr,
          pricePerUnit: pricePerUnit > 0 ? String(pricePerUnit) : '',
          acres: String(getCell('# ACRES')).trim(),
          yearBuilt: String(getCell('YEAR BUILT')).trim(),
          address: String(getCell('P STREET NUMBER')).trim() + ' ' + String(getCell('P STREET NAME')).trim(),
          zip: String(getCell('P ZIP')).trim(),
          district: String(getCell('DISTRICT2')).trim(),
          landLot: String(getCell('LAND LOT')).trim(),
          parcel: String(getCell('PARCEL')).trim(),
          taxOwner: String(getCell('TAX OWNER')).trim(),
          owner: String(getCell('OWNER')).trim(),
          ownerAttention: String(getCell('OWNER2\\ATTENTION')).trim(),
          seller: String(getCell('SELLER\\FORECLOSEE') || getCell('SELLER')).trim(),
          loanAmount: String(getCell('$ LOAN')).trim(),
          raw: row
        };
      }).filter((p: Property) => p.propertyName);
      
      const cities = [...new Set(processedProperties.map((p: Property) => p.city).filter(Boolean))] as string[];
      const counties = [...new Set(processedProperties.map((p: Property) => p.county).filter(Boolean))] as string[];
      const marketAreas = [...new Set(processedProperties.map((p: Property) => p.marketArea).filter(Boolean))] as string[];
      const dates = [...new Set(processedProperties.map((p: Property) => p.insiderDate).filter(Boolean))] as string[];
      
      const prices = processedProperties.map((p: Property) => parseFloat(p.salePrice?.replace(/[^0-9.-]/g, '') || '0')).filter((p: number) => p > 0);
      const priceRange = prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : { min: 0, max: 0 };
      
      const unitsValues = processedProperties.map((p: Property) => parseInt(p.units?.replace(/[^0-9]/g, '') || '0')).filter((u: number) => u > 0);
      const unitsRange = unitsValues.length > 0 ? { min: Math.min(...unitsValues), max: Math.max(...unitsValues) } : { min: 0, max: 0 };
      
      setProperties(processedProperties);
      setFilteredProperties(processedProperties);
      setFilters({ cities, counties, marketAreas, dates, priceRange, unitsRange });
    } catch (err) {
      console.error('Error loading latest upload:', err);
    }
  };

  const applyPropertyFilters = () => {
    let filtered = [...properties];
    
    // Text search across ALL fields in the property
    if (propertySearchText.trim()) {
      const tokens = propertySearchText.toLowerCase().split(/\s+/).filter(Boolean);
      filtered = filtered.filter(p => {
        // Search across all string values in the property object
        const allValues = Object.values(p)
          .filter(v => typeof v === 'string')
          .join(' ')
          .toLowerCase();
        return tokens.every(token => allValues.includes(token));
      });
    }
    
    // Location filters
    if (selectedCity) filtered = filtered.filter(p => p.city === selectedCity);
    if (selectedCounties.length > 0) filtered = filtered.filter(p => selectedCounties.includes(p.county));
    if (selectedMarketArea) filtered = filtered.filter(p => p.marketArea === selectedMarketArea);
    if (selectedZipcode) {
      const targetZip = String(selectedZipcode).trim().slice(0, 5);
      filtered = filtered.filter(p => String(p.zip || '').trim().slice(0, 5) === targetZip);
    }
    if (selectedDistrict) {
      const target = String(selectedDistrict).trim();
      filtered = filtered.filter(p => String(p.district || '').trim() === target);
    }
    if (selectedLandLot) {
      const target = String(selectedLandLot).trim();
      filtered = filtered.filter(p => String(p.landLot || '').trim() === target);
    }
    if (streetFilter) {
      const target = streetFilter.trim().toLowerCase();
      filtered = filtered.filter(p =>
        String(p.streetName || '').toLowerCase().includes(target) ||
        String(p.address || '').toLowerCase().includes(target)
      );
    }
    if (selectedDate) filtered = filtered.filter(p => p.insiderDate === selectedDate);
    
    // Entity filters (partial, case-insensitive name matching)
    const nameMatch = (value: string | undefined, needle: string) =>
      String(value || '').toLowerCase().includes(needle.trim().toLowerCase());
    const matchesOwner = (p: Property, needle: string) =>
      nameMatch(p.owner, needle) || nameMatch(p.taxOwner, needle) || nameMatch(p.ownerAttention, needle);
    if (ownerFilter) filtered = filtered.filter(p => matchesOwner(p, ownerFilter));
    if (selectedSeller) filtered = filtered.filter(p => nameMatch(p.seller, selectedSeller));
    if (entityFilter) filtered = filtered.filter(p => matchesOwner(p, entityFilter) || nameMatch(p.seller, entityFilter));
    
    // Numeric range helpers
    const parseNum = (val: string | undefined) => parseFloat(String(val || '').replace(/[^0-9.-]/g, '') || '0');
    const parseInt_ = (val: string | undefined) => parseInt(String(val || '').replace(/[^0-9]/g, '') || '0');
    
    // Sale price range
    if (minPrice) filtered = filtered.filter(p => parseNum(p.salePrice) >= parseFloat(minPrice));
    if (maxPrice) filtered = filtered.filter(p => parseNum(p.salePrice) <= parseFloat(maxPrice));
    
    // Price per unit range (calculated: sale price / units)
    if (minPricePerUnit) filtered = filtered.filter(p => parseNum(p.pricePerUnit) >= parseFloat(minPricePerUnit));
    if (maxPricePerUnit) filtered = filtered.filter(p => {
      const ppu = parseNum(p.pricePerUnit);
      return ppu > 0 && ppu <= parseFloat(maxPricePerUnit);
    });
    
    // Land price range
    if (minLandPrice) filtered = filtered.filter(p => parseNum(p.landSalePrice) >= parseFloat(minLandPrice));
    if (maxLandPrice) filtered = filtered.filter(p => parseNum(p.landSalePrice) <= parseFloat(maxLandPrice));
    
    // Units range
    if (minUnits) filtered = filtered.filter(p => parseInt_(p.units) >= parseInt(minUnits));
    if (maxUnits) filtered = filtered.filter(p => parseInt_(p.units) <= parseInt(maxUnits));
    
    // Acres range
    if (minAcres) filtered = filtered.filter(p => parseNum(p.acres) >= parseFloat(minAcres));
    if (maxAcres) filtered = filtered.filter(p => parseNum(p.acres) <= parseFloat(maxAcres));
    
    // Year built range
    if (minYearBuilt) filtered = filtered.filter(p => parseInt_(p.yearBuilt) >= parseInt(minYearBuilt));
    if (maxYearBuilt) filtered = filtered.filter(p => parseInt_(p.yearBuilt) <= parseInt(maxYearBuilt));
    
    // Date range helper
    const inDateRange = (dateStr: string, after: string, before: string) => {
      const t = new Date(dateStr).getTime();
      if (isNaN(t)) return false;
      if (after && t < new Date(after).getTime()) return false;
      if (before && t > new Date(before).getTime()) return false;
      return true;
    };

    // Date filters
    if (saleDateAfter || saleDateBefore) {
      filtered = filtered.filter(p => p.saleDate && inDateRange(p.saleDate, saleDateAfter, saleDateBefore));
    }
    if (insiderDateAfter || insiderDateBefore) {
      filtered = filtered.filter(p => p.insiderDate && inDateRange(p.insiderDate, insiderDateAfter, insiderDateBefore));
    }
    if (landSaleDateAfter || landSaleDateBefore) {
      filtered = filtered.filter(p => p.landSaleDate && inDateRange(p.landSaleDate, landSaleDateAfter, landSaleDateBefore));
    }
    
    setFilteredProperties(filtered);
  };

  const clearPropertyFilters = () => {
    setPropertySearchText('');
    setSelectedCity('');
    setSelectedCounties([]);
    setSelectedMarketArea('');
    setSelectedZipcode('');
    setSelectedDistrict('');
    setSelectedLandLot('');
    setSelectedSeller('');
    setOwnerFilter('');
    setEntityFilter('');
    setStreetFilter('');
    setSelectedDate('');
    setMinPrice('');
    setMaxPrice('');
    setMinLandPrice('');
    setMaxLandPrice('');
    setMinPricePerUnit('');
    setMaxPricePerUnit('');
    setMinUnits('');
    setMaxUnits('');
    setMinAcres('');
    setMaxAcres('');
    setMinYearBuilt('');
    setMaxYearBuilt('');
    setSaleDateAfter('');
    setSaleDateBefore('');
    setInsiderDateAfter('');
    setInsiderDateBefore('');
    setLandSaleDateAfter('');
    setLandSaleDateBefore('');
    setAiExplanation(null);
    setAiError(null);
  };

  const handleAiSearch = async () => {
    if (!aiQuery.trim() || aiLoading) return;

    setAiLoading(true);
    setAiError(null);
    setAiExplanation(null);

    try {
      const response = await axios.post(`${API_URL}/api/nl-search`, {
        query: aiQuery,
        database_type: databaseType
      });

      const f = response.data.filters || {};

      // The AI may return a single value or an array; take the first entry either way
      const one = (v: any) => (v == null ? '' : String(Array.isArray(v) ? v[0] ?? '' : v));

      // Reset previous filters, then apply the AI-derived ones
      setPropertySearchText(one(f.search_text));
      setSelectedCity(one(f.city));
      setSelectedCounties(Array.isArray(f.counties) ? f.counties.map(String) : f.county ? [String(f.county)] : []);
      setSelectedMarketArea(one(f.market_area));
      setSelectedZipcode(one(f.zipcode));
      setSelectedDistrict(one(f.district));
      setSelectedLandLot(one(f.land_lot));
      setSelectedSeller(one(f.seller));
      setOwnerFilter(one(f.owner));
      setEntityFilter(one(f.entity));
      setStreetFilter(one(f.street));
      setShowTopOwners(Boolean(f.show_top_owners));
      setSelectedDate('');
      // Sale price
      setMinPrice(f.min_sale_price != null ? String(f.min_sale_price) : '');
      setMaxPrice(f.max_sale_price != null ? String(f.max_sale_price) : '');
      // Land price
      setMinLandPrice(f.min_land_price != null ? String(f.min_land_price) : '');
      setMaxLandPrice(f.max_land_price != null ? String(f.max_land_price) : '');
      // Price per unit (calculated)
      setMinPricePerUnit(f.min_price_per_unit != null ? String(f.min_price_per_unit) : '');
      setMaxPricePerUnit(f.max_price_per_unit != null ? String(f.max_price_per_unit) : '');
      // Units
      setMinUnits(f.min_units != null ? String(f.min_units) : '');
      setMaxUnits(f.max_units != null ? String(f.max_units) : '');
      // Acres
      setMinAcres(f.min_acres != null ? String(f.min_acres) : '');
      setMaxAcres(f.max_acres != null ? String(f.max_acres) : '');
      // Year built
      setMinYearBuilt(f.min_year_built != null ? String(f.min_year_built) : '');
      setMaxYearBuilt(f.max_year_built != null ? String(f.max_year_built) : '');
      // Dates
      setSaleDateAfter(f.sale_date_after || '');
      setSaleDateBefore(f.sale_date_before || '');
      setInsiderDateAfter(f.insider_date_after || '');
      setInsiderDateBefore(f.insider_date_before || '');
      setLandSaleDateAfter(f.land_sale_date_after || '');
      setLandSaleDateBefore(f.land_sale_date_before || '');
      setAiExplanation(f.explanation || 'Filters applied.');
      setActiveView('search');
    } catch (err: any) {
      console.error('AI search error:', err);
      setAiError(err.response?.data?.error || 'AI search failed. Please try again.');
    } finally {
      setAiLoading(false);
    }
  };

  const getReportValue = (property: Property, colName: string) => {
    const idx = excelHeaders.findIndex((h: string) => h && h.trim() === colName);
    if (idx === -1) return '';
    const value = property.raw?.[idx];
    if (value === undefined || value === null || value === '') return '';
    if (colName.toUpperCase().includes('DATE')) return formatExcelDate(value);
    return String(value).trim();
  };

  const formatCurrency = (value: string) => {
    if (!value) return '';
    const num = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
    if (isNaN(num) || num === 0) return '';
    return `$${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  };

  const formatUnits = (value: string) => {
    if (!value) return '';
    const num = parseInt(String(value).replace(/[^0-9]/g, ''));
    if (isNaN(num) || num === 0) return '';
    return num.toLocaleString('en-US');
  };

  const getFullComments = (property: Property) => {
    return ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10']
      .map(col => getReportValue(property, col))
      .filter(Boolean)
      .join(' ');
  };

  const buildReportSections = (property: Property) => {
    const get = (col: string) => getReportValue(property, col);
    return [
      {
        title: 'Property Profile',
        fields: [
          { label: 'Property Name', value: get('P NAME') },
          { label: 'Address', value: `${get('P STREET NUMBER')} ${get('P STREET NAME')}`.trim() },
          { label: 'City', value: get('P CITY') },
          { label: 'County', value: get('COUNTY') },
          { label: 'Market Area', value: get('MARKET AREA') },
          { label: 'Zip', value: get('P ZIP') },
          { label: 'District', value: get('DISTRICT2') },
          { label: 'Cross Road', value: get('P CROSS STREET NAME') },
          { label: 'Parcel', value: get('PARCEL') },
        ],
      },
      {
        title: 'Property Details',
        fields: [
          { label: 'Insider Date', value: get('INSIDER DATE') },
          { label: 'Previous Insider Date 1', value: get('PREVIOUS INSIDER DATE 1') },
          { label: 'Previous Insider Date 2', value: get('PREVIOUS INSIDER DATE 2') },
          { label: 'Previous Insider Date 3', value: get('PREVIOUS INSIDER DATE 3') },
          { label: 'Insider Description', value: get('P TYPE') },
          { label: 'Units / $ Unit', value: [formatUnits(get('UNITS COMPLETED')), formatCurrency(property.pricePerUnit) || get('$ UNIT PROJECT')].filter(Boolean).join(' / ') },
          { label: 'Tax Owner', value: get('TAX OWNER') },
          { label: 'Owner (Buyer)', value: get('OWNER') },
          { label: 'Seller', value: get('SELLER\\FORECLOSEE') },
          { label: 'Onsite Telephone', value: get('ONSITE PHONE') },
          { label: 'Acres / $ Per Acre', value: [get('# ACRES'), get('$ ACRE')].filter(Boolean).join(' / ') },
          { label: 'Square Ft', value: get('HEATED SF') },
          { label: 'Loan Amount', value: formatCurrency(get('$ LOAN')) },
          { label: 'Attorney Name', value: get('ATTORNEY') },
          { label: 'Attorney Telephone', value: get('ATTORNEY PHONE') },
        ],
      },
      {
        title: 'Financial Highlights',
        fields: [
          { label: 'Property Sale Amount', value: formatCurrency(get('SALE PRICE')) },
          { label: 'Property Sale Date', value: get('SALE DATE') },
          { label: 'Land Sale Amount', value: formatCurrency(get('LAND SALE PRICE')) },
          { label: 'Land Sale Date', value: get('LAND SALE DATE') },
          { label: 'Equity', value: formatCurrency(get('$ EQUITY')) },
          { label: 'Down Payment', value: formatCurrency(get('$ DOWNPAYMENT')) },
          { label: 'Purchase Note', value: formatCurrency(get('$ PURCHASE NOTE')) },
          { label: 'Utility', value: get('UTILITIES') },
          { label: 'Application Fee', value: formatCurrency(get('APPLICATION FEE')) },
          { label: 'Refund Amount', value: formatCurrency(get('REFUND')) },
          { label: 'Monthly Income', value: formatCurrency(get('MONTHLY INCOME')) },
          { label: 'Yearly Income', value: formatCurrency(get('YEARLY INCOME')) },
        ],
      },
    ];
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
      <div className="max-w-7xl mx-auto px-6 py-8 flex flex-col">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">Property Search</h1>
          <p className="text-lg text-gray-600">
            {activeView === 'search' && 'Search current and historical property records across all insider dates'}
            {activeView === 'dashboard' && 'Market insights and activity from the latest upload'}
            {activeView === 'reports' && 'Browse and access saved property reports'}
          </p>
        </div>

        {/* Database Type Selector */}
        <div className="flex justify-center mb-6">
          <div className="inline-flex flex-wrap justify-center rounded-xl bg-white shadow-md p-1 gap-1">
            {DATABASE_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => setDatabaseType(option.value)}
                className={`px-4 py-3 rounded-lg font-semibold transition-all ${
                  databaseType === option.value
                    ? 'bg-blue-600 text-white shadow-md'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {/* View Toggle */}
        <div className="flex gap-4 mb-6">
          <button
            onClick={() => setActiveView('search')}
            className={`flex-1 py-4 px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeView === 'search'
                ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            <Search className="w-5 h-5" />
            Search Database
          </button>
          <button
            onClick={() => setActiveView('dashboard')}
            className={`flex-1 py-4 px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeView === 'dashboard'
                ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            <BarChart3 className="w-5 h-5" />
            Dashboard
          </button>
          <button
            onClick={() => setActiveView('reports')}
            className={`flex-1 py-4 px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeView === 'reports'
                ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-lg'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            <FileText className="w-5 h-5" />
            Saved Reports
          </button>
        </div>

        {/* Recent Insider Activity Stats (dashboard view) */}
        {activeView === 'dashboard' && properties.length > 0 && recentInsiderStats.propertyCount > 0 && (
          <div className="bg-white rounded-2xl shadow-lg p-6 mb-6">
            <div className="flex items-center gap-3 mb-4">
              <BarChart3 className="w-6 h-6 text-indigo-600" />
              <div className="text-left">
                <h3 className="text-lg font-bold text-gray-800">Recent Insider Activity</h3>
                <p className="text-sm text-gray-500">
                  Stats across the last {recentInsiderStats.dates.length} insider date{recentInsiderStats.dates.length !== 1 ? 's' : ''}
                  {recentInsiderStats.dates.length > 0 && ` (${recentInsiderStats.dates[recentInsiderStats.dates.length - 1]} – ${recentInsiderStats.dates[0]})`}
                </p>
              </div>
            </div>

            <div className="space-y-6">
                {/* Stat Tiles */}
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                  <div className="bg-blue-50 rounded-xl p-4">
                    <div className="flex items-center gap-2 text-blue-600 mb-1">
                      <Building2 className="w-4 h-4" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Properties</span>
                    </div>
                    <p className="text-2xl font-bold text-gray-900">{recentInsiderStats.propertyCount.toLocaleString()}</p>
                  </div>
                  <div className="bg-green-50 rounded-xl p-4">
                    <div className="flex items-center gap-2 text-green-600 mb-1">
                      <DollarSign className="w-4 h-4" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Total Volume</span>
                    </div>
                    <p className="text-2xl font-bold text-gray-900">{formatCompactCurrency(recentInsiderStats.totalVolume)}</p>
                  </div>
                  <div className="bg-emerald-50 rounded-xl p-4">
                    <div className="flex items-center gap-2 text-emerald-600 mb-1">
                      <TrendingUp className="w-4 h-4" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Avg Price</span>
                    </div>
                    <p className="text-2xl font-bold text-gray-900">{formatCompactCurrency(recentInsiderStats.avgPrice)}</p>
                  </div>
                  <div className="bg-teal-50 rounded-xl p-4">
                    <div className="flex items-center gap-2 text-teal-600 mb-1">
                      <TrendingUp className="w-4 h-4" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Median Price</span>
                    </div>
                    <p className="text-2xl font-bold text-gray-900">{formatCompactCurrency(recentInsiderStats.medianPrice)}</p>
                  </div>
                  <div className="bg-purple-50 rounded-xl p-4">
                    <div className="flex items-center gap-2 text-purple-600 mb-1">
                      <TrendingUp className="w-4 h-4" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Top Sale</span>
                    </div>
                    <p className="text-2xl font-bold text-gray-900">{formatCompactCurrency(recentInsiderStats.maxPrice)}</p>
                  </div>
                  <div className="bg-amber-50 rounded-xl p-4">
                    <div className="flex items-center gap-2 text-amber-600 mb-1">
                      <Database className="w-4 h-4" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Total Units</span>
                    </div>
                    <p className="text-2xl font-bold text-gray-900">{recentInsiderStats.totalUnits > 0 ? recentInsiderStats.totalUnits.toLocaleString() : '-'}</p>
                  </div>
                </div>

                {/* Breakdowns */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Top Counties */}
                  {recentInsiderStats.topCounties.length > 0 && (
                    <div>
                      <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3 flex items-center gap-2">
                        <MapPin className="w-4 h-4 text-indigo-500" />
                        Top Counties
                      </h4>
                      <div className="space-y-2">
                        {recentInsiderStats.topCounties.map(({ county, count, volume }) => (
                          <div
                            key={county}
                            className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
                            onClick={() => {
                              setActiveView('search');
                              setSelectedCounties([county]);
                            }}
                          >
                            <span className="font-medium text-gray-700">{county}</span>
                            <span className="text-sm text-gray-500">
                              <span className="font-semibold text-indigo-600">{count}</span> propert{count !== 1 ? 'ies' : 'y'}
                              {volume > 0 && <span className="ml-2 text-green-600 font-semibold">{formatCompactCurrency(volume)}</span>}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Top Cities */}
                  {recentInsiderStats.topCities.length > 0 && (
                    <div>
                      <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3 flex items-center gap-2">
                        <Building2 className="w-4 h-4 text-indigo-500" />
                        Top Cities
                      </h4>
                      <div className="space-y-2">
                        {recentInsiderStats.topCities.map(({ city, count }) => (
                          <div
                            key={city}
                            className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
                            onClick={() => {
                              setActiveView('search');
                              setSelectedCity(city);
                            }}
                          >
                            <span className="font-medium text-gray-700">{city}</span>
                            <span className="text-sm text-gray-500">
                              <span className="font-semibold text-indigo-600">{count}</span> propert{count !== 1 ? 'ies' : 'y'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {recentInsiderStats.pricedCount < recentInsiderStats.propertyCount && (
                  <p className="text-xs text-gray-400">
                    Price stats based on {recentInsiderStats.pricedCount.toLocaleString()} of {recentInsiderStats.propertyCount.toLocaleString()} properties with a recorded sale price.
                  </p>
                )}
            </div>
          </div>
        )}

        {/* Stats Cards (reports view) */}
        {activeView === 'reports' && (
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
        )}

        {/* Dashboard empty state */}
        {activeView === 'dashboard' && properties.length === 0 && (
          <div className="bg-white rounded-2xl shadow-lg p-12 text-center text-gray-500 mb-6">
            <Database className="w-12 h-12 mx-auto text-gray-300 mb-3" />
            No data loaded for this database yet.
          </div>
        )}

        {/* Data insight panels (dashboard view) */}
        {activeView === 'dashboard' && (
        <div>
        {/* County and Zip Code Breakdown */}
        {properties.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            {/* County Breakdown */}
            <div className="bg-white rounded-2xl shadow-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <MapPin className="w-6 h-6 text-blue-600" />
                <h3 className="text-lg font-bold text-gray-800">Top Counties</h3>
              </div>
              <div className="space-y-2">
                {(() => {
                  const countyCounts = properties.reduce((acc, p) => {
                    const county = p.county || 'Unknown';
                    acc[county] = (acc[county] || 0) + 1;
                    return acc;
                  }, {} as Record<string, number>);
                  
                  return Object.entries(countyCounts)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 10)
                    .map(([county, count]) => (
                      <div
                        key={county}
                        className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
                        onClick={() => {
                          setActiveView('search');
                          setSelectedCounties([county]);
                        }}
                      >
                        <span className="font-medium text-gray-700">{county}</span>
                        <span className="text-sm font-semibold text-blue-600">{count.toLocaleString()} properties</span>
                      </div>
                    ));
                })()}
              </div>
            </div>

            {/* Zip Code Breakdown */}
            <div className="bg-white rounded-2xl shadow-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <MapPin className="w-6 h-6 text-green-600" />
                <h3 className="text-lg font-bold text-gray-800">Top Zip Codes</h3>
              </div>
              <div className="space-y-2">
                {(() => {
                  const zipCounts = properties.reduce((acc, p) => {
                    const zip = p.zip || 'Unknown';
                    acc[zip] = (acc[zip] || 0) + 1;
                    return acc;
                  }, {} as Record<string, number>);
                  
                  return Object.entries(zipCounts)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 10)
                    .map(([zip, count]) => (
                      <div
                        key={zip}
                        className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
                        onClick={() => {
                          setActiveView('search');
                          setSelectedZipcode(zip === 'Unknown' ? '' : zip);
                        }}
                      >
                        <span className="font-medium text-gray-700">{zip}</span>
                        <span className="text-sm font-semibold text-green-600">{count.toLocaleString()} properties</span>
                      </div>
                    ));
                })()}
              </div>
            </div>
          </div>
        )}

        {/* Latest Insider Dates from Last Upload */}
        {properties.length > 0 && (
          <div className="bg-white rounded-2xl shadow-lg p-6 mb-6">
            <div className="flex items-center gap-3 mb-4">
              <Calendar className="w-6 h-6 text-indigo-600" />
              <div className="text-left">
                <h3 className="text-lg font-bold text-gray-800">Latest Insider Dates</h3>
                {latestUploadName && (
                  <p className="text-sm text-gray-500">From latest upload: <span className="font-medium">{latestUploadName}</span></p>
                )}
              </div>
            </div>
            <div className="space-y-2">
                {(() => {
                  const dateCounts = properties.reduce((acc, p) => {
                    if (p.insiderDate) {
                      acc[p.insiderDate] = (acc[p.insiderDate] || 0) + 1;
                    }
                    return acc;
                  }, {} as Record<string, number>);

                  const startOfToday = new Date();
                  startOfToday.setHours(0, 0, 0, 0);

                  return Object.entries(dateCounts)
                    .filter(([date]) => {
                      const time = new Date(date).getTime();
                      return !isNaN(time) && time < startOfToday.getTime();
                    })
                    .sort(([a], [b]) => new Date(b).getTime() - new Date(a).getTime())
                    .slice(0, 10)
                    .map(([date, count]) => (
                      <div
                        key={date}
                        className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
                        onClick={() => {
                          setActiveView('search');
                          setSelectedDate(date);
                        }}
                      >
                        <span className="font-medium text-gray-700">{date}</span>
                        <span className="text-sm font-semibold text-indigo-600">{count.toLocaleString()} properties</span>
                      </div>
                    ));
                })()}
            </div>
          </div>
        )}

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
                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        <h3 className="text-xl font-bold text-gray-900 group-hover:text-blue-600 transition-colors">
                          {report.report_name}
                        </h3>
                        {report.is_latest === 0 && (
                          <span className="px-2.5 py-0.5 bg-amber-100 text-amber-700 rounded-full text-xs font-semibold">
                            Previous version
                          </span>
                        )}
                      </div>
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
        ) : activeView === 'search' ? (
          <div className="bg-white rounded-2xl shadow-xl p-6">
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-gray-800 mb-2">Property Database Search</h2>
              <p className="text-gray-600">Searching the latest uploaded data with {properties.length.toLocaleString()} properties</p>
            </div>

            {/* AI Natural Language Search */}
            <div className="mb-6 p-4 bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-xl">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="w-5 h-5 text-indigo-600" />
                <h3 className="font-bold text-gray-800">Ask AI</h3>
                <span className="text-xs text-gray-500">e.g. "everything Novare sold", "who owns a lot in Midtown", "sales under $150k per unit"</span>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={aiQuery}
                  onChange={(e) => setAiQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAiSearch()}
                  placeholder="Describe what you're looking for in plain English..."
                  className="flex-1 px-4 py-3 bg-white border border-indigo-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  disabled={aiLoading}
                />
                <button
                  onClick={handleAiSearch}
                  disabled={aiLoading || !aiQuery.trim()}
                  className={`px-6 py-3 rounded-lg font-semibold text-white transition-all flex items-center gap-2 ${
                    aiLoading || !aiQuery.trim()
                      ? 'bg-gray-300 cursor-not-allowed'
                      : 'bg-indigo-600 hover:bg-indigo-700 shadow-md'
                  }`}
                >
                  {aiLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Thinking...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      Search
                    </>
                  )}
                </button>
              </div>
              {aiExplanation && (
                <div className="mt-3 flex items-start gap-2 text-sm text-indigo-800 bg-indigo-100/60 rounded-lg px-3 py-2">
                  <Sparkles className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{aiExplanation}</span>
                </div>
              )}
              {aiError && (
                <div className="mt-3 flex items-start gap-2 text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2">
                  <X className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{aiError}</span>
                </div>
              )}
              {(saleDateAfter || saleDateBefore || insiderDateAfter || insiderDateBefore) && (
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  {(saleDateAfter || saleDateBefore) && (
                    <span className="bg-white border border-indigo-200 text-indigo-700 px-3 py-1 rounded-full font-medium">
                      Sale date: {saleDateAfter || '...'} → {saleDateBefore || 'today'}
                    </span>
                  )}
                  {(insiderDateAfter || insiderDateBefore) && (
                    <span className="bg-white border border-indigo-200 text-indigo-700 px-3 py-1 rounded-full font-medium">
                      Insider date: {insiderDateAfter || '...'} → {insiderDateBefore || 'today'}
                    </span>
                  )}
                </div>
              )}
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

                <div className="relative">
                  <button
                    onClick={() => setCountyDropdownOpen(!countyDropdownOpen)}
                    className={`w-full px-3 py-2 border rounded-lg text-sm text-left flex items-center justify-between gap-2 bg-white ${
                      selectedCounties.length > 0 ? 'border-blue-400 text-blue-700 font-medium' : 'border-gray-300 text-gray-700'
                    }`}
                  >
                    <span className="truncate">
                      {selectedCounties.length === 0
                        ? 'All Counties'
                        : selectedCounties.length === 1
                          ? selectedCounties[0]
                          : `${selectedCounties.length} counties`}
                    </span>
                    <ChevronDown className={`w-4 h-4 flex-shrink-0 transition-transform ${countyDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {countyDropdownOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setCountyDropdownOpen(false)} />
                      <div className="absolute z-20 mt-1 w-full min-w-[220px] max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg p-2">
                        {selectedCounties.length > 0 && (
                          <button
                            onClick={() => setSelectedCounties([])}
                            className="w-full text-left px-2 py-1.5 text-sm text-blue-600 hover:bg-blue-50 rounded font-medium"
                          >
                            Clear selection
                          </button>
                        )}
                        {filters.counties.map(county => (
                          <label
                            key={county}
                            className="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-50 rounded cursor-pointer text-sm"
                          >
                            <input
                              type="checkbox"
                              checked={selectedCounties.includes(county)}
                              onChange={() =>
                                setSelectedCounties(prev =>
                                  prev.includes(county)
                                    ? prev.filter(c => c !== county)
                                    : [...prev, county]
                                )
                              }
                              className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                            />
                            <span className="text-gray-700">{county}</span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </div>

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

            {/* Owner / Seller / Street / Zip Filters */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
              <input
                type="text"
                value={ownerFilter}
                onChange={(e) => setOwnerFilter(e.target.value)}
                placeholder="Owner (buyer) name..."
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              />
              <input
                type="text"
                value={selectedSeller}
                onChange={(e) => setSelectedSeller(e.target.value)}
                placeholder="Seller name..."
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              />
              <input
                type="text"
                value={entityFilter}
                onChange={(e) => setEntityFilter(e.target.value)}
                placeholder="Owner or seller (history)..."
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              />
              <input
                type="text"
                value={streetFilter}
                onChange={(e) => setStreetFilter(e.target.value)}
                placeholder="Street name..."
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              />
              <input
                type="text"
                value={selectedZipcode}
                onChange={(e) => setSelectedZipcode(e.target.value)}
                placeholder="Zip code..."
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
              />
            </div>

            {/* Price, Price/Unit and Units Range */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
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
                  value={minPricePerUnit}
                  onChange={(e) => setMinPricePerUnit(e.target.value)}
                  placeholder="Min $/Unit"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                />
                <span className="text-gray-500">-</span>
                <input
                  type="number"
                  value={maxPricePerUnit}
                  onChange={(e) => setMaxPricePerUnit(e.target.value)}
                  placeholder="Max $/Unit"
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
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setShowTopOwners(!showTopOwners)}
                  className={`text-sm font-medium flex items-center gap-1 ${showTopOwners ? 'text-indigo-700' : 'text-indigo-600 hover:text-indigo-700'}`}
                >
                  <TrendingUp className="w-4 h-4" />
                  {showTopOwners ? 'Hide Top Owners' : 'Top Owners'}
                </button>
                <button
                  onClick={clearPropertyFilters}
                  className="text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1"
                >
                  <X className="w-4 h-4" />
                  Clear Filters
                </button>
              </div>
            </div>

            {/* Top Owners in current results */}
            {showTopOwners && (
              <div className="mb-4 p-4 bg-indigo-50 border border-indigo-200 rounded-xl">
                <h4 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3 flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-indigo-500" />
                  Top Owners in Current Results
                </h4>
                {topOwners.length === 0 ? (
                  <p className="text-sm text-gray-500">No owner information in the current results.</p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {topOwners.map(({ owner, count, volume, units }) => (
                      <div
                        key={owner}
                        className="flex items-center justify-between py-2 px-3 bg-white rounded-lg hover:bg-indigo-100 transition-colors cursor-pointer"
                        onClick={() => setEntityFilter(owner)}
                        title="Click to view all properties associated with this owner"
                      >
                        <span className="font-medium text-gray-700 truncate mr-4">{owner}</span>
                        <span className="text-sm text-gray-500 flex-shrink-0">
                          <span className="font-semibold text-indigo-600">{count}</span> propert{count !== 1 ? 'ies' : 'y'}
                          {units > 0 && <span className="ml-2 text-gray-600">{units.toLocaleString()} units</span>}
                          {volume > 0 && <span className="ml-2 text-green-600 font-semibold">{formatCompactCurrency(volume)}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

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
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">$ / Unit</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Date</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">Last Insider Date</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {filteredProperties.map((property, idx) => (
                    <>
                      <tr key={idx} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelectedProperty(property)}>
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">{property.propertyName}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{property.city}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{property.county}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{formatUnits(property.units)}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{formatCurrency(property.salePrice)}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{formatCurrency(property.pricePerUnit)}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{property.insiderDate}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{property.lastInsiderDate}</td>
                        <td className="px-4 py-3 text-sm" onClick={(e) => { e.stopPropagation(); setExpandedRow(expandedRow === idx ? null : idx); }}>
                          {expandedRow === idx ? (
                            <ChevronUp className="w-5 h-5 text-gray-400" />
                          ) : (
                            <ChevronDown className="w-5 h-5 text-gray-400" />
                          )}
                        </td>
                      </tr>
                      {expandedRow === idx && (
                        <tr>
                          <td colSpan={9} className="px-4 py-4 bg-gray-50">
                            <div className="grid grid-cols-2 gap-4 text-sm">
                              <div><span className="font-semibold">Address:</span> {property.address}</div>
                              <div><span className="font-semibold">Zip:</span> {property.zip}</div>
                              <div><span className="font-semibold">Market Area:</span> {property.marketArea}</div>
                              <div><span className="font-semibold">District:</span> {property.district}</div>
                              <div><span className="font-semibold">Parcel:</span> {property.parcel}</div>
                              <div><span className="font-semibold">Tax Owner:</span> {property.taxOwner}</div>
                              <div>
                                <span className="font-semibold">Owner (Buyer):</span>{' '}
                                {property.owner ? (
                                  <button
                                    className="text-indigo-600 hover:text-indigo-800 hover:underline"
                                    title="View all properties associated with this owner"
                                    onClick={(e) => { e.stopPropagation(); setEntityFilter(property.owner); }}
                                  >
                                    {property.owner}
                                  </button>
                                ) : '—'}
                              </div>
                              <div>
                                <span className="font-semibold">Seller:</span>{' '}
                                {property.seller ? (
                                  <button
                                    className="text-indigo-600 hover:text-indigo-800 hover:underline"
                                    title="View all properties associated with this seller"
                                    onClick={(e) => { e.stopPropagation(); setEntityFilter(property.seller); }}
                                  >
                                    {property.seller}
                                  </button>
                                ) : '—'}
                              </div>
                              <div><span className="font-semibold">Price / Unit:</span> {formatCurrency(property.pricePerUnit) || '—'}</div>
                              <div><span className="font-semibold">Loan Amount:</span> {formatCurrency(property.loanAmount) || '—'}</div>
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
        ) : null}

        {/* Full Property Report Modal */}
        {selectedProperty && (
          <div
            className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
            onClick={() => setSelectedProperty(null)}
          >
            <div
              className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div className="sticky top-0 bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-8 py-6 rounded-t-2xl flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold">{selectedProperty.propertyName}</h2>
                  <p className="text-blue-100 text-sm mt-1">Full Property Report</p>
                </div>
                <button
                  onClick={() => setSelectedProperty(null)}
                  className="p-2 hover:bg-white/20 rounded-lg transition-colors"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* Report Sections */}
              <div className="p-8 space-y-8">
                {buildReportSections(selectedProperty).map((section) => (
                  <div key={section.title}>
                    <h3 className="text-lg font-bold text-gray-800 border-b-2 border-blue-600 pb-2 mb-4">
                      {section.title}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2">
                      {section.fields.map((field) => (
                        <div key={field.label} className="flex justify-between py-1.5 border-b border-gray-100 text-sm">
                          <span className="font-semibold text-gray-600">{field.label}</span>
                          <span className="text-gray-900 text-right ml-4">{field.value || '—'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                {/* Comments */}
                {getFullComments(selectedProperty) && (
                  <div>
                    <h3 className="text-lg font-bold text-gray-800 border-b-2 border-blue-600 pb-2 mb-4">
                      Comments
                    </h3>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{getFullComments(selectedProperty)}</p>
                  </div>
                )}
              </div>
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
