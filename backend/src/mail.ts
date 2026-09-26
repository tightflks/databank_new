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
const APP_URL = process.env.APP_URL || 'https://databanknew-production.up.railway.app';

// Sent once, right after signup, in place of a plain welcome email: it has to also carry the
// verification link, since a Sep 25 security review pointed out signup accepted any email with
// nothing to confirm the signer actually controls it (someone could sign up as
// "name@cbre.com" and get a trial that looks like it belongs to that firm). Access is withheld
// until this link is clicked (see hasAccess() in users.ts), so the value-prop copy doubles as
// the reason to actually click it rather than ignore it.
export async function sendVerifyMail(email: string, firstName: string | null, token: string): Promise<void> {
  if (!transport) return;
  const from = process.env.SMTP_FROM || new URL(process.env.SMTP_URL!).username || FEEDBACK_TO[0];
  const name = firstName || 'there';
  const verifyUrl = `${APP_URL}/api/account/verify?token=${token}`;
  const text = `Hi ${name},

Welcome to Databank — one step left before your 30-day free trial of Atlanta's commercial real estate research database is active.

Confirm your email to get started:
${verifyUrl}

Once you're in, here's what you get access to:

- 18,000+ researched properties across apartments, industrial, land, offices and retail, going back to 1970
- Full transaction history — every sale, every price, every owner a property has had, not just the most recent one
- Buyer, seller, broker and lender contacts, so you can actually reach the people on a deal
- Ask in plain English — "apartments in Cobb over $5M sold this year" — and get the exact matching properties back
- A fresh Insider Report every week, so you're never working from stale data

Questions, or want a hand getting started? Just reply to this email, or call us at (404) 872-8880.

— The Databank team`;
  await transport.sendMail({
    from: `Databank Research Database <${decodeURIComponent(from)}>`,
    to: email,
    subject: 'Confirm your email to start your Databank trial',
    text,
  });
}

export async function sendResetMail(email: string, token: string): Promise<void> {
  if (!transport) return;
  const from = process.env.SMTP_FROM || new URL(process.env.SMTP_URL!).username || FEEDBACK_TO[0];
  const resetUrl = `${APP_URL}/?resetToken=${token}#search`;
  const text = `Someone (hopefully you) asked to reset the password on this Databank account.

Reset it here — this link expires in 1 hour:
${resetUrl}

If you didn't request this, you can ignore this email; your password hasn't been changed.

— The Databank team`;
  await transport.sendMail({
    from: `Databank Research Database <${decodeURIComponent(from)}>`,
    to: email,
    subject: 'Reset your Databank password',
    text,
  });
}

// Server error alerts go to the people who fix things, not the whole feedback list.
const ALERT_TO = (process.env.ALERT_TO || 'tareqmd@gmail.com,stephanie@groovestudios.ai')
  .split(',').map((s) => s.trim()).filter(Boolean);

export async function sendAlertMail(subject: string, text: string): Promise<void> {
  if (!transport) return;
  const from = process.env.SMTP_FROM || new URL(process.env.SMTP_URL!).username || FEEDBACK_TO[0];
  await transport.sendMail({
    from: `Databank alerts <${decodeURIComponent(from)}>`,
    to: ALERT_TO,
    subject: `[Databank] ${subject}`.slice(0, 200),
    text,
  });
}
