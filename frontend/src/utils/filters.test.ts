import { describe, it, expect } from 'vitest';

interface Property {
  propertyName: string;
  city: string;
  county: string;
  marketArea: string;
  zip: string;
  district: string;
  salePrice: string;
  landSalePrice: string;
  units: string;
  acres: string;
  yearBuilt: string;
  insiderDate: string;
  saleDate: string;
  landSaleDate: string;
  seller: string;
  [key: string]: string;
}

// Filter helper functions (matching the actual implementation)
const parseNum = (val: string | undefined) => parseFloat(String(val || '').replace(/[^0-9.-]/g, '') || '0');
const parseInt_ = (val: string | undefined) => parseInt(String(val || '').replace(/[^0-9]/g, '') || '0');

const inDateRange = (dateStr: string, after: string, before: string) => {
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return false;
  if (after && t < new Date(after).getTime()) return false;
  if (before && t > new Date(before).getTime()) return false;
  return true;
};

const mockProperties: Property[] = [
  {
    propertyName: 'Sunset Apartments',
    city: 'Atlanta',
    county: 'FULTON',
    marketArea: 'Midtown',
    zip: '30310',
    district: 'D1',
    salePrice: '$1,500,000',
    landSalePrice: '$500,000',
    units: '50',
    acres: '2.5',
    yearBuilt: '1995',
    insiderDate: '2024-01-15',
    saleDate: '2024-02-01',
    landSaleDate: '2020-06-15',
    seller: 'ABC Properties LLC',
  },
  {
    propertyName: 'Oak Ridge Complex',
    city: 'Marietta',
    county: 'COBB',
    marketArea: 'East Cobb',
    zip: '30060',
    district: 'D2',
    salePrice: '$2,200,000',
    landSalePrice: '$750,000',
    units: '75',
    acres: '4.0',
    yearBuilt: '2005',
    insiderDate: '2024-02-20',
    saleDate: '2024-03-15',
    landSaleDate: '2018-03-01',
    seller: 'XYZ Holdings Inc',
  },
  {
    propertyName: 'Downtown Lofts',
    city: 'Atlanta',
    county: 'Fulton',
    marketArea: 'Downtown',
    zip: '30303',
    district: 'D1',
    salePrice: '$800,000',
    landSalePrice: '$300,000',
    units: '25',
    acres: '0.5',
    yearBuilt: '2015',
    insiderDate: '2024-03-01',
    saleDate: '2024-04-01',
    landSaleDate: '2012-09-15',
    seller: 'Urban Developers',
  },
];

describe('Location Filters', () => {
  it('should filter by city', () => {
    const filtered = mockProperties.filter(p => p.city === 'Atlanta');
    expect(filtered.length).toBe(2);
    expect(filtered.every(p => p.city === 'Atlanta')).toBe(true);
  });

  it('should filter by multiple counties (case-sensitive)', () => {
    const selectedCounties = ['FULTON', 'COBB'];
    const filtered = mockProperties.filter(p => selectedCounties.includes(p.county));
    expect(filtered.length).toBe(2);
  });

  it('should filter by zipcode', () => {
    const filtered = mockProperties.filter(p => p.zip === '30310');
    expect(filtered.length).toBe(1);
    expect(filtered[0].propertyName).toBe('Sunset Apartments');
  });

  it('should filter by market area', () => {
    const filtered = mockProperties.filter(p => p.marketArea === 'Midtown');
    expect(filtered.length).toBe(1);
  });

  it('should filter by district', () => {
    const filtered = mockProperties.filter(p => p.district === 'D1');
    expect(filtered.length).toBe(2);
  });
});

