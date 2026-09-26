import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { FileText, Eye, Calendar, Search, Loader2, TrendingUp, Database, ChevronDown, ChevronUp, X, DollarSign, MapPin, Building2, BarChart3, Sparkles, History, SlidersHorizontal, Download, Clock, FileDown } from 'lucide-react';
import { formatExcelDate } from './utils/excelDate';
import PropertyHistory from './PropertyHistory';
import { AskCatalogue, HistoryResults, type HistoryAnswer } from './AskAI';
import { openFeedback } from './utils/feedback';
import { titleCase, primaryName, aliasNames, cleanNumber, fmtAcres } from './utils/fmt';
import { downloadReportPdf } from './utils/reportPdf';
import { trackUsage } from './utils/usage';

const PAGE_SIZE = 100;
// Re-filtering 2,600 rows on every keystroke made typing lag; filter on the settled value instead.
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type SortKey = 'propertyName' | 'city' | 'county' | 'units' | 'salePrice' | 'pricePerUnit' | 'acres' | 'saleDate' | 'insiderDate';
const NUMERIC_SORT: SortKey[] = ['units', 'salePrice', 'pricePerUnit', 'acres'];
const DATE_SORT: SortKey[] = ['saleDate', 'insiderDate'];

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

// Archive (Dropbox) file type per database — the key the property-history API uses.
const ARCHIVE_TYPE: Record<string, string> = { apartments: 'APTS', franchise: 'FRANCHIS', industrial: 'IND', land: 'LANDSALE', offices: 'OFFSHOP', retail: 'OFFSHOP' };

// Retail merges in the Franchise file and every row lookup happens on the server (backend/src/search).

