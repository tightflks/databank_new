// Server-side search: the search screen used to download every row of a database and filter it
// in the browser, which let any signed-in trial account copy the whole database in one request.
// The row mapping and filters below are moved here from UserDashboard.tsx unchanged, so a search
// returns exactly what it did before; the browser now only receives one page of results.
import { formatExcelDate } from './excelDate';
import { computePricePerUnit } from './pricePerUnit';
import { tokenMatches, wordsOf, canonicalText, searchTokens } from './fuzzy';

export type Cell = string | number | null | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Property = { [key: string]: any };
export type SortKey = 'propertyName' | 'city' | 'county' | 'units' | 'salePrice' | 'pricePerUnit' | 'acres' | 'saleDate' | 'insiderDate';
export const NUMERIC_SORT: SortKey[] = ['units', 'salePrice', 'pricePerUnit', 'acres'];
export const DATE_SORT: SortKey[] = ['saleDate', 'insiderDate'];
export const SOURCE_HEADER = 'DATABANK FILE';

export type SearchParams = {
  searchQuery: string;
  selectedCity: string;
  selectedCounties: string[];
  selectedMarketArea: string;
  selectedZipcode: string;
  selectedDistrict: string;
  selectedLandLot: string;
  streetFilter: string;
  selectedDate: string;
  ownerFilter: string;
  selectedSeller: string;
  entityFilter: string;
  minPrice: string;
  maxPrice: string;
  minPricePerUnit: string;
  maxPricePerUnit: string;
  minLandPrice: string;
  maxLandPrice: string;
  minUnits: string;
  maxUnits: string;
  minAcres: string;
  maxAcres: string;
  minYearBuilt: string;
  maxYearBuilt: string;
  saleDateAfter: string;
  saleDateBefore: string;
  insiderDateAfter: string;
  insiderDateBefore: string;
  landSaleDateAfter: string;
  landSaleDateBefore: string;
  aiFields: Record<string, string>;
  aiRanges: Record<string, { min?: number; max?: number }>;
  sort: { key: SortKey; dir: 'asc' | 'desc' } | null;
};

export const EMPTY_PARAMS: SearchParams = {
  searchQuery: '',
  selectedCity: '',
  selectedCounties: [],
  selectedMarketArea: '',
  selectedZipcode: '',
  selectedDistrict: '',
  selectedLandLot: '',
  streetFilter: '',
  selectedDate: '',
  ownerFilter: '',
  selectedSeller: '',
  entityFilter: '',
  minPrice: '',
  maxPrice: '',
  minPricePerUnit: '',
  maxPricePerUnit: '',
  minLandPrice: '',
  maxLandPrice: '',
  minUnits: '',
  maxUnits: '',
  minAcres: '',
  maxAcres: '',
  minYearBuilt: '',
  maxYearBuilt: '',
  saleDateAfter: '',
  saleDateBefore: '',
  insiderDateAfter: '',
  insiderDateBefore: '',
  landSaleDateAfter: '',
  landSaleDateBefore: '',
  aiFields: {},
  aiRanges: {},
  sort: null,
};

