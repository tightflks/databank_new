import { useState, type FormEvent } from 'react';
import axios from 'axios';
import {
  Search, Clock, Building2, FileSpreadsheet, MapPin, Phone, Printer, Store, Trees, Building, Factory,
  Briefcase, Hotel, Database, Newspaper, Microscope, LandPlot, Loader2, CheckCircle, ArrowRight
} from 'lucide-react';
import MarketPulse from './MarketPulse';



const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');

interface Props {
  onStart: () => void;
}

const HIGHLIGHTS = [
  { icon: Search, title: 'Ask in plain English', text: '"Apartments in Cobb over $5M sold this year" — misspellings and old property names included.' },
  { icon: Clock, title: 'Full property history', text: 'Who owned it, what it sold for, when it changed hands or changed names — one record per property.' },
  { icon: Building2, title: 'Five databases', text: 'Apartments, Industrial, Office & Shopping, Land Sales, Franchise — updated every Thursday.' },
  { icon: FileSpreadsheet, title: 'Take it with you', text: 'Export exactly the properties you found to Excel, or open the weekly Insider Report as a PDF.' }
];

const DISCIPLINES = [
  { icon: Store, name: 'Retail' },
  { icon: Trees, name: 'Land' },
  { icon: Building, name: 'Multi-Family' },
  { icon: Factory, name: 'Industrial' },
  { icon: Briefcase, name: 'Office Space' },
  { icon: Hotel, name: 'Hotel | Motel' }
];

const SERVICES = [
  {
    icon: Database,
    title: 'Online Database',
    text: 'More than 10,000 intensively researched properties reside in our up-to-date environment; disciplines include Multi-Family, Office, Retail, Industrial, Small Retail, Land and Hotel-Motels. Online entries reflect approximately 10 years of research data, and other Databank files can go back 20 years or more upon request. More than 100 fields of information are included in each file — owner, seller, price paid, number of units or square footage, loan information, broker information and much more.'
  },
  {
    icon: Newspaper,
    title: 'Weekly Reports',
    text: 'Databank staff pores over more than 100 key commercial real-estate sales from most counties in the state of Georgia. From that extensive database, priority transactions are published in printed or emailed versions and delivered to Databank clients. No transaction is published until it has been extensively analyzed by Databank\u2019s experienced staff, and every transaction in the weekly reports is uploaded to the online database the same week.'
  },
  {
    icon: Microscope,
    title: 'Custom Research',
    text: 'Through more than 50 years of specialized research, Databank staff members add their years of metro Atlanta knowledge to produce custom studies and other research for the specific needs of clients. Databank staff members have an average of 25 years of experience with metro Atlanta commercial real-estate information.'
  },
  {
    icon: LandPlot,
    title: 'Land Comparison',
    text: 'Land sales are researched and categorized by their projected uses. More than 3,000 land-sale transactions reside in this online file. Each land sale is originally published in Databank\u2019s weekly Land Insider report.'
  }
];

const CUSTOMERS = [
  'Ackerman Co.', 'Bull Realty', 'Greystone-Brown Realty Advisors', 'Cocke-Finkelstein', 'Grandbridge R.E. Capital',
  'Lavista Associates', 'Lee & Associates', 'The Shopping Center Group', 'Thomson Reuters'
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
        page: 'contact'
      });
      setState('sent');
    } catch {
      setState('error');
    }
  };

  if (state === 'sent') {
    return (
      <div className="flex items-center gap-3 text-green-700 bg-green-50 border border-green-200 rounded-xl p-5">
        <CheckCircle className="w-6 h-6 shrink-0" />
        <p>Thanks — your message is on its way to the Databank team. We'll reply to {form.email}.</p>
      </div>
    );
  }

  const input = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b1f5c]/40';
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
      <button type="submit" disabled={state === 'sending'} className="inline-flex items-center gap-2 bg-[#0b1f5c] text-white font-semibold px-5 py-2.5 rounded-lg hover:bg-[#122a7a] disabled:opacity-50">
        {state === 'sending' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />} Send message
      </button>
    </form>
  );
}

