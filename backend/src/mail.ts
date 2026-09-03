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
