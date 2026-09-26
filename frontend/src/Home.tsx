import { useState, type FormEvent } from 'react';
import axios from 'axios';
import {
  Search, Clock, Users, MapPin, Phone, Store, Trees, Building, Factory,
  Briefcase, Loader2, CheckCircle, ArrowRight
} from 'lucide-react';
import MarketPulse, { useStats, money, weekLabel } from './MarketPulse';
import { titleCase } from './utils/fmt';

const TYPE_LABEL: Record<string, string> = { APTS: 'Apartments', IND: 'Industrial', LANDSALE: 'Land', OFFSHOP: 'Office & retail', FRANCHIS: 'Retail' };

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

interface Props {
  onStart: (query?: string) => void;
}

// The five databases customers actually buy (Search tabs, Trial page and here now agree —
// previously this list, the search tabs, and the Services copy each named a different set).
const DATABASES = [
  { icon: Building, name: 'Apartments' },
  { icon: Factory, name: 'Industrial' },
  { icon: Trees, name: 'Land' },
  { icon: Briefcase, name: 'Offices' },
  { icon: Store, name: 'Retail' },
];

const HIGHLIGHTS = [
  { icon: Search, title: 'Ask in plain English', text: '"Apartments in Cobb over $5M sold this year." Misspellings, street abbreviations and old property names still find the right deal.' },
  { icon: Clock, title: 'Every owner, every name', text: 'One page per property: who bought it, who sold it, what it traded for and every name it has gone by.' },
  { icon: Users, title: 'The people on the deal', text: 'Brokers, lenders, attorneys and leasing companies with contact details. Export exactly what you found to Excel.' },
];

type Customer = { name: string; logo?: string; mark?: boolean; note?: string };

const CUSTOMERS: Customer[] = [
  { name: 'Cushman & Wakefield', logo: '/customers/cushman-wakefield.png' },
  { name: 'CBRE', logo: '/customers/cbre.png' },
  { name: 'GREA', logo: '/customers/grea.png', mark: true, note: 'formerly Brown Realty' },
  { name: 'Lee & Associates', logo: '/customers/lee-associates.svg' },
  { name: 'Lavista Associates' },
  { name: 'Coldwell Banker Commercial', logo: '/customers/coldwell-banker-commercial.png', mark: true },
  { name: 'NAI Brannen Goddard', logo: '/customers/nai-brannen-goddard.png' },
  { name: 'Berkadia', logo: '/customers/berkadia.svg' },
  { name: 'Franklin Street', logo: '/customers/franklin-street.png', mark: true },
  { name: 'King Industrial Realty', logo: '/customers/king-industrial.png' },
  { name: 'Eastdil Secured', logo: '/customers/eastdil-secured.png' },
];

const MAP_SRC = 'https://www.google.com/maps?q=3108+Piedmont+Road+Suite+235,+Atlanta,+GA+30305&output=embed';

function ContactForm() {
  const [form, setForm] = useState({ first: '', last: '', email: '', subject: '', message: '' });
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('sending');
    try {
      await axios.post(`${API_URL}/api/feedback`, {
        message: `[Contact form] ${form.subject}\n\n${form.message}`,
        contact: `${form.first} ${form.last} <${form.email}>`,
        page: 'contact',
      });
      setState('sent');
    } catch {
      setState('error');
    }
  };

  if (state === 'sent') {
    return (
      <div className="flex items-center gap-3 text-db-green bg-green-50 border border-green-200 rounded-xl p-5">
        <CheckCircle className="w-6 h-6 shrink-0" />
        <p>Thanks — your message is on its way to the Databank team. We'll reply to {form.email}.</p>
      </div>
    );
  }

  const input = 'w-full rounded-lg border border-db-borderStrong px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-db-navy/30';
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <input required placeholder="First name" value={form.first} onChange={set('first')} className={input} />
        <input required placeholder="Last name" value={form.last} onChange={set('last')} className={input} />
      </div>
      <input required type="email" placeholder="Email address" value={form.email} onChange={set('email')} className={input} />
      <input required placeholder="Subject" value={form.subject} onChange={set('subject')} className={input} />
      <textarea required rows={4} placeholder="Message" value={form.message} onChange={set('message')} className={input} />
      {state === 'error' && <p className="text-sm text-red-600">Couldn't send — please call (404) 872-8880.</p>}
      <button type="submit" disabled={state === 'sending'} className="inline-flex items-center gap-2 bg-db-navy text-white font-semibold px-5 py-2.5 rounded-lg hover:bg-db-navyLight disabled:opacity-50">
        {state === 'sending' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />} Send message
      </button>
    </form>
  );
}

