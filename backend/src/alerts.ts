import { NextFunction, Request, Response } from 'express';
import { sendAlertMail } from './mail';

// Emails admins when the server hits an error, so a crash is noticed before a customer writes
// in. The same error (by message) is sent at most once an hour, and no more than 20 a day.
const sentAt = new Map<string, number>();
let day = '';
let sentToday = 0;

export function reportError(where: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(`${where}:`, e);
  const key = `${where}|${e.message}`;
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; sentToday = 0; }
  if ((sentAt.get(key) ?? 0) > now - 60 * 60 * 1000 || sentToday >= 20) return;
  sentAt.set(key, now);
  sentToday++;
  const body = [`Where: ${where}`, `When: ${new Date().toISOString()}`, '', e.stack || e.message].join('\n');
  sendAlertMail(`${where}: ${e.message}`, body).catch((m: unknown) => console.error('Alert email failed:', m));
}

// Last Express middleware: anything a route threw ends up here as a plain 500.
export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  reportError(`${req.method} ${req.path}`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on our end. We have been notified.' });
}

export function installProcessAlerts(): void {
  process.on('unhandledRejection', (reason) => reportError('Unhandled promise rejection', reason));
  process.on('uncaughtException', (err) => {
    reportError('Server crashed (uncaught exception)', err);
    setTimeout(() => process.exit(1), 3000); // let the alert go out; Railway restarts the service
  });
}
