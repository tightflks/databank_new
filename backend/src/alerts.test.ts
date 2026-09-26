const sent: string[] = [];
jest.mock('./mail', () => ({ sendAlertMail: async (subject: string) => { sent.push(subject); } }));
import express from 'express';
import request from 'supertest';
import { errorMiddleware, reportError } from './alerts';

beforeAll(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));

describe('error alerts', () => {
  it('turns a thrown route error into a JSON 500 and one alert email', async () => {
    const app = express();
    app.get('/boom', () => { throw new Error('kaboom'); });
    app.use(errorMiddleware);
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/notified/);
    expect(sent).toEqual(['GET /boom: kaboom']);
  });

  it('sends the same error at most once an hour', () => {
    sent.length = 0;
    reportError('job', new Error('same'));
    reportError('job', new Error('same'));
    reportError('job', new Error('different'));
    expect(sent).toEqual(['job: same', 'job: different']);
  });
});
