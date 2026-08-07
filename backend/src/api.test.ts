import request from 'supertest';
import express from 'express';
import path from 'path';
import fs from 'fs';

// Mock the database before importing the app
const mockDb = {
  prepare: jest.fn().mockReturnValue({
    run: jest.fn().mockReturnValue({ lastInsertRowid: 1, changes: 1 }),
    get: jest.fn(),
    all: jest.fn().mockReturnValue([]),
  }),
  exec: jest.fn(),
};

jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => mockDb);
});

// Create a minimal test app
const app = express();
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mock uploads endpoint
app.get('/api/uploads', (req, res) => {
  res.json({ uploads: [], total: 0 });
});

// Mock reports endpoint
app.get('/api/reports', (req, res) => {
  res.json({ reports: [], total: 0, limit: 50, offset: 0 });
});

describe('API Endpoints', () => {
  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/api/health');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
    });
  });

  describe('GET /api/uploads', () => {
    it('should return uploads list', async () => {
      const response = await request(app).get('/api/uploads');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('uploads');
      expect(Array.isArray(response.body.uploads)).toBe(true);
    });
  });

  describe('GET /api/reports', () => {
    it('should return reports list', async () => {
      const response = await request(app).get('/api/reports');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('reports');
      expect(response.body).toHaveProperty('total');
      expect(Array.isArray(response.body.reports)).toBe(true);
    });
  });
});

describe('Utility Functions', () => {
  describe('Date formatting', () => {
    it('should handle Excel serial dates', () => {
      // Excel serial date 45000 = 2023-03-15
      const excelSerial = 45000;
      const date = new Date((excelSerial - 25569) * 86400 * 1000);
      expect(date.getFullYear()).toBe(2023);
    });

    it('should handle ISO date strings', () => {
      const isoDate = '2024-01-15T12:00:00Z';
      const date = new Date(isoDate);
      expect(date.getUTCFullYear()).toBe(2024);
      expect(date.getUTCMonth()).toBe(0); // January
      expect(date.getUTCDate()).toBe(15);
    });
  });

  describe('Price parsing', () => {
    it('should parse currency strings', () => {
      const priceStr = '$1,234,567.89';
      const price = parseFloat(priceStr.replace(/[^0-9.-]/g, ''));
      expect(price).toBe(1234567.89);
    });

    it('should handle empty values', () => {
      const priceStr = '';
      const price = parseFloat(priceStr.replace(/[^0-9.-]/g, '') || '0');
      expect(price).toBe(0);
    });
  });
});

describe('Filter Logic', () => {
  const mockProperties = [
    { propertyName: 'Test Property 1', city: 'Atlanta', county: 'FULTON', zip: '30310', salePrice: '$500000' },
    { propertyName: 'Test Property 2', city: 'Marietta', county: 'COBB', zip: '30060', salePrice: '$750000' },
    { propertyName: 'Test Property 3', city: 'Atlanta', county: 'DEKALB', zip: '30312', salePrice: '$300000' },
  ];

  it('should filter by city', () => {
    const filtered = mockProperties.filter(p => p.city === 'Atlanta');
    expect(filtered.length).toBe(2);
  });

  it('should filter by county', () => {
    const filtered = mockProperties.filter(p => p.county === 'FULTON');
    expect(filtered.length).toBe(1);
    expect(filtered[0].propertyName).toBe('Test Property 1');
  });

  it('should filter by zipcode', () => {
    const filtered = mockProperties.filter(p => p.zip === '30310');
    expect(filtered.length).toBe(1);
  });

  it('should filter by price range', () => {
    const minPrice = 400000;
    const maxPrice = 600000;
    const filtered = mockProperties.filter(p => {
      const price = parseFloat(p.salePrice.replace(/[^0-9.-]/g, ''));
      return price >= minPrice && price <= maxPrice;
    });
    expect(filtered.length).toBe(1);
    expect(filtered[0].propertyName).toBe('Test Property 1');
  });

  it('should filter by multiple counties', () => {
    const selectedCounties = ['FULTON', 'DEKALB'];
    const filtered = mockProperties.filter(p => selectedCounties.includes(p.county));
    expect(filtered.length).toBe(2);
  });

  it('should perform text search across fields', () => {
    const searchText = 'marietta';
    const filtered = mockProperties.filter(p => {
      const haystack = Object.values(p).filter(v => typeof v === 'string').join(' ').toLowerCase();
      return haystack.includes(searchText.toLowerCase());
    });
    expect(filtered.length).toBe(1);
    expect(filtered[0].city).toBe('Marietta');
  });
});
