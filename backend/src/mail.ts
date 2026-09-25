import nodemailer from 'nodemailer';

// Feedback notifications go to FEEDBACK_TO (comma-separated) via SMTP_URL,
// e.g. smtps://user:pass@smtp.gmail.com:465. Without SMTP_URL nothing is sent.
export const FEEDBACK_TO = (
  process.env.FEEDBACK_TO ||
  'tareqmd@gmail.com,Blake@haasconsultinggroup.com,lamont@eaventures.co,stephanie@groovestudios.ai'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;

export function mailConfigured(): boolean {
  return transport !== null;
}

export interface FeedbackMail {
  id: number;
  message: string;
  contact: string | null;
  page: string | null;
  databaseType: string | null;
}

export async function sendFeedbackMail(f: FeedbackMail): Promise<void> {
  if (!transport) return;
  const from = process.env.SMTP_FROM || new URL(process.env.SMTP_URL!).username || FEEDBACK_TO[0];
  const lines = [
    f.message,
    '',
    `From: ${f.contact || 'anonymous'}`,
    f.databaseType ? `Database: ${f.databaseType}` : null,
    f.page ? `Page: ${f.page}` : null,
    `Feedback #${f.id} — https://databanknew-production.up.railway.app/admin`
  ].filter((l): l is string => l !== null);
  await transport.sendMail({
    from: `Databank Research Database <${decodeURIComponent(from)}>`,
    to: FEEDBACK_TO,
    replyTo: f.contact && /\S+@\S+\.\S+/.test(f.contact) ? f.contact : undefined,
    subject: `Databank feedback${f.contact ? ` from ${f.contact}` : ''}: ${f.message.slice(0, 60)}${f.message.length > 60 ? '…' : ''}`,
    text: lines.join('\n')
  });
}

// Sent once, to the new user themselves, right after signup — not a bare "you're in"
// confirmation, but a quick case for why the trial is worth using.
export async function sendWelcomeMail(email: string, firstName: string | null): Promise<void> {
  if (!transport) return;
  const from = process.env.SMTP_FROM || new URL(process.env.SMTP_URL!).username || FEEDBACK_TO[0];
  const name = firstName || 'there';
  const text = `Hi ${name},

Welcome to Databank — your 30-day free trial of Atlanta's commercial real estate research database is active now.

Here's what you get access to:

- 18,000+ researched properties across apartments, industrial, land, offices and retail, going back to 1970
- Full transaction history — every sale, every price, every owner a property has had, not just the most recent one
- Buyer, seller, broker and lender contacts, so you can actually reach the people on a deal
- Ask in plain English — "apartments in Cobb over $5M sold this year" — and get the exact matching properties back
- A fresh Insider Report every week, so you're never working from stale data

Jump in and search: https://databanknew-production.up.railway.app/#search

Questions, or want a hand getting started? Just reply to this email, or call us at (404) 872-8880.

— The Databank team`;
  await transport.sendMail({
    from: `Databank Research Database <${decodeURIComponent(from)}>`,
    to: email,
    subject: 'Welcome to Databank — your 30-day trial is active',
    text,
  });
}
