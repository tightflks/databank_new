import { Fragment, useState } from 'react';
import { ChevronDown, ChevronUp, History, X } from 'lucide-react';
import { Detail } from './PropertyHistory';
import { fmtDate, fmtValue } from './utils/fmt';

// ---------- What customers can ask ----------
//
// "now" questions run on this week's file of the selected database (structured filters).
// "history" questions run on the cross-week Dropbox archive (every weekly file since 2022).

type Example = { q: string; history?: boolean };
type Group = { title: string; examples: Example[] };

const CATALOGUE: Group[] = [
  {
    title: 'Where',
    examples: [
      { q: 'Apartments in Fulton County' },
      { q: 'Everything in Alpharetta' },
      { q: 'Properties in Midtown' },
      { q: 'Sales in zip 30309' },
      { q: 'What sold on Peachtree' },
      { q: 'Properties in land lot 17' },
    ],
  },
  {
    title: 'When',
    examples: [
      { q: 'Sales since January 2026' },
      { q: 'Published in the last 60 days' },
      { q: 'Sold between 2023 and 2024' },
      { q: 'Land sales in 2025' },
      { q: 'Anything with an asking price' },
    ],
  },
  {
    title: 'Price & size',
    examples: [
      { q: 'Sales between $5M and $20M' },
      { q: 'Under $150k per unit' },
      { q: 'Over $200 per square foot' },
      { q: 'More than 200 units' },
      { q: 'Buildings over 100,000 sq ft' },
      { q: 'Land over 10 acres' },
      { q: 'Built after 2015' },
      { q: 'Loans over $10M' },
    ],
  },
  {
    title: 'Who',
    examples: [
      { q: 'Everything owned by Cortland' },
      { q: 'What did Novare sell' },
      { q: 'Anything Wood Partners touched' },
      { q: 'Who owns the most in Buckhead' },
      { q: 'Brokered by CBRE' },
      { q: 'Financed by Wells Fargo' },
      { q: 'Foreclosures' },
    ],
  },
  {
    title: 'One property, over time',
    examples: [
      { q: 'Who owned 1000 Belmont before?', history: true },
      { q: 'When did Skyhouse Midtown last sell and for how much?', history: true },
      { q: 'Sale history of parcel 17 0106 LL0158', history: true },
      { q: 'What changed on The Jane Atlanta since 2024?', history: true },
      { q: 'Who bought Lodge at Saint Moritz?', history: true },
    ],
  },
  {
    title: 'A company, over time',
    examples: [
      { q: 'Everything Fannie Mae has bought or sold since 2022', history: true },
      { q: 'What has Cortland acquired over the years', history: true },
      { q: 'Who bought the most apartments since 2024?', history: true },
      { q: 'Most active sellers in Cobb this year', history: true },
    ],
  },
  {
    title: 'Market changes',
    examples: [
      { q: 'Properties that sold more than once since 2023', history: true },
      { q: 'What was added to the database this year', history: true },
      { q: 'What dropped off the list in 2026', history: true },
      { q: 'Sale price changes in Fulton since June', history: true },
      { q: 'Ownership changes in DeKalb this year', history: true },
    ],
  },
];

