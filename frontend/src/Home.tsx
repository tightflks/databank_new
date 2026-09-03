import { Search, Clock, Building2, FileSpreadsheet, MapPin, Phone, Printer } from 'lucide-react';

interface Props {
  onStart: () => void;
}

const HIGHLIGHTS = [
  { icon: Search, title: 'Ask in plain English', text: '"Apartments in Cobb over $5M sold this year" — misspellings and old property names included.' },
  { icon: Clock, title: 'Full property history', text: 'Who owned it, what it sold for, when it changed hands or changed names — one record per property.' },
  { icon: Building2, title: 'Five databases', text: 'Apartments, Industrial, Office & Shopping, Land Sales, Franchise — updated every Thursday.' },
  { icon: FileSpreadsheet, title: 'Take it with you', text: 'Export exactly the properties you found to Excel, or open the weekly Insider Report as a PDF.' }
];

export default function Home({ onStart }: Props) {
  return (
    <div className="space-y-12">
      <section className="relative rounded-2xl overflow-hidden shadow-xl min-h-[340px] sm:min-h-[420px] flex items-end">
        <img src="/atl-skyline.jpg" alt="Atlanta skyline" className="absolute inset-0 w-full h-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0b1f5c]/90 via-[#0b1f5c]/40 to-transparent" />
        <div className="relative p-6 sm:p-10 text-white max-w-2xl">
          <p className="uppercase tracking-[0.3em] text-xs sm:text-sm text-blue-200 mb-3">Databank Atlanta · since 1970</p>
          <h1 className="text-3xl sm:text-5xl font-bold leading-tight mb-4">Atlanta's Leader in Commercial Real-Estate Insights</h1>
          <p className="text-blue-100 text-base sm:text-lg mb-6">
            Fifty years of observing, studying and reporting on Atlanta commercial real estate — now searchable in one place.
          </p>
          <button
            onClick={onStart}
            className="inline-flex items-center gap-2 bg-white text-[#0b1f5c] font-semibold px-6 py-3 rounded-xl shadow hover:bg-blue-50"
          >
            <Search className="w-5 h-5" /> Search the database
          </button>
        </div>
      </section>

      <section className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
          <div key={title} className="bg-white rounded-xl shadow p-5">
            <Icon className="w-6 h-6 text-[#0b1f5c] mb-3" />
            <h3 className="font-semibold text-gray-900 mb-1">{title}</h3>
            <p className="text-sm text-gray-600">{text}</p>
          </div>
        ))}
      </section>

      <section className="bg-white rounded-2xl shadow p-6 sm:p-10 grid md:grid-cols-[auto,1fr] gap-8 items-start">
        <img src="/alan-wexler.jpg" alt="Alan Wexler, President & CEO" className="w-32 h-32 sm:w-40 sm:h-40 rounded-full object-cover shadow mx-auto md:mx-0" />
        <div>
          <p className="uppercase tracking-widest text-xs text-gray-500 mb-1">Knowledge… it is Databank's only service</p>
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
        <p className="uppercase tracking-widest text-xs text-gray-500 mb-4">Valued customers include</p>
        <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-12 opacity-80">
          <img src="/client-1.png" alt="" className="h-8 sm:h-10 w-auto" />
          <img src="/client-2.png" alt="JLL" className="h-8 sm:h-10 w-auto" />
          <img src="/client-3.png" alt="" className="h-8 sm:h-10 w-auto" />
        </div>
      </section>

      <section className="bg-[#0b1f5c] text-white rounded-2xl shadow p-6 sm:p-10 grid sm:grid-cols-3 gap-6">
        <div className="flex gap-3">
          <MapPin className="w-5 h-5 mt-0.5 text-blue-200 shrink-0" />
          <div>
            <p className="font-semibold">Location</p>
            <p className="text-blue-100 text-sm">3108 Piedmont Road, Suite 235<br />Atlanta, GA 30305</p>
          </div>
        </div>
        <div className="flex gap-3">
          <Phone className="w-5 h-5 mt-0.5 text-blue-200 shrink-0" />
          <div>
            <p className="font-semibold">Office</p>
            <a href="tel:+14048728880" className="text-blue-100 text-sm hover:text-white">(404) 872-8880</a>
          </div>
        </div>
        <div className="flex gap-3">
          <Printer className="w-5 h-5 mt-0.5 text-blue-200 shrink-0" />
          <div>
            <p className="font-semibold">Fax</p>
            <p className="text-blue-100 text-sm">(404) 872-0231</p>
          </div>
        </div>
      </section>
    </div>
  );
}