describe('Numeric Range Filters', () => {
  it('should filter by sale price range', () => {
    const minPrice = 1000000;
    const maxPrice = 2000000;
    const filtered = mockProperties.filter(p => {
      const price = parseNum(p.salePrice);
      return price >= minPrice && price <= maxPrice;
    });
    expect(filtered.length).toBe(1);
    expect(filtered[0].propertyName).toBe('Sunset Apartments');
  });

  it('should filter by minimum units', () => {
    const minUnits = 50;
    const filtered = mockProperties.filter(p => parseInt_(p.units) >= minUnits);
    expect(filtered.length).toBe(2);
  });

  it('should filter by acres range', () => {
    const minAcres = 1.0;
    const maxAcres = 3.0;
    const filtered = mockProperties.filter(p => {
      const acres = parseNum(p.acres);
      return acres >= minAcres && acres <= maxAcres;
    });
    expect(filtered.length).toBe(1);
    expect(filtered[0].propertyName).toBe('Sunset Apartments');
  });

  it('should filter by year built range', () => {
    const minYear = 2000;
    const maxYear = 2020;
    const filtered = mockProperties.filter(p => {
      const year = parseInt_(p.yearBuilt);
      return year >= minYear && year <= maxYear;
    });
    expect(filtered.length).toBe(2);
  });
});

describe('Date Range Filters', () => {
  it('should filter by insider date range', () => {
    const after = '2024-02-01';
    const before = '2024-03-15';
    const filtered = mockProperties.filter(p => inDateRange(p.insiderDate, after, before));
    expect(filtered.length).toBe(2);
  });

  it('should filter by sale date after', () => {
    const after = '2024-03-01';
    const filtered = mockProperties.filter(p => inDateRange(p.saleDate, after, ''));
    expect(filtered.length).toBe(2);
  });

  it('should filter by sale date before', () => {
    const before = '2024-03-01';
    const filtered = mockProperties.filter(p => inDateRange(p.saleDate, '', before));
    expect(filtered.length).toBe(1);
    expect(filtered[0].propertyName).toBe('Sunset Apartments');
  });
});

describe('Text Search', () => {
  it('should search across all string fields', () => {
    const searchText = 'abc';
    const filtered = mockProperties.filter(p => {
      const allValues = Object.values(p)
        .filter(v => typeof v === 'string')
        .join(' ')
        .toLowerCase();
      return allValues.includes(searchText.toLowerCase());
    });
    expect(filtered.length).toBe(1);
    expect(filtered[0].seller).toBe('ABC Properties LLC');
  });

  it('should handle multi-word search', () => {
    const tokens = 'sunset atlanta'.toLowerCase().split(/\s+/);
    const filtered = mockProperties.filter(p => {
      const allValues = Object.values(p)
        .filter(v => typeof v === 'string')
        .join(' ')
        .toLowerCase();
      return tokens.every(token => allValues.includes(token));
    });
    expect(filtered.length).toBe(1);
    expect(filtered[0].propertyName).toBe('Sunset Apartments');
  });

  it('should be case-insensitive', () => {
    const searchText = 'DOWNTOWN';
    const filtered = mockProperties.filter(p => {
      const allValues = Object.values(p)
        .filter(v => typeof v === 'string')
        .join(' ')
        .toLowerCase();
      return allValues.includes(searchText.toLowerCase());
    });
    expect(filtered.length).toBe(1);
  });
});

describe('Entity Filters', () => {
  it('should filter by seller', () => {
    const filtered = mockProperties.filter(p => p.seller === 'XYZ Holdings Inc');
    expect(filtered.length).toBe(1);
    expect(filtered[0].propertyName).toBe('Oak Ridge Complex');
  });
});

describe('Combined Filters', () => {
  it('should apply multiple filters together', () => {
    const city = 'Atlanta';
    const minPrice = 500000;
    const minUnits = 20;
    
    let filtered = mockProperties.filter(p => p.city === city);
    filtered = filtered.filter(p => parseNum(p.salePrice) >= minPrice);
    filtered = filtered.filter(p => parseInt_(p.units) >= minUnits);
    
    expect(filtered.length).toBe(2);
  });

  it('should return empty array when no matches', () => {
    const filtered = mockProperties.filter(p => p.city === 'NonexistentCity');
    expect(filtered.length).toBe(0);
  });
});