export default function Home({ onStart }: Props) {
  return (
    <div className="space-y-14">
      <section className="relative rounded-2xl overflow-hidden shadow-xl min-h-[340px] sm:min-h-[420px] flex items-end">
        <img src="/atl-skyline.jpg" alt="Atlanta skyline" className="absolute inset-0 w-full h-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0b1f5c]/90 via-[#0b1f5c]/40 to-transparent" />
        <div className="relative p-6 sm:p-10 text-white max-w-2xl">
          <p className="uppercase tracking-[0.3em] text-xs sm:text-sm text-blue-200 mb-3">Databank Atlanta · since 1970</p>
          <h1 className="text-3xl sm:text-5xl font-bold leading-tight mb-4">Atlanta's Leader in Commercial Real-Estate Insights</h1>
          <p className="text-blue-100 text-base sm:text-lg mb-2">
            Fifty years of observing, studying and reporting on Atlanta commercial real estate — now searchable in one place.
          </p>
          <p className="uppercase tracking-widest text-xs text-blue-200 mb-6">Investors · Brokers · Developers · Appraisers</p>
          <button
            onClick={onStart}
            className="inline-flex items-center gap-2 bg-white text-[#0b1f5c] font-semibold px-6 py-3 rounded-xl shadow hover:bg-blue-50"
          >
            <Search className="w-5 h-5" /> Search the database
          </button>
        </div>
      </section>

      <MarketPulse onStart={onStart} />

      <section className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
          <div key={title} className="bg-white rounded-xl shadow p-5">
            <Icon className="w-6 h-6 text-[#0b1f5c] mb-3" />
            <h3 className="font-semibold text-gray-900 mb-1">{title}</h3>
            <p className="text-sm text-gray-600">{text}</p>
          </div>
        ))}
      </section>

      <section id="services" className="scroll-mt-24">
        <div className="relative rounded-2xl overflow-hidden shadow-lg min-h-[200px] flex items-center mb-8">
          <img src="/services-banner.jpg" alt="" className="absolute inset-0 w-full h-full object-cover" />
          <div className="absolute inset-0 bg-[#0b1f5c]/70" />
          <div className="relative p-6 sm:p-10 text-white">
            <p className="uppercase tracking-[0.3em] text-xs text-blue-200 mb-2">Services</p>
            <h2 className="text-2xl sm:text-4xl font-bold">Knowledge… it is Databank's only service</h2>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
          {DISCIPLINES.map(({ icon: Icon, name }) => (
            <div key={name} className="bg-white rounded-xl shadow p-4 flex flex-col items-center text-center gap-2 hover:shadow-md transition">
              <span className="w-11 h-11 rounded-full bg-blue-50 text-[#0b1f5c] flex items-center justify-center"><Icon className="w-5 h-5" /></span>
              <span className="text-sm font-semibold text-gray-800">{name}</span>
            </div>
          ))}
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          {SERVICES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="bg-white rounded-2xl shadow p-6 sm:p-8">
              <div className="flex items-center gap-3 mb-3">
                <span className="w-10 h-10 rounded-lg bg-[#0b1f5c] text-white flex items-center justify-center"><Icon className="w-5 h-5" /></span>
                <h3 className="text-xl font-bold text-gray-900">{title}</h3>
              </div>
              <p className="text-gray-700 leading-relaxed text-sm sm:text-base">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white rounded-2xl shadow p-6 sm:p-10 grid md:grid-cols-[auto,1fr] gap-8 items-start">
        <img src="/alan-wexler.jpg" alt="Alan Wexler, President & CEO" className="w-32 h-32 sm:w-40 sm:h-40 rounded-full object-cover shadow mx-auto md:mx-0" />
        <div>
          <p className="uppercase tracking-widest text-xs text-gray-500 mb-1">From the President</p>
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Alan Wexler, President & CEO</h2>
          <div className="space-y-3 text-gray-700 leading-relaxed">
            <p>
              Databank was founded in 1970 to provide pertinent data on the real estate market to the businesses and firms directly
              involved with that industry. Real estate activity, whether from development or sales, involves the proper analysis of
              needs, timing and location of product and programs.
            </p>
            <p>
              Databank is the leading source for Brokers, Appraisers, Owners, Lenders, Attorneys and other businesses related to the
              Atlanta real estate market. Before you make a decision on your next deal, make sure your homework is complete by letting
              Databank do it for you.
            </p>
          </div>
        </div>
      </section>

      <section className="text-center">
        <p className="uppercase tracking-widest text-xs text-gray-500 mb-4">Valued customers</p>
        <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-12 opacity-80 mb-6">
          <img src="/client-1.png" alt="" className="h-8 sm:h-10 w-auto" />
          <img src="/client-2.png" alt="JLL" className="h-8 sm:h-10 w-auto" />
          <img src="/client-3.png" alt="" className="h-8 sm:h-10 w-auto" />
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {CUSTOMERS.map((c) => (
            <span key={c} className="px-3 py-1.5 rounded-full bg-white shadow-sm border border-gray-200 text-xs sm:text-sm font-medium text-gray-700 uppercase tracking-wide">{c}</span>
          ))}
        </div>
      </section>

      <section id="contact" className="scroll-mt-24 grid lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl shadow p-6 sm:p-8">
          <p className="uppercase tracking-widest text-xs text-gray-500 mb-1">Get in touch</p>
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Contact Databank</h2>
          <ContactForm />
        </div>
        <div className="rounded-2xl overflow-hidden shadow flex flex-col">
          <iframe
            title="Databank office — 3108 Piedmont Road, Suite 235, Atlanta, GA 30305"
            src={MAP_SRC}
            className="w-full flex-1 min-h-[280px] border-0"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allowFullScreen
          />
          <div className="bg-[#0b1f5c] text-white p-5 grid sm:grid-cols-3 gap-4">
            <div className="flex gap-3">
              <MapPin className="w-5 h-5 mt-0.5 text-blue-200 shrink-0" />
              <div>
                <p className="font-semibold text-sm">Atlanta, Georgia</p>
                <p className="text-blue-100 text-xs">3108 Piedmont Road, Suite 235<br />Atlanta, GA 30305</p>
              </div>
            </div>
            <div className="flex gap-3">
              <Phone className="w-5 h-5 mt-0.5 text-blue-200 shrink-0" />
              <div>
                <p className="font-semibold text-sm">Office</p>
                <a href="tel:+14048728880" className="text-blue-100 text-xs hover:text-white">(404) 872-8880</a>
              </div>
            </div>
            <div className="flex gap-3">
              <Printer className="w-5 h-5 mt-0.5 text-blue-200 shrink-0" />
              <div>
                <p className="font-semibold text-sm">Fax</p>
                <p className="text-blue-100 text-xs">(404) 872-0231</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
