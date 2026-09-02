import request from 'supertest';
import express from 'express';
import { registerAuthRoutes, requireAdmin, rateLimit } from './auth';

function makeApp() {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  app.post('/admin-only', requireAdmin, (_req, res) => res.json({ ok: true }));
  app.post('/limited', rateLimit(2), (_req, res) => res.json({ ok: true }));
  return app;
}

describe('admin auth', () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = 'secret';
  });

  it('reports not signed in by default', async () => {
    const res = await request(makeApp()).get('/api/auth/me');
    expect(res.body).toEqual({ admin: false, configured: true });
  });

  it('blocks admin routes without a session', async () => {
    const res = await request(makeApp()).post('/admin-only');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong password', async () => {
    const res = await request(makeApp()).post('/api/auth/login').send({ password: 'nope' });
    expect(res.status).toBe(401);
  });

  it('signs in with the right password and unlocks admin routes', async () => {
    const app = makeApp();
    const login = await request(app).post('/api/auth/login').send({ password: 'secret' });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const res = await request(app).post('/admin-only').set('Cookie', cookie);
    expect(res.body).toEqual({ ok: true });
    const out = await request(app).post('/api/auth/logout').set('Cookie', cookie);
    expect(out.body).toEqual({ admin: false });
    expect((await request(app).post('/admin-only').set('Cookie', cookie)).status).toBe(401);
  });

  it('returns 503 when no admin password is configured', async () => {
    delete process.env.ADMIN_PASSWORD;
    const res = await request(makeApp()).post('/admin-only');
    expect(res.status).toBe(503);
  });
});

describe('rate limit', () => {
  it('returns 429 after the hourly quota', async () => {
    const app = makeApp();
    expect((await request(app).post('/limited')).status).toBe(200);
    expect((await request(app).post('/limited')).status).toBe(200);
    const res = await request(app).post('/limited');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});