const DATABASE_OPTIONS = [
  { value: 'apartments', label: '🏢 Apartments' },
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

// What the server sends about a database (no rows): see backend/src/search/routes.ts.
type InsiderStats = {
  dates: string[]; propertyCount: number; pricedCount: number; totalVolume: number; avgPrice: number; medianPrice: number;
  maxPrice: number; totalUnits: number; topCounties: { county: string; count: number; volume: number }[]; topCities: { city: string; count: number }[];
};
type Tally = [string, number][];
interface SearchMeta {
  total: number;
  headers: string[];
  latestUploadName: string;
  filters?: Filters;
  insider?: InsiderStats;
  newThisWeek?: { date: string; count: number } | null;
  tallies?: { county: Tally; zip: Tally; insiderDate: Tally; countyNamed: Tally; zipNamed: Tally; city: Tally };
}
type OwnerRow = { owner: string; count: number; volume: number; units: number };
type ResultStats = { volume: number; unitTotal: number; median: number; biggest: Property | null };
const EMPTY_INSIDER: InsiderStats = { dates: [], propertyCount: 0, pricedCount: 0, totalVolume: 0, avgPrice: 0, medianPrice: 0, maxPrice: 0, totalUnits: 0, topCounties: [], topCities: [] };
const EMPTY_STATS: ResultStats = { volume: 0, unitTotal: 0, median: 0, biggest: null };

interface Filters {
  cities: string[];
  counties: string[];
  marketAreas: string[];
  dates: string[];
  priceRange: { min: number; max: number };
  unitsRange: { min: number; max: number };
}

function UserDashboard({ onOpenProperty, initialQuery }: { onOpenProperty: (type: string, id: string) => void; initialQuery?: string }) {
  const [activeView, setActiveView] = useState<'search' | 'history' | 'dashboard' | 'reports'>('search');
  const [databaseType, setDatabaseType] = useState('apartments');
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [filteredReports, setFilteredReports] = useState<SavedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchText, setSearchText] = useState('');
  
  // Property search states
  // The server holds the rows; the browser gets a summary of the database and one page of results.
  const [meta, setMeta] = useState<SearchMeta | null>(null);
  const [filteredProperties, setFilteredProperties] = useState<Property[]>([]);
  const [resultTotal, setResultTotal] = useState(0);
  const [browseMax, setBrowseMax] = useState(1000);
  const [resultStats, setResultStats] = useState<ResultStats>(EMPTY_STATS);
  const [topOwners, setTopOwners] = useState<OwnerRow[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const searchSeq = useRef(0);
  const [partialMatch, setPartialMatch] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);
  const [filters, setFilters] = useState<Filters | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [visibleRows, setVisibleRows] = useState(PAGE_SIZE);
  const [exporting, setExporting] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);
  const [propertySearchText, setPropertySearchText] = useState('');
  const searchQuery = useDebounced(propertySearchText, 250);
  const settledQuery = useDebounced(searchQuery, 1500);
  const resultCount = useRef(0);
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
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyDb, setHistoryDb] = useState<string | null>(null);
  const [reportBusy, setReportBusy] = useState<'report' | 'pdf' | null>(null);

  // AI natural language search states
  const [aiQuery, setAiQuery] = useState(initialQuery ?? '');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);
  const [aiHistory, setAiHistory] = useState<HistoryAnswer | null>(null);
  const [aiAsked, setAiAsked] = useState('');
  const [browseWithAnswer, setBrowseWithAnswer] = useState(false);
  // Ask AI filters on columns that have no dedicated control: contains-text and numeric ranges by header
  const [aiFields, setAiFields] = useState<Record<string, string>>({});
  const [aiRanges, setAiRanges] = useState<Record<string, { min?: number; max?: number }>>({});
  const [saleDateAfter, setSaleDateAfter] = useState('');
  const [saleDateBefore, setSaleDateBefore] = useState('');
  const [insiderDateAfter, setInsiderDateAfter] = useState('');
  const [insiderDateBefore, setInsiderDateBefore] = useState('');

  const totalProperties = meta?.total ?? 0;
  const excelHeaders = meta?.headers ?? [];
  // Stats over the properties belonging to the 10 most recent insider dates (before today) — from the server.
  const recentInsiderStats = meta?.insider ?? EMPTY_INSIDER;

  // Top owners over sales in the most recent 3 years (within the current search filters) come with each search.

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
    if (settledQuery.trim().length >= 3) trackUsage('search', { database_type: databaseType, detail: settledQuery.trim(), rows: resultCount.current });
  }, [settledQuery]);

  useEffect(() => {
    trackUsage('page_view', { database_type: databaseType, detail: activeView });
  }, [activeView, databaseType]);

  useEffect(() => {
    applyPropertyFilters();
    setVisibleRows(PAGE_SIZE);
    setExpandedRow(null);
  }, [sort, searchQuery, selectedCity, selectedCounties, selectedMarketArea, selectedZipcode, selectedDistrict, selectedLandLot, selectedSeller, ownerFilter, entityFilter, streetFilter, selectedDate, minPrice, maxPrice, minLandPrice, maxLandPrice, minPricePerUnit, maxPricePerUnit, minUnits, maxUnits, minAcres, maxAcres, minYearBuilt, maxYearBuilt, saleDateAfter, saleDateBefore, insiderDateAfter, insiderDateBefore, landSaleDateAfter, landSaleDateBefore, aiFields, aiRanges, meta]);

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
      setMeta(null);
      setFilteredProperties([]);
      setResultTotal(0);
      setFilters(null);
      setLatestUploadName('');
      const { data } = await axios.get<SearchMeta>(`${API_URL}/api/search/${databaseType}/meta`);
      if (!data.total) return;
      setLatestUploadName(data.latestUploadName);
      if (data.filters) setFilters(data.filters);
      setMeta(data);
    } catch (err) {
      console.error('Error loading latest upload:', err);
    }
  };

  // Everything the server needs to run the current search (names match backend SearchParams).
  const searchParams = () => ({
    searchQuery, selectedCity, selectedCounties, selectedMarketArea, selectedZipcode, selectedDistrict, selectedLandLot,
    streetFilter, selectedDate, ownerFilter, selectedSeller, entityFilter, minPrice, maxPrice, minPricePerUnit, maxPricePerUnit,
    minLandPrice, maxLandPrice, minUnits, maxUnits, minAcres, maxAcres, minYearBuilt, maxYearBuilt, saleDateAfter, saleDateBefore,
    insiderDateAfter, insiderDateBefore, landSaleDateAfter, landSaleDateBefore, aiFields, aiRanges, sort,
  });

  const applyPropertyFilters = async () => {
    if (!meta) return;
    const seq = ++searchSeq.current;
    try {
      const { data } = await axios.post(`${API_URL}/api/search/${databaseType}`, { params: searchParams(), offset: 0, limit: PAGE_SIZE });
      if (seq !== searchSeq.current) return; // a newer search already answered
      resultCount.current = data.total;
      setResultTotal(data.total);
      setBrowseMax(data.browseMax ?? 1000);
      setPartialMatch(Boolean(data.partial));
      setResultStats(data.stats ?? EMPTY_STATS);
      setTopOwners(data.topOwners ?? []);
      setFilteredProperties(data.rows ?? []);
    } catch (err) {
      if (seq === searchSeq.current) console.error('Search failed:', err);
    }
  };

  // "Show more" asks the server for the next page of the same search.
  const loadMoreRows = async () => {
    if (loadingMore || !meta) return;
    const seq = searchSeq.current;
    setLoadingMore(true);
    try {
      const { data } = await axios.post(`${API_URL}/api/search/${databaseType}`, { params: searchParams(), offset: filteredProperties.length, limit: PAGE_SIZE });
      if (seq === searchSeq.current) setFilteredProperties((rows) => [...rows, ...(data.rows ?? [])]);
    } catch (err) {
      console.error('Loading more results failed:', err);
    } finally {
      setLoadingMore(false);
    }
  };
  useEffect(() => {
    if (visibleRows > filteredProperties.length && filteredProperties.length < Math.min(resultTotal, browseMax)) loadMoreRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRows, filteredProperties.length, resultTotal]);


  const toggleSort = (key: SortKey) =>
    setSort(s => (s?.key === key ? (s.dir === 'desc' ? { key, dir: 'asc' } : null) : { key, dir: NUMERIC_SORT.includes(key) || DATE_SORT.includes(key) ? 'desc' : 'asc' }));

  const sortMark = (key: SortKey) => (sort?.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  // Stat cards above the results table (total volume, size, median $/unit, largest sale) come with each search.

  const activeFilterCount = [
    selectedCity, selectedMarketArea, selectedZipcode, selectedDistrict, selectedLandLot, selectedSeller,
    ownerFilter, entityFilter, streetFilter, selectedDate, minPrice, maxPrice, minLandPrice, maxLandPrice,
    minPricePerUnit, maxPricePerUnit, minUnits, maxUnits, minAcres, maxAcres, minYearBuilt, maxYearBuilt,
    saleDateAfter, saleDateBefore, insiderDateAfter, insiderDateBefore, landSaleDateAfter, landSaleDateBefore,
  ].filter(Boolean).length + selectedCounties.length + Object.keys(aiFields).length + Object.keys(aiRanges).length;

  const exportExcel = async () => {
    if (exporting || resultTotal === 0) return;
    setExporting(true);
    try {
      const columns = [
        { key: 'propertyName', label: 'Property' },
        { key: 'formerNames', label: 'Former names' },
        { key: 'address', label: 'Address' },
        { key: 'city', label: 'City' },
        { key: 'county', label: 'County' },
        { key: 'zip', label: 'ZIP' },
        { key: 'marketArea', label: 'Market Area' },
        { key: 'units', label: unitLabel },
        { key: 'yearBuilt', label: 'Year Built' },
        { key: 'acres', label: 'Acres' },
        { key: 'salePrice', label: 'Sale Price' },
        { key: 'pricePerUnit', label: perUnitLabel },
        { key: 'saleDate', label: 'Sale Date' },
        { key: 'owner', label: 'Owner / Buyer' },
        { key: 'seller', label: 'Seller' },
        { key: 'loanAmount', label: 'Loan' },
        { key: 'parcel', label: 'Parcel' },
        { key: 'insiderDate', label: 'Insider Date' },
        { key: 'lastInsiderDate', label: 'Previous Insider Date' },
        { key: 'comments', label: 'Comments' },
      ];
      const { data: exp } = await axios.post(`${API_URL}/api/search/${databaseType}/export`, { params: searchParams() });
      if (exp.capped) alert(`This search has ${exp.total.toLocaleString()} results; the export includes the first ${exp.max.toLocaleString()}. Narrow the search to export the rest.`);
      const rows = (exp.rows as Property[]).map((p) => ({
        propertyName: primaryName(p.propertyName),
        formerNames: aliasNames(p.propertyName).replace(/^formerly /, ''),
        address: titleCase(p.address),
        city: titleCase(p.city),
        county: titleCase(p.county),
        zip: p.zip,
        marketArea: p.marketArea,
        units: p.units,
        yearBuilt: p.yearBuilt,
        acres: cleanNumber(p.acres) === null ? '' : Math.round(cleanNumber(p.acres)! * 100) / 100,
        salePrice: p.salePrice,
        pricePerUnit: p.pricePerUnit,
        saleDate: p.saleDate,
        owner: p.owner,
        seller: p.seller,
        loanAmount: p.loanAmount,
        parcel: p.parcel,
        insiderDate: p.insiderDate,
        lastInsiderDate: p.lastInsiderDate,
        comments: getFullComments(p),
      }));
      const filename = `databank-${databaseType}-${new Date().toISOString().slice(0, 10)}`;
      const res = await axios.post(`${API_URL}/api/export/xlsx`, { columns, rows, filename }, { responseType: 'blob', withCredentials: true });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filename}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
      alert('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  const newThisWeek = meta?.newThisWeek ?? null;

  // The row card is this week's record; the one-page report lives on the archive property.
  // Find it by parcel, then by name/address, and take the single best match.
  // A merged row (Franchise inside Retail) keeps its own archive file.
  const archiveDbOf = (p: Property) => (p.sourceFile ? String(p.sourceFile).toLowerCase() : databaseType);

  const findArchiveProperty = async (p: Property): Promise<{ type: string; id: string } | null> => {
    const type = ARCHIVE_TYPE[archiveDbOf(p)];
    if (!type) return null;
    const queries = [String(p.parcel || '').trim(), primaryName(p.propertyName), String(p.address || '').trim()].filter(Boolean);
    // Keep the best ambiguous match as a fallback, but only fall back to it after trying every
    // query. A name search for a chain (e.g. "McDonald's") can match dozens of records — this
    // used to give up on that first ambiguous result and return the same one for every location
    // in the chain, without ever trying the address (tried last, and far more specific) first.
    let fallback: { type: string; id: string } | null = null;
    for (const q of queries) {
      const res = await axios.get<{ total: number; items: { id: string; name: string }[] }>(`${API_URL}/api/dropbox/properties`, { params: { type, q, page: 0 } });
      const items = res.data.items || [];
      if (items.length === 1) return { type, id: items[0].id };
      const exact = items.find((i) => i.name.toUpperCase() === String(p.propertyName || '').toUpperCase());
      if (exact) return { type, id: exact.id };
      if (items.length > 1) fallback = { type, id: items[0].id };
    }
    return fallback;
  };

  const openReportFor = async (p: Property, mode: 'report' | 'pdf') => {
    if (reportBusy) return;
    setReportBusy(mode);
    try {
      const found = await findArchiveProperty(p);
      if (!found) { alert('This property is not in the history archive yet, so there is no report for it.'); return; }
      if (mode === 'report') onOpenProperty(found.type, found.id);
      else await downloadReportPdf(found.type, found.id, primaryName(p.propertyName));
    } catch (e) {
      console.error('Report failed:', e);
      alert('Could not open the report. Please try again.');
    } finally {
      setReportBusy(null);
    }
  };

  const showHistoryFor = (p: Property) => {
    setHistoryQuery(primaryName(p.propertyName) || p.address);
    setHistoryDb(archiveDbOf(p));
    setActiveView('history');
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
    setAiFields({});
    setAiRanges({});
    setAiHistory(null);
    setAiExplanation(null);
    setAiError(null);
  };

  // Dashboard rows open Search Database on just that slice: every other filter (and any
  // Ask AI answer hiding the list) is cleared first so the rows actually show.
  const drillDown = (apply: () => void) => {
    clearPropertyFilters();
    setBrowseWithAnswer(false);
    apply();
    setActiveView('search');
  };
  const recentSince = recentInsiderStats.dates[recentInsiderStats.dates.length - 1] || '';

  const downloadSnapshot = async () => {
    if (snapshotting) return;
    setSnapshotting(true);
    try {
      const label = (DATABASE_OPTIONS.find((o) => o.value === databaseType)?.label || databaseType).replace(/^[^A-Za-z]+/, '');
      const rs = recentInsiderStats;
      const count = (n: number) => `${n.toLocaleString()} propert${n !== 1 ? 'ies' : 'y'}`;
      const tally = (key: 'countyNamed' | 'zipNamed' | 'city') =>
        (meta?.tallies?.[key] ?? []).slice(0, 10).map(([label, n]) => ({ label, value: count(n) }));
      const snapshot = {
        database: label,
        scope: 'Market snapshot',
        period: rs.dates.length ? `Recent Insider activity: ${rs.dates.length} Insider dates, ${recentSince} – ${rs.dates[0]}` : '',
        source: latestUploadName ? `Databank Atlanta weekly research file ${latestUploadName}` : '',
        tiles: [
          { label: 'Properties (recent)', value: rs.propertyCount.toLocaleString() },
          { label: 'Total volume', value: formatCompactCurrency(rs.totalVolume) },
          { label: 'Average price', value: formatCompactCurrency(rs.avgPrice) },
          { label: 'Median price', value: formatCompactCurrency(rs.medianPrice) },
          { label: 'Top sale', value: formatCompactCurrency(rs.maxPrice) },
          { label: `Total ${unitLabel}`, value: rs.totalUnits > 0 ? rs.totalUnits.toLocaleString() : '—' },
        ],
        sections: [
          { title: 'Recent activity by county', rows: rs.topCounties.map((c) => ({ label: c.county, value: count(c.count), extra: c.volume > 0 ? formatCompactCurrency(c.volume) : undefined })) },
          { title: 'Recent activity by city', rows: rs.topCities.map((c) => ({ label: c.city, value: count(c.count) })) },
          { title: 'Top owners, sales in the last 3 years', note: resultTotal !== totalProperties ? 'Within the current search filters' : undefined, rows: topOwners.slice(0, 10).map((o) => ({ label: o.owner, value: count(o.count), extra: o.volume > 0 ? formatCompactCurrency(o.volume) : undefined })) },
          { title: `All ${totalProperties.toLocaleString()} properties by county`, rows: tally('countyNamed') },
          { title: 'By zip code', rows: tally('zipNamed') },
          { title: 'By city', rows: tally('city') },
        ],
      };
      const res = await axios.post(`${API_URL}/api/market-snapshot.pdf`, snapshot, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `databank-${databaseType}-snapshot.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Snapshot PDF failed:', e);
      alert('Could not build the PDF. Please try again.');
    } finally {
      setSnapshotting(false);
    }
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

      if (response.data.history) {
        // Cross-week question: answered from the Dropbox archive; drop any filters left by an earlier question
        clearPropertyFilters();
        setAiHistory(response.data.history as HistoryAnswer);
        setAiAsked(aiQuery.trim());
        setBrowseWithAnswer(false);
        setAiExplanation(f.explanation || 'Answered from the archive of weekly files.');
        setActiveView('search');
        return;
      }
      setAiHistory(null);

      // The AI may return a single value or an array; take the first entry either way
      const one = (v: any) => (v == null ? '' : String(Array.isArray(v) ? v[0] ?? '' : v));

      // Reset previous filters, then apply the AI-derived ones
      setPropertySearchText(one(f.search_text));
      setSelectedCity(one(f.city));
      setSelectedCounties(Array.isArray(f.counties) ? f.counties.map(String) : f.county ? [String(f.county)] : []);
      setSelectedMarketArea(one(f.market_area));
      setSelectedZipcode(Array.isArray(f.zipcode) ? f.zipcode.map(String).join(', ') : one(f.zipcode));
      setSelectedDistrict(one(f.district));
      setSelectedLandLot(one(f.land_lot));
      setSelectedSeller(one(f.seller));
      setOwnerFilter(one(f.owner));
      setEntityFilter(one(f.entity));
      setStreetFilter(one(f.street));
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
      setAiFields(f.fields && typeof f.fields === 'object' ? f.fields : {});
      setAiRanges(f.ranges && typeof f.ranges === 'object' ? f.ranges : {});
      setAiExplanation(f.explanation || 'Filters applied.');
      // "Who owns..." questions land on the dashboard's Top Owners panel
      setActiveView(f.show_top_owners ? 'dashboard' : 'search');
    } catch (err: any) {
      console.error('AI search error:', err);
      setAiError(err.response?.data?.error || 'AI search failed. Please try again.');
    } finally {
      setAiLoading(false);
    }
  };

  // Arriving from the homepage's hero search box with a query already typed — run it once,
  // rather than making the person retype or re-click Search.
  const ranInitialQuery = useRef(false);
  useEffect(() => {
    if (initialQuery && !ranInitialQuery.current) {
      ranInitialQuery.current = true;
      handleAiSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getReportValue = (property: Property, colName: string) => {
    const idx = excelHeaders.findIndex((h: string) => h && h.trim() === colName);
    if (idx === -1) return '';
    const value = property.raw?.[idx];
    if (value === undefined || value === null || value === '') return '';
    if (colName.toUpperCase().includes('DATE')) return formatExcelDate(value);
    return String(value).trim();
  };

  // Only apartments are sized by unit count. Every other Reflex file (industrial, office/retail,
  // franchise, land) has no units column, so "units" there is # SQ FT BUILT and $/unit is $/SF.
  const bySqFt = databaseType !== 'apartments';
  const unitLabel = bySqFt ? 'Sq Ft' : 'Units';
  const perUnitLabel = bySqFt ? '$ / SF' : '$ / Unit';
  // Land parcels have no units or price per unit, so the table omits those columns
  const isLand = databaseType === 'land';
  const tableColumns = ([
    ['propertyName', 'Property'],
    ['city', 'City'],
    ['county', 'County'],
    ...(isLand ? [] : [['units', unitLabel]]),
    ['salePrice', 'Price'],
    ...(isLand ? [['acres', 'Acres']] : [['pricePerUnit', perUnitLabel]]),
    ['saleDate', 'Sale Date'],
    ['insiderDate', 'Insider Date'],
  ] as [SortKey, string][]);

  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('databank_hidden_cols') || '[]')); } catch { return new Set(); }
  });
  const [colPickerOpen, setColPickerOpen] = useState(false);
  const toggleCol = (key: string) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      try { localStorage.setItem('databank_hidden_cols', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };
  const colVisible = (key: string) => !hiddenCols.has(key);

  type SavedSearch = {
    id: string; name: string; query: string; databaseType: string;
    // A reasonable, not-exhaustive snapshot of filter state — the AI query and quick-find text
    // cover most real searches; the rest are the filters people set by hand most often.
    propertySearchText: string; selectedCity: string; selectedCounties: string[]; selectedMarketArea: string;
    selectedZipcode: string; minPrice: string; maxPrice: string; minUnits: string; maxUnits: string; selectedDate: string;
  };
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(() => {
    try { return JSON.parse(localStorage.getItem('databank_saved_searches') || '[]'); } catch { return []; }
  });
  const [savedSearchOpen, setSavedSearchOpen] = useState(false);
  const persistSavedSearches = (list: SavedSearch[]) => {
    setSavedSearches(list);
    try { localStorage.setItem('databank_saved_searches', JSON.stringify(list)); } catch { /* ignore */ }
  };
  const saveCurrentSearch = () => {
    const name = window.prompt('Name this search', aiQuery || propertySearchText || `${databaseType} search`);
    if (!name) return;
    const s: SavedSearch = {
      id: `${Date.now()}`, name, query: aiQuery, databaseType,
      propertySearchText, selectedCity, selectedCounties, selectedMarketArea, selectedZipcode,
      minPrice, maxPrice, minUnits, maxUnits, selectedDate,
    };
    persistSavedSearches([s, ...savedSearches].slice(0, 20));
  };
  const applySavedSearch = (s: SavedSearch) => {
    setSavedSearchOpen(false);
    setDatabaseType(s.databaseType);
    setPropertySearchText(s.propertySearchText);
    setSelectedCity(s.selectedCity);
    setSelectedCounties(s.selectedCounties);
    setSelectedMarketArea(s.selectedMarketArea);
    setSelectedZipcode(s.selectedZipcode);
    setMinPrice(s.minPrice);
    setMaxPrice(s.maxPrice);
    setMinUnits(s.minUnits);
    setMaxUnits(s.maxUnits);
    setSelectedDate(s.selectedDate);
    setActiveView('search');
    if (s.query) { setAiQuery(s.query); setTimeout(() => handleAiSearch(), 0); }
  };
  const deleteSavedSearch = (id: string) => {
    persistSavedSearches(savedSearches.filter((s) => s.id !== id));
  };

  const formatCurrency = (value: string) => {
    if (!value) return '';
    const num = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
    if (isNaN(num) || num === 0) return '';
    return `$${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  };

  // Price-per-unit values keep cents for industrial ($/SF is usually < $1,000)
  const formatPerUnit = (value: string) => {
    if (!value) return '';
    const num = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
    if (isNaN(num) || num === 0) return '';
    return `$${num.toLocaleString('en-US', { maximumFractionDigits: bySqFt ? 2 : 0 })}`;
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
    <div className="font-sans text-db-text">
      <div className="flex flex-col">
        {/* Database Type Selector */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div className="inline-flex flex-wrap justify-center rounded-xl bg-white border border-db-border p-1 gap-1">
            {DATABASE_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => { setDatabaseType(option.value); setHistoryDb(null); }}
                className={`px-4 py-3 rounded-lg font-semibold transition-all ${
                  databaseType === option.value
                    ? 'bg-db-navy text-white'
                    : 'text-db-subtle hover:text-db-ink'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {newThisWeek && (
            <button
              onClick={() => { setActiveView('search'); clearPropertyFilters(); setSelectedDate(newThisWeek.date); }}
              title="Show only the properties in the latest Insider Report"
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-white border border-db-border text-sm text-db-subtle hover:bg-db-cream"
            >
              <span className="w-2 h-2 rounded-full bg-db-green" />
              <span className="font-semibold text-db-ink num">{newThisWeek.count.toLocaleString()} new</span> in the {newThisWeek.date} Insider Report
            </button>
          )}
        </div>

        {/* View Toggle */}
        <div className="flex flex-wrap gap-3 mb-5">
          <button
            onClick={() => setActiveView('search')}
            className={`flex-1 basis-[calc(50%-0.375rem)] sm:basis-0 py-3 sm:py-4 px-4 sm:px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeView === 'search'
                ? 'bg-db-navy text-white'
                : 'bg-white border border-db-border text-db-subtle hover:bg-db-cream'
            }`}
          >
            <Search className="w-5 h-5" />
            Search Database
          </button>
          <button
            onClick={() => { setHistoryDb(null); setActiveView('history'); }}
            className={`flex-1 basis-[calc(50%-0.375rem)] sm:basis-0 py-3 sm:py-4 px-4 sm:px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeView === 'history'
                ? 'bg-db-navy text-white'
                : 'bg-white border border-db-border text-db-subtle hover:bg-db-cream'
            }`}
          >
            <History className="w-5 h-5" />
            Property History
          </button>
          <button
            onClick={() => setActiveView('dashboard')}
            className={`flex-1 basis-[calc(50%-0.375rem)] sm:basis-0 py-3 sm:py-4 px-4 sm:px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeView === 'dashboard'
                ? 'bg-db-navy text-white'
                : 'bg-white border border-db-border text-db-subtle hover:bg-db-cream'
            }`}
          >
            <BarChart3 className="w-5 h-5" />
            Dashboard
          </button>
          <button
            onClick={() => setActiveView('reports')}
            className={`flex-1 basis-[calc(50%-0.375rem)] sm:basis-0 py-3 sm:py-4 px-4 sm:px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
              activeView === 'reports'
                ? 'bg-db-navy text-white'
                : 'bg-white border border-db-border text-db-subtle hover:bg-db-cream'
            }`}
          >
            <FileText className="w-5 h-5" />
            Weekly Reports
          </button>
        </div>

        {/* Recent Insider Activity Stats (dashboard view) */}
        {activeView === 'dashboard' && totalProperties > 0 && recentInsiderStats.propertyCount > 0 && (
          <div className="bg-white rounded-2xl shadow-lg p-6 mb-6">
            <div className="flex items-center gap-3 mb-4">
              <BarChart3 className="w-6 h-6 text-db-navy" />
              <div className="text-left">
                <h3 className="text-lg font-bold text-gray-800">Recent Insider Activity</h3>
                <p className="text-sm text-gray-500">
                  Stats across the last {recentInsiderStats.dates.length} insider date{recentInsiderStats.dates.length !== 1 ? 's' : ''}
                  {recentInsiderStats.dates.length > 0 && ` (${recentInsiderStats.dates[recentInsiderStats.dates.length - 1]} – ${recentInsiderStats.dates[0]})`}
                  {' · click a county or city to see those properties'}
                </p>
              </div>
              <button
                onClick={downloadSnapshot}
                disabled={snapshotting}
                className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-db-navy text-white text-sm hover:bg-db-navyLight disabled:opacity-50"
                title="One-page PDF of these numbers"
              >
                {snapshotting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />} Download PDF
              </button>
            </div>

            <div className="space-y-6">
                {/* Stat Tiles */}
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                  <div className="bg-db-tint rounded-xl p-4">
                    <div className="flex items-center gap-2 text-db-navy mb-1">
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
                  <div className="bg-db-tint rounded-xl p-4">
                    <div className="flex items-center gap-2 text-db-gold mb-1">
                      <TrendingUp className="w-4 h-4" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Top Sale</span>
                    </div>
                    <p className="text-2xl font-bold text-gray-900">{formatCompactCurrency(recentInsiderStats.maxPrice)}</p>
                  </div>
                  <div className="bg-amber-50 rounded-xl p-4">
                    <div className="flex items-center gap-2 text-amber-600 mb-1">
                      <Database className="w-4 h-4" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Total {unitLabel}</span>
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
                        <MapPin className="w-4 h-4 text-db-navy" />
                        Top Counties
                      </h4>
                      <div className="space-y-2">
                        {recentInsiderStats.topCounties.map(({ county, count, volume }) => (
                          <div
                            key={county}
                            className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
                            onClick={() => drillDown(() => { setSelectedCounties([county]); setInsiderDateAfter(recentSince); })}
                          >
                            <span className="font-medium text-gray-700">{county}</span>
                            <span className="text-sm text-gray-500">
                              <span className="font-semibold text-db-navy">{count}</span> propert{count !== 1 ? 'ies' : 'y'}
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
                        <Building2 className="w-4 h-4 text-db-navy" />
                        Top Cities
                      </h4>
                      <div className="space-y-2">
                        {recentInsiderStats.topCities.map(({ city, count }) => (
                          <div
                            key={city}
                            className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
                            onClick={() => drillDown(() => { setSelectedCity(city); setInsiderDateAfter(recentSince); })}
                          >
                            <span className="font-medium text-gray-700">{city}</span>
                            <span className="text-sm text-gray-500">
                              <span className="font-semibold text-db-navy">{count}</span> propert{count !== 1 ? 'ies' : 'y'}
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
          <p className="text-sm text-gray-600 mb-6">
            The Insider Reports Databank publishes each week — the transactions its analysts verified and released. Open one to read it or download the PDF.
          </p>
        )}

        {/* Dashboard empty state */}
        {activeView === 'dashboard' && totalProperties === 0 && (
          <div className="bg-white rounded-2xl shadow-lg p-12 text-center text-gray-500 mb-6">
            <Database className="w-12 h-12 mx-auto text-gray-300 mb-3" />
            No data loaded for this database yet.
          </div>
        )}

        {/* Data insight panels (dashboard view) */}
        {activeView === 'dashboard' && (
        <div>
        {/* Top Owners (last 3 years) */}
        {totalProperties > 0 && (
          <div className="bg-white rounded-2xl shadow-lg p-6 mb-6">
            <div className="flex items-center gap-3 mb-4">
              <Building2 className="w-6 h-6 text-db-navy" />
              <div>
                <h3 className="text-lg font-bold text-gray-800">Top Owners</h3>
                <p className="text-sm text-gray-500">
                  Based on sales in the most recent 3 years
                  {resultTotal !== totalProperties && ' (within current search filters)'}
                </p>
              </div>
            </div>
            {topOwners.length === 0 ? (
              <p className="text-sm text-gray-500">
                No sales with owner information in the last 3 years{resultTotal !== totalProperties ? ' within the current search filters' : ''}.
                {resultTotal !== totalProperties && (
                  <button onClick={clearPropertyFilters} className="ml-2 text-db-navy hover:underline">Clear filters</button>
                )}
              </p>
            ) : (
              <div className="space-y-2">
                {topOwners.map(({ owner, count, volume, units }) => (
                  <div
                    key={owner}
                    className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
                    onClick={() => drillDown(() => setEntityFilter(owner))}
                    title="Click to view all properties associated with this owner"
                  >
                    <span className="font-medium text-gray-700 truncate mr-4">{owner}</span>
                    <span className="text-sm text-gray-500 flex-shrink-0">
                      <span className="font-semibold text-db-navy">{count}</span> propert{count !== 1 ? 'ies' : 'y'}
                      {units > 0 && <span className="ml-2 text-gray-600">{units.toLocaleString()} {unitLabel.toLowerCase()}</span>}
                      {volume > 0 && <span className="ml-2 text-green-600 font-semibold">{formatCompactCurrency(volume)}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* County and Zip Code Breakdown */}
        {totalProperties > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            {/* County Breakdown */}
            <div className="bg-white rounded-2xl shadow-lg p-6">
              <div className="flex items-center gap-3 mb-4">
                <MapPin className="w-6 h-6 text-db-navy" />
                <h3 className="text-lg font-bold text-gray-800">Top Counties</h3>
              </div>
              <div className="space-y-2">
                {(() => {
                  const countyCounts = Object.fromEntries(meta?.tallies?.county ?? []) as Record<string, number>;
                  
                  return Object.entries(countyCounts)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 10)
                    .map(([county, count]) => (
                      <div
                        key={county}
                        className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
                        onClick={() => drillDown(() => setSelectedCounties([county]))}
                      >
                        <span className="font-medium text-gray-700">{county}</span>
                        <span className="text-sm font-semibold text-db-navy">{count.toLocaleString()} properties</span>
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
                  const zipCounts = Object.fromEntries(meta?.tallies?.zip ?? []) as Record<string, number>;
                  
                  return Object.entries(zipCounts)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 10)
                    .map(([zip, count]) => (
                      <div
                        key={zip}
                        className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer"
                        onClick={() => drillDown(() => setSelectedZipcode(zip === 'Unknown' ? '' : zip))}
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
        {totalProperties > 0 && (
          <div className="bg-white rounded-2xl shadow-lg p-6 mb-6">
            <div className="flex items-center gap-3 mb-4">
              <Calendar className="w-6 h-6 text-db-navy" />
              <div className="text-left">
                <h3 className="text-lg font-bold text-gray-800">Latest Insider Dates</h3>
                {latestUploadName && (
                  <p className="text-sm text-gray-500">From latest upload: <span className="font-medium">{latestUploadName}</span></p>
                )}
              </div>
            </div>
            <div className="space-y-2">
                {(() => {
                  const dateCounts = Object.fromEntries(meta?.tallies?.insiderDate ?? []) as Record<string, number>;

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
                        <span className="text-sm font-semibold text-db-navy">{count.toLocaleString()} properties</span>
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
                  className="w-full pl-12 pr-4 py-4 bg-white border-2 border-gray-200 rounded-2xl focus:ring-2 focus:ring-db-navy focus:border-db-navy text-lg shadow-sm"
                />
              </div>
            </div>

            {/* Reports List */}
        <div className="bg-white rounded-2xl shadow-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-gray-800">Weekly Insider Reports</h2>
            <span className="text-sm text-gray-500">
              {filteredReports.length} {filteredReports.length === 1 ? 'report' : 'reports'}
            </span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-10 h-10 animate-spin text-db-navy" />
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
                  className="group border-2 border-gray-200 rounded-xl p-6 hover:border-db-borderStrong hover:shadow-lg transition-all duration-200"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        <h3 className="text-xl font-bold text-gray-900 group-hover:text-db-navy transition-colors">
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
                            <span className="px-3 py-1 bg-db-tint text-db-navyLight rounded-full text-xs font-medium">
                              {report.selected_dates.join(', ')}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="ml-6">
                      <button
                        onClick={() => window.open(`${API_URL}/api/reports/${report.id}/view`, '_blank')}
                        className="px-6 py-3 bg-db-navy text-white rounded-xl hover:bg-db-navyLight transition-all duration-200 flex items-center gap-2 font-semibold shadow-md hover:shadow-lg"
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
          <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-6">
            {/* AI Natural Language Search */}
            <div className="mb-5 p-4 sm:p-5 bg-db-tint border border-db-border rounded-xl">
              <div className="flex items-baseline gap-2 mb-3">
                <Sparkles className="w-6 h-6 text-db-navy self-center" />
                <h2 className="text-xl font-bold text-gray-800 whitespace-nowrap">Ask AI</h2>
                <span className="text-sm text-gray-500">Type a question about this week's list or the whole archive</span>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={aiQuery}
                  onChange={(e) => setAiQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAiSearch()}
                  placeholder='e.g. "who owned 1000 Belmont before?", "everything Novare sold", "apartments in Cobb under $150k per unit"'
                  className="flex-1 min-w-0 px-4 py-3 text-lg bg-white border border-db-border rounded-lg focus:ring-2 focus:ring-db-navy focus:border-db-navy"
                  disabled={aiLoading}
                />
                <button
                  onClick={handleAiSearch}
                  disabled={aiLoading || !aiQuery.trim()}
                  className={`px-6 py-3 rounded-lg font-semibold text-white transition-all flex items-center justify-center gap-2 ${
                    aiLoading || !aiQuery.trim()
                      ? 'bg-gray-300 cursor-not-allowed'
                      : 'bg-db-navy hover:bg-db-navyLight shadow-md'
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
                <div className="mt-3 flex items-start gap-2 text-sm text-db-navy bg-db-tint/60 rounded-lg px-3 py-2">
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
                    <span className="bg-white border border-db-border text-db-navyLight px-3 py-1 rounded-full font-medium">
                      Sale date: {saleDateAfter || '...'} → {saleDateBefore || 'today'}
                    </span>
                  )}
                  {(insiderDateAfter || insiderDateBefore) && (
                    <span className="bg-white border border-db-border text-db-navyLight px-3 py-1 rounded-full font-medium">
                      Insider date: {insiderDateAfter || '...'} → {insiderDateBefore || 'today'}
                    </span>
                  )}
                </div>
              )}
              {(Object.keys(aiFields).length > 0 || Object.keys(aiRanges).length > 0) && (
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  {Object.entries(aiFields).map(([k, v]) => (
                    <span key={k} className="bg-white border border-db-border text-db-navyLight px-3 py-1 rounded-full font-medium">{v === '*' ? `has ${k}` : `${k} contains “${v}”`}</span>
                  ))}
                  {Object.entries(aiRanges).map(([k, r]) => (
                    <span key={k} className="bg-white border border-db-border text-db-navyLight px-3 py-1 rounded-full font-medium">
                      {k}: {r.min != null ? `≥ ${r.min.toLocaleString()}` : ''}{r.min != null && r.max != null ? ' and ' : ''}{r.max != null ? `≤ ${r.max.toLocaleString()}` : ''}
                    </span>
                  ))}
                </div>
              )}
              <AskCatalogue onPick={(q) => setAiQuery(q)} />
            </div>

            {aiHistory && <HistoryResults key={`${aiAsked ?? ''}|${aiHistory.question}|${aiHistory.total}`} answer={aiHistory} asked={aiAsked} onClose={() => setAiHistory(null)} />}

            {aiHistory && !browseWithAnswer ? (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
                <span>The answer above comes from the archive of every weekly file. This week's full list of {totalProperties.toLocaleString()} properties is hidden so it isn't mistaken for part of the answer.</span>
                <button onClick={() => setBrowseWithAnswer(true)} className="text-db-navy hover:underline font-medium whitespace-nowrap">Browse this week's list</button>
              </div>
            ) : (
            <>
            {/* Results toolbar */}
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[240px]">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  value={propertySearchText}
                  onChange={(e) => setPropertySearchText(e.target.value)}
                  placeholder="Quick find: name, old name, city, address, owner…"
                  className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy focus:border-db-navy"
                />
              </div>
              <button
                onClick={() => setShowFilters(v => !v)}
                className={`px-3 py-2.5 rounded-lg border text-sm font-medium flex items-center gap-1.5 ${showFilters || activeFilterCount > 0 ? 'border-db-borderStrong bg-db-tint text-db-navyLight' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}
              >
                <SlidersHorizontal className="w-4 h-4" />
                Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
                {showFilters ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              <button
                onClick={exportExcel}
                disabled={exporting || resultTotal === 0}
                title="Download the rows shown below as an Excel file"
                className="px-3 py-2.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-800 text-sm font-medium flex items-center gap-1.5 hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                Excel
              </button>
              <div className="relative">
                <button
                  onClick={() => setColPickerOpen((v) => !v)}
                  className="px-3 py-2.5 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium flex items-center gap-1.5 hover:bg-gray-50"
                >
                  Columns{hiddenCols.size > 0 ? ` (${tableColumns.length - hiddenCols.size})` : ''}
                  {colPickerOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
                {colPickerOpen && (
                  <div className="absolute right-0 z-20 mt-1 w-56 bg-white border border-db-border rounded-lg shadow-lg p-2" onMouseLeave={() => setColPickerOpen(false)}>
                    {tableColumns.map(([key, label]) => (
                      <label key={key} className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-db-cream ${key === 'propertyName' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                        <input type="checkbox" checked={key === 'propertyName' || colVisible(key)} disabled={key === 'propertyName'} onChange={() => toggleCol(key)} />
                        {label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={saveCurrentSearch}
                title="Save this search to come back to later"
                className="px-3 py-2.5 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium flex items-center gap-1.5 hover:bg-gray-50"
              >
                Save search
              </button>
              {savedSearches.length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setSavedSearchOpen((v) => !v)}
                    className="px-3 py-2.5 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium flex items-center gap-1.5 hover:bg-gray-50"
                  >
                    Saved ({savedSearches.length})
                    {savedSearchOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                  {savedSearchOpen && (
                    <div className="absolute right-0 z-20 mt-1 w-64 bg-white border border-db-border rounded-lg shadow-lg p-1 max-h-72 overflow-y-auto" onMouseLeave={() => setSavedSearchOpen(false)}>
                      {savedSearches.map((s) => (
                        <div key={s.id} className="flex items-center gap-1 px-2 py-1.5 rounded hover:bg-db-cream group">
                          <button onClick={() => applySavedSearch(s)} className="flex-1 text-left text-sm text-db-text truncate" title={s.query}>{s.name}</button>
                          <button onClick={() => deleteSavedSearch(s.id)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600" title="Delete"><X className="w-3.5 h-3.5" /></button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Filters */}
            {showFilters && filters && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                <select
                  value={selectedCity}
                  onChange={(e) => setSelectedCity(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy text-sm"
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
                      selectedCounties.length > 0 ? 'border-db-borderStrong text-db-navyLight font-medium' : 'border-gray-300 text-gray-700'
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
                            className="w-full text-left px-2 py-1.5 text-sm text-db-navy hover:bg-db-tint rounded font-medium"
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
                              className="w-4 h-4 text-db-navy rounded focus:ring-db-navy"
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
                  className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy text-sm"
                >
                  <option value="">All Market Areas</option>
                  {filters.marketAreas.map(area => (
                    <option key={area} value={area}>{area}</option>
                  ))}
                </select>

                <select
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy text-sm"
                >
                  <option value="">All Dates</option>
                  {filters.dates.map(date => (
                    <option key={date} value={date}>{date}</option>
                  ))}
                </select>
              </div>

            {/* Owner / Seller / Street / Zip Filters */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
              <input
                type="text"
                value={ownerFilter}
                onChange={(e) => setOwnerFilter(e.target.value)}
                placeholder="Owner (buyer) name..."
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy text-sm"
              />
              <input
                type="text"
                value={selectedSeller}
                onChange={(e) => setSelectedSeller(e.target.value)}
                placeholder="Seller name..."
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy text-sm"
              />
              <input
                type="text"
                value={entityFilter}
                onChange={(e) => setEntityFilter(e.target.value)}
                placeholder="Owner or seller (history)..."
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy text-sm"
              />
              <input
                type="text"
                value={streetFilter}
                onChange={(e) => setStreetFilter(e.target.value)}
                placeholder="Street name..."
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy text-sm"
              />
              <input
                type="text"
                value={selectedZipcode}
                onChange={(e) => setSelectedZipcode(e.target.value)}
                placeholder="Zip codes, e.g. 30305, 30309"
                className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy text-sm"
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
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy text-sm"
                />
                <span className="text-gray-500">-</span>
                <input
                  type="number"
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value)}
                  placeholder="Max Price"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy text-sm"
                />
              </div>
              {!isLand && (<>
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  value={minPricePerUnit}
                  onChange={(e) => setMinPricePerUnit(e.target.value)}
                  placeholder={bySqFt ? 'Min $/SF' : 'Min $/Unit'}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy text-sm"
                />
                <span className="text-gray-500">-</span>
                <input
                  type="number"
                  value={maxPricePerUnit}
                  onChange={(e) => setMaxPricePerUnit(e.target.value)}
                  placeholder={bySqFt ? 'Max $/SF' : 'Max $/Unit'}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy text-sm"
                />
              </div>
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  value={minUnits}
                  onChange={(e) => setMinUnits(e.target.value)}
                  placeholder={`Min ${unitLabel}`}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy text-sm"
                />
                <span className="text-gray-500">-</span>
                <input
                  type="number"
                  value={maxUnits}
                  onChange={(e) => setMaxUnits(e.target.value)}
                  placeholder={`Max ${unitLabel}`}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-db-navy text-sm"
                />
              </div>
              </>)}
            </div>
            </>
            )}

            {/* Results */}
            {filteredProperties.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <div className="bg-white border border-db-border rounded-xl px-4 py-3">
                  <div className="text-xs text-db-muted">Total volume</div>
                  <div className="text-xl font-semibold text-db-ink num">{resultStats.volume >= 1e9 ? `$${(resultStats.volume / 1e9).toFixed(2)}B` : resultStats.volume >= 1e6 ? `$${(resultStats.volume / 1e6).toFixed(1)}M` : resultStats.volume > 0 ? `$${Math.round(resultStats.volume).toLocaleString()}` : '—'}</div>
                </div>
                <div className="bg-white border border-db-border rounded-xl px-4 py-3">
                  <div className="text-xs text-db-muted">Total {isLand ? 'acres' : unitLabel}</div>
                  <div className="text-xl font-semibold text-db-ink num">{resultStats.unitTotal > 0 ? resultStats.unitTotal.toLocaleString('en-US', { maximumFractionDigits: isLand ? 1 : 0 }) : '—'}</div>
                </div>
                <div className="bg-white border border-db-border rounded-xl px-4 py-3">
                  <div className="text-xs text-db-muted">Median $/{isLand ? 'acre' : unitLabel.replace(/s$/, '')}</div>
                  <div className="text-xl font-semibold text-db-ink num">{resultStats.median > 0 ? `$${Math.round(resultStats.median).toLocaleString()}` : '—'}</div>
                </div>
                <div className="bg-white border border-db-border rounded-xl px-4 py-3">
                  <div className="text-xs text-db-muted">Largest sale</div>
                  <div className="text-xl font-semibold text-db-ink num truncate" title={resultStats.biggest ? primaryName(resultStats.biggest.propertyName) : ''}>
                    {resultStats.biggest ? `$${Math.round(Number(resultStats.biggest.salePrice)).toLocaleString()}` : '—'}
                  </div>
                </div>
              </div>
            )}
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm text-gray-600">
                Showing <span className="font-semibold">{resultTotal.toLocaleString()}</span> of <span className="font-semibold">{totalProperties.toLocaleString()}</span> properties
                {partialMatch && <span className="ml-2 text-amber-700">· no exact match for every word — showing the closest matches</span>}
              </p>
              {(activeFilterCount > 0 || propertySearchText) && (
                <button
                  onClick={clearPropertyFilters}
                  className="text-sm text-db-navy hover:text-db-navyLight font-medium flex items-center gap-1"
                >
                  <X className="w-4 h-4" />
                  Clear Filters
                </button>
              )}
            </div>

            {filteredProperties.length === 0 && (activeFilterCount > 0 || propertySearchText) ? (
              <div className="bg-white border border-db-border rounded-xl py-10 px-6 text-center">
                <p className="text-db-ink font-semibold mb-1">No properties match that search.</p>
                <p className="text-sm text-db-muted mb-4">Try loosening a filter, or a shorter search term.</p>
                <button
                  onClick={() => openFeedback(`Search returned 0 results.\nDatabase: ${databaseType}\nQuick find: ${propertySearchText || '(none)'}\n`)}
                  className="text-sm font-semibold text-db-navy hover:underline"
                >
                  Not what you expected? Report an issue →
                </button>
              </div>
            ) : (
            <>
            {/* Property List — cards on narrow screens instead of a wide table that just
                scrolls sideways (the Sep 24 audit specifically flagged a 1,100px table on a
                375px phone screen). */}
            <div className="sm:hidden space-y-2">
              {filteredProperties.slice(0, visibleRows).map((property, idx) => (
                <button
                  key={idx}
                  onClick={() => openReportFor(property, 'report')}
                  className="w-full text-left bg-white border border-db-border rounded-xl p-4 flex flex-col gap-1"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-db-ink truncate">{primaryName(property.propertyName)}</div>
                      <div className="text-xs text-db-muted truncate">{titleCase(property.city)}{property.county ? `, ${titleCase(property.county)}` : ''}</div>
                    </div>
                    {property.saleDate && <span className="text-xs text-db-muted whitespace-nowrap num">{property.saleDate}</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-sm num">
                    {property.salePrice && <span className="font-semibold text-db-ink">{formatCurrency(property.salePrice)}</span>}
                    {!isLand && property.units && <span className="text-db-muted">{formatUnits(property.units)} {unitLabel.toLowerCase()}</span>}
                    {isLand && fmtAcres(property.acres) && <span className="text-db-muted">{fmtAcres(property.acres)} ac</span>}
                  </div>
                </button>
              ))}
            </div>

            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full">
                <thead className="bg-db-cream sticky top-0 border-b border-db-border">
                  <tr>
                    {tableColumns.filter(([key]) => key === 'propertyName' || colVisible(key)).map(([key, label]) => (
                      <th
                        key={key}
                        onClick={() => toggleSort(key)}
                        title="Click to sort"
                        className={`px-4 py-3 text-xs font-semibold uppercase tracking-wider cursor-pointer select-none whitespace-nowrap hover:text-gray-900 ${NUMERIC_SORT.includes(key) || DATE_SORT.includes(key) ? 'text-right' : 'text-left'} ${sort?.key === key ? 'text-db-navyLight' : 'text-gray-600'}`}
                      >
                        {label}{sortMark(key)}
                      </th>
                    ))}
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-db-border">
                  {filteredProperties.slice(0, visibleRows).map((property, idx) => (
                    <>
                      <tr key={idx} className="hover:bg-gray-50 cursor-pointer" onClick={() => openReportFor(property, 'report')}>
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 max-w-[280px]" title={titleCase(property.propertyName)}>
                          <div className="truncate">
                            {primaryName(property.propertyName)}
                            {property.sourceFile && property.sourceFile.toLowerCase() !== databaseType && (
                              <span className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wide text-orange-700 bg-orange-50 border border-orange-200 rounded px-1.5 py-0.5">{property.sourceFile}</span>
                            )}
                          </div>
                          {aliasNames(property.propertyName) && (
                            <div className="truncate text-xs font-normal text-gray-400">{aliasNames(property.propertyName)}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{titleCase(property.city)}</td>
                        {colVisible('county') && <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{titleCase(property.county)}</td>}
                        {!isLand && colVisible('units') && <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap text-right num">{formatUnits(property.units)}</td>}
                        <td className="px-4 py-3 text-sm text-db-ink font-semibold whitespace-nowrap text-right num">{formatCurrency(property.salePrice)}</td>
                        {isLand
                          ? colVisible('acres') && <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap text-right num">{fmtAcres(property.acres)}</td>
                          : colVisible('pricePerUnit') && <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap text-right num">{formatPerUnit(property.pricePerUnit)}</td>}
                        {colVisible('saleDate') && <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap num">{property.saleDate}</td>}
                        {colVisible('insiderDate') && <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap num">{property.insiderDate}</td>}
                        <td className="px-2 py-3 text-sm whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => showHistoryFor(property)}
                              title="Owners, sales and name changes for this property across every week"
                              className="p-1.5 rounded text-db-navy hover:bg-db-tint"
                            >
                              <Clock className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => setExpandedRow(expandedRow === idx ? null : idx)}
                              title={expandedRow === idx ? 'Hide details' : 'More details'}
                              className="p-1.5 rounded text-gray-400 hover:bg-gray-100"
                            >
                              {expandedRow === idx ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expandedRow === idx && (
                        <tr>
                          <td colSpan={tableColumns.length + 1} className="px-4 py-4 bg-gray-50">
                            <div className="grid grid-cols-2 gap-4 text-sm">
                              <div className="col-span-2"><span className="font-semibold">Full name:</span> {titleCase(property.propertyName)}</div>
                              <div><span className="font-semibold">Address:</span> {titleCase(property.address)}</div>
                              <div><span className="font-semibold">Previous Insider Date:</span> {property.lastInsiderDate || '—'}</div>
                              <div><span className="font-semibold">Zip:</span> {property.zip}</div>
                              <div><span className="font-semibold">Market Area:</span> {property.marketArea}</div>
                              <div><span className="font-semibold">District:</span> {property.district}</div>
                              <div><span className="font-semibold">Parcel:</span> {property.parcel}</div>
                              <div><span className="font-semibold">Tax Owner:</span> {titleCase(property.taxOwner)}</div>
                              <div>
                                <span className="font-semibold">Owner (Buyer):</span>{' '}
                                {property.owner ? (
                                  <button
                                    className="text-db-navy hover:text-db-navy hover:underline"
                                    title="View all properties associated with this owner"
                                    onClick={(e) => { e.stopPropagation(); setEntityFilter(property.owner); }}
                                  >
                                    {titleCase(property.owner)}
                                  </button>
                                ) : '—'}
                              </div>
                              <div>
                                <span className="font-semibold">Seller:</span>{' '}
                                {property.seller ? (
                                  <button
                                    className="text-db-navy hover:text-db-navy hover:underline"
                                    title="View all properties associated with this seller"
                                    onClick={(e) => { e.stopPropagation(); setEntityFilter(property.seller); }}
                                  >
                                    {titleCase(property.seller)}
                                  </button>
                                ) : '—'}
                              </div>
                              <div><span className="font-semibold">Price / {bySqFt ? 'SF' : 'Unit'}:</span> {formatPerUnit(property.pricePerUnit) || '—'}</div>
                              <div><span className="font-semibold">Loan Amount:</span> {formatCurrency(property.loanAmount) || '—'}</div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
              {Math.min(resultTotal, browseMax) > visibleRows && (
                <div className="flex items-center justify-center gap-4 py-4 border-t border-gray-200 text-sm">
                  <span className="text-gray-500">Showing {visibleRows.toLocaleString()} of {resultTotal.toLocaleString()}</span>
                  <button onClick={() => setVisibleRows(v => v + PAGE_SIZE)} className="px-4 py-2 rounded-lg border border-gray-300 font-medium text-gray-700 hover:bg-gray-50">
                    {loadingMore ? 'Loading…' : `Show ${Math.min(PAGE_SIZE, Math.min(resultTotal, browseMax) - visibleRows)} more`}
                  </button>
                  <button onClick={() => setVisibleRows(Math.min(resultTotal, browseMax))} className="text-db-navy hover:underline">{resultTotal > browseMax ? `Show first ${browseMax.toLocaleString()}` : 'Show all'}</button>
                </div>
              )}
              {resultTotal > browseMax && visibleRows >= browseMax && (
                <p className="mt-4 text-center text-sm text-db-muted">
                  Showing the first {browseMax.toLocaleString()} of {resultTotal.toLocaleString()} results. Narrow the search (a city, county, zip or date range) to see the rest.
                </p>
              )}
            </div>
            </>
            )}
            </>
            )}
          </div>
        ) : activeView === 'history' ? (
          <PropertyHistory databaseType={historyDb || databaseType} fixedMode="history" initialQuery={historyQuery} />
        ) : null}

      </div>
    </div>
  );
}

export default UserDashboard;
