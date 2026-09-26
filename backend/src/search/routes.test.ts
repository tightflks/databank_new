import express from 'express';
import request from 'supertest';

jest.mock('../users', () => ({ requireUser: (_req: unknown, _res: unknown, next: () => void) => next() }));
jest.mock('../auth', () => ({ rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
import { registerSearchRoutes, BROWSE_MAX, EXPORT_MAX } from './routes';

const header = ['P NAME', 'P CITY', 'COUNTY', 'P ZIP', 'SALE PRICE', 'INSIDER DATE'];
const rows = Array.from({ length: 1500 }, (_, i) => [i === 1499 ? 'ZAXBYS BUFORD' : `PLACE ${i}`, i % 2 ? 'ATLANTA' : 'MARIETTA', 'COBB', '30060', String(1000 + i), '2026-09-16']);
const app = express();
app.use(express.json());
registerSearchRoutes(app, {
  latestUpload: (db) => (db === 'land' ? { id: 1, original_filename: 'LANDSALE.csv' } : null),
  uploadData: () => [header, ...rows],
});

describe('server-side search', () => {
  it('returns one page and totals, never the whole database', async () => {
    const res = await request(app).post('/api/search/land').send({ params: {}, offset: 0, limit: 5000 });
    expect(res.body.total).toBe(1500);
    expect(res.body.rows).toHaveLength(100);
    expect(res.body.stats.volume).toBeGreaterThan(0);
  });

  it(`stops browsing at ${BROWSE_MAX} results`, async () => {
    const last = await request(app).post('/api/search/land').send({ params: {}, offset: BROWSE_MAX - 50, limit: 100 });
    expect(last.body.rows).toHaveLength(50);
    const past = await request(app).post('/api/search/land').send({ params: {}, offset: BROWSE_MAX + 200 });
    expect(past.body.rows).toHaveLength(0);
  });

  it('filters on the server', async () => {
    const res = await request(app).post('/api/search/land').send({ params: { searchQuery: 'zaxbys' } });
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].propertyName).toBe('ZAXBYS BUFORD');
  });

  it(`caps exports at ${EXPORT_MAX} rows`, async () => {
    const res = await request(app).post('/api/search/land/export').send({ params: {} });
    expect(res.body).toMatchObject({ total: 1500, capped: true, max: EXPORT_MAX });
    expect(res.body.rows).toHaveLength(EXPORT_MAX);
  });

  it('meta has counts but no rows', async () => {
    const res = await request(app).get('/api/search/land/meta');
    expect(res.body.total).toBe(1500);
    expect(res.body.rows).toBeUndefined();
    expect(res.body.tallies.city).toEqual(expect.arrayContaining([['ATLANTA', 750], ['MARIETTA', 750]]));
  });

  it('rejects unknown databases', async () => {
    expect((await request(app).get('/api/search/secrets/meta')).status).toBe(404);
  });
});