const TRY_QUERIES = [
  'Industrial sales outside the perimeter since 2024',
  'Who owned 1000 Belmont before?',
  'Land for apartments in North Atlanta',
];

export default function Home({ onStart }: Props) {
  const stats = useStats();
  const [q, setQ] = useState('Apartments in Cobb over $5M sold this year');
  const tw = stats?.thisWeek;

  return (
    <div className="space-y-14 font-sans text-db-text">
      {/* Hero: one headline, one search bar, one call to action — the rest follows below. */}
      <section className="grid lg:grid-cols-[7fr,5fr] gap-10 items-start">
        <div className="flex flex-col gap-6">
          <div className="text-xs font-semibold tracking-widest uppercase text-db-goldText">Atlanta commercial real estate · Researched since 1970</div>
          <h1 className="font-bold tracking-tight text-4xl sm:text-5xl leading-tight text-db-ink m-0">
            Every Atlanta commercial sale, verified by people who know the market.
          </h1>
          <p className="text-lg text-db-subtle max-w-xl m-0">
            Prices, buyers, sellers, lenders and brokers for {stats?.totalProperties ? `${Math.round(stats.totalProperties / 1000)}k+` : '18,000+'} properties across metro
            Atlanta and Georgia. Ask a question in plain English and get the exact deals back.
          </p>

          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => { e.preventDefault(); onStart(q); }}
          >
            <label htmlFor="hero-q" className="text-sm font-semibold text-db-text">Ask the database</label>
            <div className="flex items-center gap-3 bg-white border-[1.5px] border-db-navy rounded-xl px-3 py-1.5 shadow-sm">
              <Search className="w-5 h-5 text-db-muted shrink-0" />
              <input id="hero-q" value={q} onChange={(e) => setQ(e.target.value)} className="flex-1 border-0 outline-none text-lg bg-transparent h-11" />
              <button type="submit" className="bg-db-navy text-white font-semibold text-sm px-5 py-3 rounded-lg hover:bg-db-navyLight">Search</button>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-xs text-db-muted">Try:</span>
              {TRY_QUERIES.map((t) => (
                <button type="button" key={t} onClick={() => onStart(t)} className="text-xs text-db-navy bg-db-tint px-3 py-1.5 rounded-full hover:bg-db-tint/70">{t}</button>
              ))}
            </div>
          </form>

          <div className="flex items-center gap-5 flex-wrap">
            <button onClick={() => onStart()} className="bg-db-navy text-white font-semibold px-6 py-3.5 rounded-lg hover:bg-db-navyLight">Start your 30-day free trial</button>
            <a href="#insider" className="text-db-navy font-semibold text-sm hover:underline">See a sample Insider report</a>
          </div>
          <p className="text-xs text-db-muted m-0">No credit card needed. Invite your whole team during the trial.</p>
        </div>

        <aside id="insider" className="bg-white border border-db-border rounded-2xl overflow-hidden shadow-sm">
          <div className="bg-db-navy text-white px-6 py-4 flex justify-between items-baseline">
            <div className="font-semibold text-sm">This week's Insider</div>
            <div className="text-xs text-db-tint num">Week of {weekLabel(stats?.week ?? null)}</div>
          </div>
          {tw && tw.count > 0 ? (
            <>
              <div className="grid grid-cols-2 border-b border-db-border">
                <div className="px-6 py-5 border-r border-db-border">
                  <div className="text-3xl font-semibold text-db-ink num">{tw.count}</div>
                  <div className="text-xs text-db-muted">transactions reported</div>
                </div>
                <div className="px-6 py-5">
                  <div className="text-3xl font-semibold text-db-ink num">{money(tw.volume)}</div>
                  <div className="text-xs text-db-muted">total sale volume</div>
                </div>
              </div>
              {tw.biggest && (
                <div className="px-6 py-5 flex flex-col gap-1 border-b border-db-border">
                  <div className="text-xs font-semibold tracking-wide uppercase text-db-goldText">Largest sale</div>
                  <div className="text-lg font-semibold text-db-ink">{titleCase(tw.biggest.name) || '(unnamed property)'}</div>
                  <div className="text-sm text-db-muted num">{titleCase(tw.biggest.city)} · {TYPE_LABEL[tw.biggest.type] ?? tw.biggest.type} · {money(tw.biggest.price)}</div>
                </div>
              )}
            </>
          ) : (
            <div className="px-6 py-8 text-sm text-db-muted">This week's numbers are being finalized.</div>
          )}
          <button onClick={() => onStart()} className="w-full text-left px-6 py-4 text-sm font-semibold text-db-navy hover:bg-db-tint flex items-center justify-between">
            See this week's sales <ArrowRight className="w-4 h-4" />
          </button>
        </aside>
      </section>

      <section className="grid sm:grid-cols-3 gap-4">
        {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
          <div key={title} className="bg-white border border-db-border rounded-xl p-6">
            <Icon className="w-6 h-6 text-db-navy mb-3" />
            <h3 className="font-semibold text-db-ink mb-1">{title}</h3>
            <p className="text-sm text-db-subtle leading-relaxed">{text}</p>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {DATABASES.map(({ icon: Icon, name }) => (
          <div key={name} className="bg-white border border-db-border rounded-xl p-4 flex flex-col items-center text-center gap-2 hover:shadow-sm transition">
            <span className="w-11 h-11 rounded-full bg-db-tint text-db-navy flex items-center justify-center"><Icon className="w-5 h-5" /></span>
            <span className="text-sm font-semibold text-db-ink">{name}</span>
          </div>
        ))}
      </section>

      <MarketPulse onStart={() => onStart()} stats={stats} />

      <section className="bg-white border border-db-border rounded-2xl p-6 sm:p-10 grid md:grid-cols-[auto,1fr] gap-8 items-start">
        <img src="/alan-wexler.jpg" alt="Alan Wexler, Databank president" className="w-32 h-32 sm:w-40 sm:h-40 rounded-full object-cover mx-auto md:mx-0" />
        <div>
          <p className="uppercase tracking-widest text-xs text-db-muted mb-1">A note from our president</p>
          <h2 className="font-bold tracking-tight text-2xl text-db-ink mb-4">Alan Wexler</h2>
          <div className="space-y-3 text-db-subtle leading-relaxed">
            <p>
              Databank was founded in 1970 to provide pertinent data on the real estate market to the businesses and firms directly
              involved with that industry. Real estate activity, whether from development or sales, involves the proper analysis of
              needs, timing and location of product and programs.
            </p>
            <p>
              Databank is the leading source for brokers, appraisers, owners, lenders, attorneys and other businesses related to the
              Atlanta real estate market. Before you make a decision on your next deal, make sure your homework is complete by letting
              Databank do it for you.
            </p>
          </div>
        </div>
      </section>

      <section className="text-center">
        <p className="uppercase tracking-widest text-xs text-db-muted mb-4">Valued customers</p>
        <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-8 max-w-4xl mx-auto">
          {CUSTOMERS.map((c) => (
            <div key={c.name} className="flex flex-col items-center justify-center gap-1">
              {c.logo ? (
                c.mark ? (
                  <div className="flex items-center gap-2">
                    <img src={c.logo} alt={c.name} className="h-9 w-9 object-contain" />
                    <span className="text-sm font-semibold text-db-ink">{c.name}</span>
                  </div>
                ) : (
                  <img src={c.logo} alt={c.name} className="h-9 sm:h-10 max-w-[170px] w-auto object-contain" />
                )
              ) : (
                <span className="text-sm font-semibold text-db-ink uppercase tracking-wide">{c.name}</span>
              )}
              {c.note && <span className="text-[11px] text-db-muted">{c.note}</span>}
            </div>
          ))}
        </div>
      </section>

      <section id="contact" className="scroll-mt-24 grid lg:grid-cols-2 gap-6">
        <div className="bg-white border border-db-border rounded-2xl p-6 sm:p-8">
          <p className="uppercase tracking-widest text-xs text-db-muted mb-1">Get in touch</p>
          <h2 className="font-bold tracking-tight text-2xl text-db-ink mb-4">Contact Databank</h2>
          <ContactForm />
        </div>
        <div className="rounded-2xl overflow-hidden border border-db-border flex flex-col">
          <iframe
            title="Databank office — 3108 Piedmont Road, Suite 235, Atlanta, GA 30305"
            src={MAP_SRC}
            className="w-full flex-1 min-h-[280px] border-0"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allowFullScreen
          />
          <div className="bg-db-navy text-white p-5 grid sm:grid-cols-2 gap-4">
            <div className="flex gap-3">
              <MapPin className="w-5 h-5 mt-0.5 text-db-tint shrink-0" />
              <div>
                <p className="font-semibold text-sm">Atlanta, Georgia</p>
                <p className="text-db-tint text-xs">3108 Piedmont Road, Suite 235<br />Atlanta, GA 30305</p>
              </div>
            </div>
            <div className="flex gap-3">
              <Phone className="w-5 h-5 mt-0.5 text-db-tint shrink-0" />
              <div>
                <p className="font-semibold text-sm">Office</p>
                <a href="tel:+14048728880" className="text-db-tint text-xs hover:text-white num">(404) 872-8880</a>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