export function AskCatalogue({ onPick }: { onPick: (q: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button onClick={() => setOpen(!open)} className="text-xs font-medium text-indigo-700 hover:text-indigo-900 flex items-center gap-1">
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        What can I ask?
      </button>
      {open && (
        <div className="mt-2 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {CATALOGUE.map((g) => (
            <div key={g.title}>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">{g.title}</div>
              <div className="flex flex-wrap gap-1.5">
                {g.examples.map((e) => (
                  <button
                    key={e.q}
                    onClick={() => onPick(e.q)}
                    title={e.history ? 'Answered from every weekly file since 2022' : "Answered from this week's file"}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      e.history
                        ? 'bg-amber-50 border-amber-200 text-amber-900 hover:bg-amber-100'
                        : 'bg-white border-indigo-200 text-indigo-800 hover:bg-indigo-100'
                    }`}
                  >
                    {e.history && <History className="w-3 h-3 inline -mt-0.5 mr-1" />}
                    {e.q}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="text-xs text-gray-500 md:col-span-2 lg:col-span-3">
            <History className="w-3 h-3 inline -mt-0.5 mr-1" />
            amber = uses the archive of every weekly file (owners, sales and changes over time); white = this week's list.
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- History answers ----------

export type Trail = { week: string; value: string }[];
export type Sale = { week: string; date: string; price: string; seller: string; buyer: string };
export type AskItem = {
  id: string; name: string; address: string; city: string; county: string; parcel: string;
  first: string; last: string; removed: boolean; owner: string; saleDate: string; salePrice: string; size: string;
  ownerTrail: Trail; saleList: Sale[]; role?: string;
};
export type RankedEntity = { name: string; count: number; properties: string[] };
export type HistoryAnswer = {
  type: string;
  question: string;
  weeks: number;
  firstWeek: string | null;
  latestWeek: string | null;
  after: string | null;
  before: string | null;
  total: number;
  items: (AskItem | RankedEntity)[];
  note?: string;
  subject?: string;
  entity?: string;
  field?: string | null;
};

const TITLES: Record<string, string> = {
  property_history: 'Property history',
  entity_history: 'Bought or sold by',
  repeat_sales: 'Sold more than once',
  changes: 'Records that changed',
  new: 'Added to the database',
  removed: 'Dropped off the list',
  top_buyers: 'Most active buyers',
  top_sellers: 'Most active sellers',
};

const TH = 'px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap';
const TD = 'px-3 py-2 text-sm text-gray-800 whitespace-nowrap max-w-xs overflow-hidden text-ellipsis';

function isRanked(x: AskItem | RankedEntity): x is RankedEntity {
  return 'count' in x;
}

function period(a: HistoryAnswer) {
  if (a.after || a.before) return `${a.after ? fmtDate(a.after) : '…'} → ${a.before ? fmtDate(a.before) : 'now'}`;
  return `${fmtDate(a.firstWeek)} → ${fmtDate(a.latestWeek)}`;
}

export function HistoryResults({ answer, onClose }: { answer: HistoryAnswer; onClose: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const what = answer.subject || answer.entity || answer.field || '';

  return (
    <div className="mb-6 bg-white border border-amber-200 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 bg-amber-50 border-b border-amber-200">
        <History className="w-5 h-5 text-amber-700" />
        <h3 className="font-bold text-gray-800">{TITLES[answer.question] ?? answer.question}{what ? `: ${what}` : ''}</h3>
        <span className="text-xs text-gray-600">
          {answer.total.toLocaleString('en-US')} result{answer.total === 1 ? '' : 's'} · {period(answer)} · {answer.weeks} weekly files
        </span>
        <button onClick={onClose} className="ml-auto text-gray-500 hover:text-gray-800" title="Close"><X className="w-4 h-4" /></button>
      </div>
      {answer.note && <div className="px-4 py-3 text-sm text-amber-800">{answer.note}</div>}
      {open && <Detail type={answer.type} id={open} onClose={() => setOpen(null)} />}

      {answer.items.length > 0 && isRanked(answer.items[0]) ? (
        <table className="min-w-full divide-y divide-gray-100">
          <thead className="bg-gray-50"><tr>{['#', answer.question === 'top_buyers' ? 'Buyer' : 'Seller', 'Properties'].map((h) => <th key={h} className={TH}>{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-gray-100">
            {(answer.items as RankedEntity[]).map((e, i) => (
              <tr key={e.name}>
                <td className={TD}>{i + 1}</td>
                <td className={`${TD} font-medium`} title={e.name}>{e.name}</td>
                <td className={TD}>
                  {e.count}
                  <span className="ml-2 text-xs">
                    {e.properties.map((id) => (
                      <button key={id} onClick={() => setOpen(id)} className="text-blue-600 hover:underline mr-2">{id}</button>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr>{['Property', 'Address', 'City', 'County', 'Owner now', 'Owners', 'Sales', 'Last sale', 'Price', answer.question === 'entity_history' ? 'Role' : 'Since', ''].map((h, i) => <th key={i} className={TH}>{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(answer.items as AskItem[]).map((p) => (
                <Fragment key={p.id}>
                  <tr className={`hover:bg-amber-50 cursor-pointer ${p.removed ? 'text-gray-400 italic' : ''}`} onClick={() => setExpanded(expanded === p.id ? null : p.id)}>
                    <td className={`${TD} font-medium`} title={p.name}>{p.name || '(unnamed)'}</td>
                    <td className={TD}>{p.address}</td>
                    <td className={TD}>{p.city}</td>
                    <td className={TD}>{p.county}</td>
                    <td className={TD} title={p.owner}>{p.owner}</td>
                    <td className={TD}>{p.ownerTrail.length}</td>
                    <td className={TD}>{p.saleList.length}</td>
                    <td className={`${TD} font-mono text-xs`}>{p.saleDate}</td>
                    <td className={TD}>{fmtValue('SALE PRICE', p.salePrice)}</td>
                    <td className={TD}>{answer.question === 'entity_history' ? p.role : p.first.slice(0, 7)}</td>
                    <td className={TD}><button onClick={(e) => { e.stopPropagation(); setOpen(p.id); }} className="text-blue-600 hover:underline text-xs">Full record</button></td>
                  </tr>
                  {expanded === p.id && (
                    <tr className="bg-amber-50/40">
                      <td colSpan={11} className="px-4 py-3">
                        <div className="grid md:grid-cols-2 gap-4 text-sm">
                          <div>
                            <div className="text-xs font-semibold text-gray-500 uppercase mb-1">Owners</div>
                            {p.ownerTrail.length === 0 && <div className="text-gray-400">—</div>}
                            {p.ownerTrail.map((o, i) => (
                              <div key={i} className="flex gap-3"><span className="font-mono text-xs text-gray-500 w-24">{o.week === p.first ? `by ${o.week.slice(0, 7)}` : fmtDate(o.week)}</span><span>{o.value}</span></div>
                            ))}
                          </div>
                          <div>
                            <div className="text-xs font-semibold text-gray-500 uppercase mb-1">Sales</div>
                            {p.saleList.length === 0 && <div className="text-gray-400">—</div>}
                            {p.saleList.map((s, i) => (
                              <div key={i} className="flex flex-wrap gap-x-3">
                                <span className="font-mono text-xs text-gray-500 w-24">{s.date}</span>
                                <span className="font-medium">{fmtValue('SALE PRICE', s.price)}</span>
                                <span className="text-gray-600">{s.seller ? `${s.seller} → ` : ''}{s.buyer}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {answer.items.length === 0 && !answer.note && (
                <tr><td colSpan={11} className="px-3 py-8 text-center text-gray-400">Nothing matched in the archive.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