// Reflex fills unknown numbers with a run of 1s and some computed fields overflow; treat as blank.
export function cleanNumber(v: unknown): number | null {
  const s = String(v ?? '').replace(/[$,\s]/g, '');
  if (!s || /^1{5,}(\.0*)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n < 1e12 ? n : null;
}

export function buildProperties(headers: string[], dataRows: Cell[][], databaseType: string): Property[] {
      return dataRows.map((row) => {
        const getCell = (header: string) => {
          const idx = headers.findIndex((h: string) => h && h.trim().toLowerCase() === header.toLowerCase());
          return idx >= 0 ? (row[idx] || '') : '';
        };
        // Resolve a value from the first header that exists in this file.
        // Apartment and industrial files name several columns differently
        // (e.g. UNITS COMPLETED vs # SQ FT BUILT), so each field lists its aliases.
        const getCellAny = (...headerNames: string[]) => {
          for (const name of headerNames) {
            const idx = headers.findIndex((h: string) => h && h.trim().toLowerCase() === name.toLowerCase());
            if (idx >= 0 && row[idx] !== undefined && row[idx] !== null && String(row[idx]).trim() !== '') return row[idx];
          }
          return '';
        };
        // Extract a 4-digit year from a value that may be a year or an Excel date serial
        const yearFromValue = (v: any): string => {
          if (v === undefined || v === null || String(v).trim() === '') return '';
          const str = String(v).trim();
          // Text like "6/15/1985", "1985-86" or "Blt 1985": take the first 4-digit year.
          // (parseFloat would read "6/15/1985" as 6, i.e. an Excel date in 1900.)
          if (typeof v !== 'number') {
            const m = str.match(/\b(1[5-9]\d{2}|2[01]\d{2})\b/);
            if (m) return m[1];
            if (!/^\d+(\.\d+)?$/.test(str)) return str;
          }
          const n = typeof v === 'number' ? v : parseFloat(str);
          if (isNaN(n)) return str;
          if (n >= 1500 && n <= 2200) return String(Math.round(n));
          // Two-digit year ("85" -> 1985, "05" -> 2005).
          if (n >= 0 && n < 100 && Number.isInteger(n)) {
            const cutoff = (new Date().getFullYear() % 100) + 1;
            return String(n < cutoff ? 2000 + n : 1900 + n);
          }
          // A genuine Excel date serial (> 2200 means 1906 onward).
          if (n > 2200) {
            const parts = formatExcelDate(n).split('/');
            if (parts.length === 3) return parts[2];
          }
          return str;
        };
        
        // INSIDER DATE is the latest report the property appeared in; PREVIOUS INSIDER DATE 1..3 are the
        // earlier ones (not always kept in order), so the "previous" shown is the newest of those.
        const latestInsider = formatExcelDate(getCell('INSIDER DATE'));
        const previousInsider = headers
          .map((h: string, i: number) => ({ h: (h || '').trim().toUpperCase(), i }))
          .filter(({ h }: { h: string }) => /^PREVIOUS INSIDER DATE/.test(h))
          .map(({ i }: { i: number }) => formatExcelDate(row[i]))
          .filter((d: string) => d && d !== latestInsider && !isNaN(new Date(d).getTime()))
          .sort((a: string, b: string) => new Date(b).getTime() - new Date(a).getTime())[0] || '';

        // A record may carry a building sale (SALE DATE / SALE PRICE) and/or a land sale
        // (LAND SALE DATE / LAND SALE PRICE). Land files lead with the land sale; the others show
        // the building sale and fall back to the land sale when there is none.
        const landSaleDate = formatExcelDate(getCell('LAND SALE DATE'));
        const landSalePrice = String(getCell('LAND SALE PRICE')).trim();
        const bldgSalePrice = String(getCell('SALE PRICE')).trim();
        const bldgSaleDate = formatExcelDate(getCell('SALE DATE'));
        const isLandDb = databaseType === 'land';
        const salePriceStr = isLandDb ? (landSalePrice || bldgSalePrice) : (bldgSalePrice || landSalePrice);
        const saleDate = isLandDb ? (landSaleDate || bldgSaleDate) : (bldgSaleDate || landSaleDate);
        // Researcher notes (M1..M10) so Quick find matches text like "LAND FOR THE APTS"
        const comments = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10']
          .map(c => String(getCell(c)).trim())
          .filter(Boolean)
          .join(' ');
        // Apartments size by units; industrial sizes by building square feet
        const unitsStr = String(getCellAny('UNITS COMPLETED:', 'UNITS COMPLETED', '# SQ FT BUILT')).trim();
        const pricePerUnit = computePricePerUnit(
          salePriceStr,
          unitsStr,
          String(getCellAny('$ UNIT PROJECT', 'PRICE PER SF BUILDING')).trim(),
          databaseType === 'apartments' ? 0 : 2
        );

        return {
          propertyName: String(getCell('P NAME')).trim(),
          description: String(getCellAny('P TYPE', 'PROJECT TYPE')).trim(),
          streetNumber: String(getCell('P STREET NUMBER')).trim(),
          streetName: String(getCell('P STREET NAME')).trim(),
          city: String(getCell('P CITY')).trim(),
          county: String(getCell('COUNTY')).trim(),
          marketArea: String(getCell('MARKET AREA')).trim(),
          insiderDate: latestInsider,
          lastInsiderDate: previousInsider,
          salePrice: salePriceStr,
          saleDate,
          landSalePrice,
          landSaleDate,
          comments,
          units: unitsStr,
          pricePerUnit: pricePerUnit > 0 ? String(pricePerUnit) : '',
          acres: String(getCell('# ACRES')).trim(),
          yearBuilt: yearFromValue(getCellAny('YEAR BUILT', 'BUILT\\COMPLETE', 'ORIGINALLY BUILT')),
          address: String(getCell('P STREET NUMBER')).trim() + ' ' + String(getCell('P STREET NAME')).trim(),
          zip: String(getCell('P ZIP')).trim(),
          district: String(getCell('DISTRICT2')).trim(),
          landLot: String(getCellAny('LAND LOT', 'LANDLOT')).trim(),
          parcel: String(getCell('PARCEL')).trim(),
          taxOwner: String(getCell('TAX OWNER')).trim(),
          owner: String(getCell('OWNER')).trim(),
          ownerAttention: String(getCellAny('OWNER2\\ATTENTION', 'ATTENTION')).trim(),
          seller: String(getCellAny('SELLER\\FORECLOSEE', 'SELLER')).trim(),
          loanAmount: String(getCellAny('$ LOAN', 'PERMANENT LOAN')).trim(),
          sourceFile: String(getCell(SOURCE_HEADER)).trim(),
          raw: row
        };
      }).filter((p: Property) => p.propertyName);
}

export function filterProperties(properties: Property[], headers: string[], q: SearchParams): { rows: Property[]; partial: boolean } {
    let filtered = [...properties];
    let partial = false;
    
    // Text search across ALL fields in the property
    if (q.searchQuery.trim()) {
      const tokens = searchTokens(q.searchQuery);
      // Parcel numbers are typed with or without spacing (111012003 vs 111 012 003)
      const digits = q.searchQuery.replace(/\D/g, '');
      const asParcel = digits.length >= 6 && /^[\d\s-]+$/.test(q.searchQuery.trim());
      // Count how many words each property matches; show full matches, otherwise the best
      // partial matches (at least one word, or half the words for longer queries) so a search
      // like "the mason augusta" never comes back empty when the property exists.
      const scored = filtered.map(p => {
        if (asParcel && String(p.parcel || '').replace(/\D/g, '').includes(digits)) return { p, hits: tokens.length };
        // Search across all string values in the property object
        const allValues = canonicalText(
          Object.values(p)
            .filter(v => typeof v === 'string')
            .join(' ')
        );
        const words = wordsOf(
          canonicalText(
            [p.propertyName, p.city, p.county, p.owner, p.seller, p.address, p.streetName, p.marketArea, p.comments]
              .map(v => String(v || ''))
              .join(' ')
          )
        );
        const hits = tokens.filter(token => tokenMatches(token, allValues, words)).length;
        return { p, hits };
      });
      const best = Math.max(0, ...scored.map(s => s.hits));
      const needed = best === tokens.length ? best : Math.max(1, Math.ceil(tokens.length / 2));
      filtered = best >= needed ? scored.filter(s => s.hits === best).map(s => s.p) : [];
      partial = filtered.length > 0 && best < tokens.length;
    }
    
    // Location filters
    if (q.selectedCity) filtered = filtered.filter(p => p.city === q.selectedCity);
    if (q.selectedCounties.length > 0) filtered = filtered.filter(p => q.selectedCounties.includes(p.county));
    if (q.selectedMarketArea) filtered = filtered.filter(p => p.marketArea === q.selectedMarketArea);
    const zips = q.selectedZipcode.split(/[\s,;]+/).map((z) => z.trim().slice(0, 5)).filter(Boolean);
    if (zips.length) {
      filtered = filtered.filter(p => zips.includes(String(p.zip || '').trim().slice(0, 5)));
    }
    if (q.selectedDistrict) {
      const target = String(q.selectedDistrict).trim();
      filtered = filtered.filter(p => String(p.district || '').trim() === target);
    }
    if (q.selectedLandLot) {
      const target = String(q.selectedLandLot).trim();
      filtered = filtered.filter(p => String(p.landLot || '').trim() === target);
    }
    if (q.streetFilter) {
      const target = q.streetFilter.trim().toLowerCase();
      filtered = filtered.filter(p =>
        String(p.streetName || '').toLowerCase().includes(target) ||
        String(p.address || '').toLowerCase().includes(target)
      );
    }
    if (q.selectedDate) filtered = filtered.filter(p => p.insiderDate === q.selectedDate);
    
    // Entity filters (partial, case-insensitive name matching)
    const nameMatch = (value: string | undefined, needle: string) =>
      String(value || '').toLowerCase().includes(needle.trim().toLowerCase());
    const matchesOwner = (p: Property, needle: string) =>
      nameMatch(p.owner, needle) || nameMatch(p.taxOwner, needle) || nameMatch(p.ownerAttention, needle);
    if (q.ownerFilter) filtered = filtered.filter(p => matchesOwner(p, q.ownerFilter));
    if (q.selectedSeller) filtered = filtered.filter(p => nameMatch(p.seller, q.selectedSeller));
    if (q.entityFilter) filtered = filtered.filter(p => matchesOwner(p, q.entityFilter) || nameMatch(p.seller, q.entityFilter));
    
    // Numeric range helpers
    const parseNum = (val: string | undefined) => parseFloat(String(val || '').replace(/[^0-9.-]/g, '') || '0');
    const parseInt_ = (val: string | undefined) => parseInt(String(val || '').replace(/[^0-9]/g, '') || '0');
    
    // Sale price range
    if (q.minPrice) filtered = filtered.filter(p => parseNum(p.salePrice) >= parseFloat(q.minPrice));
    if (q.maxPrice) filtered = filtered.filter(p => parseNum(p.salePrice) <= parseFloat(q.maxPrice));
    
    // Price per unit range (calculated: sale price / units)
    if (q.minPricePerUnit) filtered = filtered.filter(p => parseNum(p.pricePerUnit) >= parseFloat(q.minPricePerUnit));
    if (q.maxPricePerUnit) filtered = filtered.filter(p => {
      const ppu = parseNum(p.pricePerUnit);
      return ppu > 0 && ppu <= parseFloat(q.maxPricePerUnit);
    });
    
    // Land price range
    if (q.minLandPrice) filtered = filtered.filter(p => parseNum(p.landSalePrice) >= parseFloat(q.minLandPrice));
    if (q.maxLandPrice) filtered = filtered.filter(p => parseNum(p.landSalePrice) <= parseFloat(q.maxLandPrice));
    
    // Units range
    if (q.minUnits) filtered = filtered.filter(p => parseInt_(p.units) >= parseInt(q.minUnits));
    if (q.maxUnits) filtered = filtered.filter(p => parseInt_(p.units) <= parseInt(q.maxUnits));
    
    // Acres range
    if (q.minAcres) filtered = filtered.filter(p => parseNum(p.acres) >= parseFloat(q.minAcres));
    if (q.maxAcres) filtered = filtered.filter(p => parseNum(p.acres) <= parseFloat(q.maxAcres));
    
    // Year built range
    if (q.minYearBuilt) filtered = filtered.filter(p => parseInt_(p.yearBuilt) >= parseInt(q.minYearBuilt));
    if (q.maxYearBuilt) filtered = filtered.filter(p => parseInt_(p.yearBuilt) <= parseInt(q.maxYearBuilt));
    
    // Date range helper
    const inDateRange = (dateStr: string, after: string, before: string) => {
      const t = new Date(dateStr).getTime();
      if (isNaN(t)) return false;
      if (after && t < new Date(after).getTime()) return false;
      if (before && t > new Date(before).getTime()) return false;
      return true;
    };

    // Date filters
    if (q.saleDateAfter || q.saleDateBefore) {
      filtered = filtered.filter(p => p.saleDate && inDateRange(p.saleDate, q.saleDateAfter, q.saleDateBefore));
    }
    if (q.insiderDateAfter || q.insiderDateBefore) {
      filtered = filtered.filter(p => p.insiderDate && inDateRange(p.insiderDate, q.insiderDateAfter, q.insiderDateBefore));
    }
    if (q.landSaleDateAfter || q.landSaleDateBefore) {
      filtered = filtered.filter(p => p.landSaleDate && inDateRange(p.landSaleDate, q.landSaleDateAfter, q.landSaleDateBefore));
    }

    // Ask AI: arbitrary columns by header name
    const colIdx = (name: string) => headers.findIndex(h => h && h.trim().toUpperCase() === name.trim().toUpperCase());
    for (const [col, text] of Object.entries(q.aiFields)) {
      const idx = colIdx(col);
      if (idx < 0 || !text) continue;
      const needle = String(text).toLowerCase();
      filtered = filtered.filter(p => {
        const v = String(p.raw?.[idx] ?? '').trim();
        return needle === '*' ? v !== '' : v.toLowerCase().includes(needle);
      });
    }
    for (const [col, r] of Object.entries(q.aiRanges)) {
      const idx = colIdx(col);
      if (idx < 0 || !r) continue;
      filtered = filtered.filter(p => {
        const n = parseNum(String(p.raw?.[idx] ?? ''));
        if (!n && String(p.raw?.[idx] ?? '').trim() === '') return false;
        return (r.min == null || n >= r.min) && (r.max == null || n <= r.max);
      });
    }

    if (q.sort) {
      const { key, dir } = q.sort;
      const num = (p: Property) => parseNum(p[key]);
      const time = (p: Property) => new Date(p[key] || '').getTime() || 0;
      const sgn = dir === 'asc' ? 1 : -1;
      filtered = [...filtered].sort((a, b) => {
        if (NUMERIC_SORT.includes(key)) return sgn * (num(a) - num(b));
        if (DATE_SORT.includes(key)) return sgn * (time(a) - time(b));
        return sgn * String(a[key] || '').localeCompare(String(b[key] || ''));
      });
    }
    return { rows: filtered, partial };
}

export function insiderStats(properties: Property[]) {
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

    const parseNum = (value: string) => cleanNumber(value) ?? 0;

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
}

export function topOwners(filteredProperties: Property[]) {
    const parseNum = (value: string) => {
      const n = parseFloat(String(value ?? '').replace(/[^0-9.-]/g, ''));
      return isNaN(n) ? 0 : n;
    };
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 3);
    const recent = filteredProperties.filter(p => {
      const t = new Date(p.saleDate).getTime();
      return !isNaN(t) && t >= cutoff.getTime();
    });
    const ownerMap = new Map<string, { count: number; volume: number; units: number }>();
    recent.forEach(p => {
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
}

export function resultStats(rows: Property[], databaseType: string) {
    // Land is sized by acres, not units — its "units" column is building square feet, if anything.
    const byAcre = databaseType === 'land';
    let volume = 0, unitTotal = 0;
    const ppus: number[] = [];
    let biggest: Property | null = null;
    for (const p of rows) {
      const price = Number(p.salePrice);
      if (price > 0) {
        volume += price;
        if (!biggest || price > Number(biggest.salePrice)) biggest = p;
      }
      const size = cleanNumber(byAcre ? p.acres : p.units);
      if (size) unitTotal += size;
      const ppu = byAcre ? (price > 0 && size ? price / size : null) : cleanNumber(p.pricePerUnit);
      if (ppu) ppus.push(ppu);
    }
    ppus.sort((a, b) => a - b);
    const median = ppus.length ? ppus[Math.floor(ppus.length / 2)] : 0;
    return { volume, unitTotal, median, biggest };
}

export function newThisWeek(properties: Property[]) {
    const counts = new Map<string, number>();
    const today = Date.now();
    for (const p of properties) {
      const t = new Date(p.insiderDate).getTime();
      if (p.insiderDate && !isNaN(t) && t <= today) counts.set(p.insiderDate, (counts.get(p.insiderDate) || 0) + 1);
    }
    let best: { date: string; count: number } | null = null;
    for (const [date, count] of counts) {
      if (!best || new Date(date).getTime() > new Date(best.date).getTime()) best = { date, count };
    }
    return best;
}
