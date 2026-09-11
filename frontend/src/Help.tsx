import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BookOpen, Loader2, Rocket, Search, Sparkles, History, FileText, BarChart3, MessageSquare, HelpCircle, ChevronLeft, ChevronRight, ArrowLeft, type LucideIcon } from 'lucide-react';

// Renders docs/walkthrough.md (served from /help/ via the public folder) as the
// site's handbook. Small purpose-built markdown subset: headings, paragraphs,
// bullets, numbered lists, tables, images, block quotes, <details>, hr, and
// inline **bold**, *italic*, `code`, [links](...).

const DOC_URL = '/help/handbook.md';

// "§9" cross-references in the Markdown become links to that section.
const sectionIndex = new Map<number, { title: string; slug: string }>();
let goToSection: (slug: string) => void = () => undefined;

function slug(text: string) {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/ /g, '-');
}

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|(?<!\*)\*(?!\*)[^*]+\*(?!\*)|§\d+(?![–\d]))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = key;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={i++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={i++} className="px-1 py-0.5 rounded bg-gray-100 text-[0.9em]">{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(t)!;
      const href = mm[2];
      out.push(href.startsWith('#')
        ? <a key={i++} href={href} onClick={(e) => { e.preventDefault(); document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth' }); }} className="text-blue-700 underline">{mm[1]}</a>
        : <a key={i++} href={href} target="_blank" rel="noreferrer" className="text-blue-700 underline">{mm[1]}</a>);
    } else if (t.startsWith('§')) {
      const sec = sectionIndex.get(Number(t.slice(1)));
      out.push(sec
        ? <button key={i++} type="button" onClick={() => goToSection(sec.slug)} className="inline-flex items-center align-baseline mx-0.5 px-1.5 rounded bg-blue-50 text-blue-700 text-[0.85em] font-medium hover:bg-blue-100">{sec.title} →</button>
        : t);
    } else out.push(<em key={i++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function render(md: string): ReactNode[] {
  const lines = md.split('\n');
  const nodes: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const img = (line: string) => {
    const m = /!\[([^\]]*)\]\(([^)]+)\)/.exec(line)!;
    return <img key={k++} src={`/help/${m[2]}`} alt={m[1]} loading="lazy" className="my-4 w-full rounded-xl border border-gray-200 shadow-sm" />;
  };
  while (i < lines.length) {
    const ln = lines[i];
    const s = ln.trim();
    if (!s || s === '---') { i++; continue; }
    if (s.startsWith('# ')) { nodes.push(<h1 key={k++} className="text-3xl font-bold text-gray-900 mb-2">{inline(s.slice(2))}</h1>); i++; continue; }
    if (s.startsWith('## ')) { const t = s.slice(3); nodes.push(<h2 key={k++} id={slug(t)} className="text-2xl font-bold text-[#0b1f5c] mt-12 mb-4 pt-6 border-t border-gray-200 scroll-mt-20">{inline(t)}</h2>); i++; continue; }
    if (s.startsWith('### ')) { const t = s.slice(4); nodes.push(<h3 key={k++} id={slug(t)} className="text-lg font-semibold text-gray-800 mt-8 mb-3 scroll-mt-40">{inline(t)}</h3>); i++; continue; }
    if (s.startsWith('![')) { nodes.push(img(s)); i++; continue; }
    if (s.startsWith('> ')) { nodes.push(<blockquote key={k++} className="my-4 border-l-4 border-[#0b1f5c] bg-blue-50 px-4 py-3 text-gray-800 italic">{inline(s.slice(2))}</blockquote>); i++; continue; }
    if (s.startsWith('<details')) {
      const summary = /<summary>(.*?)<\/summary>/.exec(s)?.[1] ?? 'More';
      const body: ReactNode[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('</details')) {
        const t = lines[i].trim();
        if (t.startsWith('![')) body.push(img(t));
        else if (t) body.push(<p key={k++}>{inline(t)}</p>);
        i++;
      }
      i++;
      nodes.push(<details key={k++} className="my-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2"><summary className="cursor-pointer text-sm font-medium text-gray-700">{summary}</summary>{body}</details>);
      continue;
    }
    if (s.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      const hasHeader = head.some(Boolean);
      nodes.push(
        <div key={k++} className="my-4 overflow-x-auto">
          <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
            {hasHeader && <thead className="bg-gray-100"><tr>{head.map((c, ci) => <th key={ci} className="text-left px-3 py-2 font-semibold text-gray-700">{inline(c)}</th>)}</tr></thead>}
            <tbody>{(hasHeader ? body : rows).map((r, ri) => <tr key={ri} className="border-t border-gray-200 align-top">{r.map((c, ci) => <td key={ci} className={`px-3 py-2 ${ci === 0 ? 'font-medium text-gray-800 whitespace-nowrap' : 'text-gray-700'}`}>{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const listRe = /^(- |\d+\. )/;
    if (listRe.test(s)) {
      const ordered = /^\d+\. /.test(s);
      const items: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        const t = lines[i].trim();
        if (listRe.test(t)) items.push(t.replace(listRe, ''));
        else if (items.length) items[items.length - 1] += ' ' + t;
        else break;
        i++;
      }
      const cls = 'my-3 pl-6 space-y-1.5 text-gray-800';
      nodes.push(ordered
        ? <ol key={k++} className={`${cls} list-decimal`}>{items.map((it, n) => <li key={n}>{inline(it)}</li>)}</ol>
        : <ul key={k++} className={`${cls} list-disc`}>{items.map((it, n) => <li key={n}>{inline(it)}</li>)}</ul>);
      continue;
    }
    const buf: string[] = [s];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#|\||- |\d+\. |!\[|> |---|<)/.test(lines[i].trim())) { buf.push(lines[i].trim()); i++; }
    nodes.push(<p key={k++} className="my-3 text-gray-800 leading-relaxed">{inline(buf.join(' '))}</p>);
  }
  return nodes;
}


interface Section { num: number; title: string; slug: string; subs: { title: string; slug: string }[]; md: string }

interface Topic { id: string; title: string; blurb: string; icon: LucideIcon; nums: number[] }

const TOPICS: Topic[] = [
  { id: 'welcome', title: 'Welcome', blurb: 'What the Research Database is and how to get in', icon: Rocket, nums: [1] },
  { id: 'search', title: 'Search & Filters', blurb: 'The Search screen, quick find, filters, several zip codes', icon: Search, nums: [2, 4] },
  { id: 'ask-ai', title: 'Ask AI', blurb: 'Ask in plain English, get a one-sentence answer', icon: Sparkles, nums: [3] },
  { id: 'properties', title: 'Properties & History', blurb: 'The property card and the clock — every owner and sale', icon: History, nums: [5, 6] },
  { id: 'reports', title: 'Reports & Excel', blurb: 'One-page report, PDF with letterhead, Excel export', icon: FileText, nums: [7] },
  { id: 'dashboard', title: 'Dashboard & Weekly Reports', blurb: 'Market numbers, drill-down, Market Snapshot PDF', icon: BarChart3, nums: [8] },
  { id: 'feedback', title: 'Feedback', blurb: 'Tell us what to fix or add', icon: MessageSquare, nums: [9] },
  { id: 'faq', title: 'FAQ', blurb: 'Quick answers to common questions', icon: HelpCircle, nums: [10] },
];

function parseSections(md: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of md.split('\n')) {
    const h2 = /^## (\d+)\. (.*)$/.exec(line);
    if (h2) {
      cur = { num: Number(h2[1]), title: h2[2], slug: slug(`${h2[1]}. ${h2[2]}`), subs: [], md: '' };
      out.push(cur);
      sectionIndex.set(cur.num, { title: cur.title, slug: cur.slug });
      continue;
    }
    if (!cur) continue;
    const h3 = /^### (.*)$/.exec(line);
    if (h3) cur.subs.push({ title: h3[1].replace(/^"|"$/g, ''), slug: slug(h3[1]) });
    cur.md += line + '\n';
  }
  return out;
}

const NAVY = '#0b1f5c';

export function Help({ onExit }: { onExit?: () => void }) {
  const [md, setMd] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);

  useEffect(() => {
    fetch(DOC_URL)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(setMd)
      .catch(() => setError(true));
  }, []);

  const sections = useMemo(() => (md ? parseSections(md) : []), [md]);
  const topics = useMemo(
    () => TOPICS.map((t) => ({ ...t, sections: sections.filter((s) => t.nums.includes(s.num)) })).filter((t) => t.sections.length),
    [sections],
  );

  const openSection = (sectionSlug: string) => {
    const num = Number(/^(\d+)-/.exec(sectionSlug)?.[1]);
    const t = topics.find((t) => t.nums.includes(num));
    if (t) open(t.id, sectionSlug);
  };
  goToSection = openSection;

  const open = (id: string | null, sectionSlug?: string) => {
    setTopicId(id);
    setPendingSlug(sectionSlug ?? null);
    window.history.replaceState(null, '', id ? `#help/${sectionSlug ?? id}` : '#help');
    if (!sectionSlug) window.scrollTo({ top: 0 });
  };

  // Deep link: #help/<topic-id> or #help/<section-slug>
  useEffect(() => {
    if (!topics.length) return;
    const target = window.location.hash.replace(/^#help\/?/, '');
    if (!target) return;
    const byId = topics.find((t) => t.id === target);
    if (byId) { setTopicId(byId.id); return; }
    const byNum = /^(\d+)-/.exec(target);
    const t = byNum && topics.find((t) => t.nums.includes(Number(byNum[1])));
    if (t) { setTopicId(t.id); setPendingSlug(target); }
  }, [topics]);

  useEffect(() => {
    if (!pendingSlug || !topicId) return;
    requestAnimationFrame(() => document.getElementById(pendingSlug)?.scrollIntoView({ behavior: 'smooth' }));
    setPendingSlug(null);
  }, [pendingSlug, topicId]);

  if (error) return <div className="max-w-4xl mx-auto bg-white rounded-2xl shadow p-8 text-gray-600">The handbook could not be loaded. Please refresh the page.</div>;
  if (!md) return <div className="flex items-center justify-center gap-2 text-gray-500 py-20"><Loader2 className="w-4 h-4 animate-spin" /> Loading handbook…</div>;

  const idx = topics.findIndex((t) => t.id === topicId);
  const topic = idx >= 0 ? topics[idx] : null;

  // ---- Hub: topic cards ----
  if (!topic) {
    return (
      <div className="max-w-6xl mx-auto">
        <div className="relative overflow-hidden rounded-3xl text-white px-8 py-12 sm:py-16 mb-10 text-center shadow-xl" style={{ background: 'linear-gradient(135deg, #0b1f5c 0%, #1e3a8a 60%, #2563eb 100%)' }}>
          <div className="absolute -top-16 -right-16 w-64 h-64 rounded-full bg-white/10" />
          <div className="absolute -bottom-20 -left-10 w-72 h-72 rounded-full bg-white/5" />
          <div className="relative">
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-blue-200 mb-4">
              <BookOpen className="w-4 h-4" /> Handbook
            </div>
            <h1 className="text-3xl sm:text-5xl font-bold tracking-tight">Welcome to the Research Database</h1>
            <p className="mt-4 text-blue-100 max-w-2xl mx-auto text-base sm:text-lg">
              50 years of Atlanta commercial real estate, searchable in plain English. Pick a topic below — each one is a short, illustrated guide.
            </p>
            {onExit && (
              <button onClick={onExit} className="mt-8 inline-flex items-center gap-2 bg-white text-[#0b1f5c] font-semibold px-6 py-3 rounded-full shadow hover:bg-blue-50 transition-colors">
                <Search className="w-4 h-4" /> Open the database
              </button>
            )}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {topics.map((t) => (
            <div key={t.id} className="group bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-xl hover:-translate-y-1 hover:border-[#0b1f5c]/40 transition-all p-6 flex flex-col">
              <button onClick={() => open(t.id)} className="text-left">
                <div className="w-11 h-11 rounded-xl bg-[#0b1f5c]/5 text-[#0b1f5c] flex items-center justify-center mb-3 group-hover:bg-[#0b1f5c] group-hover:text-white transition-colors">
                  <t.icon className="w-5 h-5" />
                </div>
                <h2 className="text-lg font-bold text-gray-900">{t.title}</h2>
                <p className="text-sm text-gray-500 mt-1">{t.blurb}</p>
              </button>
              <ul className="mt-4 space-y-1.5 text-sm">
                {t.sections.map((s) => (
                  <li key={s.slug}>
                    <button onClick={() => open(t.id, s.slug)} className="text-blue-700 hover:underline text-left">{s.title}</button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ---- Topic view: tabs + sidebar + one topic's content ----
  const prev = idx > 0 ? topics[idx - 1] : null;
  const next = idx < topics.length - 1 ? topics[idx + 1] : null;
  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-4 text-sm">
        <button onClick={() => open(null)} className="inline-flex items-center gap-1 text-gray-600 hover:text-[#0b1f5c]"><ArrowLeft className="w-4 h-4" /> All topics</button>
        {onExit && <><span className="text-gray-300">|</span><button onClick={onExit} className="text-gray-600 hover:text-[#0b1f5c]">Back to Search</button></>}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-3 mb-6 -mx-1 px-1">
        {topics.map((t) => (
          <button
            key={t.id}
            onClick={() => open(t.id)}
            className={`shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold border transition-colors ${
              t.id === topic.id ? 'bg-[#0b1f5c] text-white border-[#0b1f5c]' : 'bg-white text-gray-700 border-gray-200 hover:border-[#0b1f5c]/50'
            }`}
          >
            <t.icon className="w-4 h-4" /> {t.title}
          </button>
        ))}
      </div>
      <div className="grid lg:grid-cols-[240px_1fr] gap-6 items-start">
        <aside className="hidden lg:block sticky top-24 bg-white rounded-2xl border border-gray-200 p-4 text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">In this topic</div>
          <ul className="space-y-1">
            {topic.sections.map((s) => (
              <li key={s.slug}>
                <button onClick={() => open(topic.id, s.slug)} className="text-left font-medium text-gray-800 hover:text-[#0b1f5c]">{s.title}</button>
                {s.subs.length > 0 && (
                  <ul className="ml-3 mt-1 space-y-0.5 border-l border-gray-200 pl-3">
                    {s.subs.map((sub) => (
                      <li key={sub.slug}><button onClick={() => open(topic.id, sub.slug)} className="text-left text-gray-500 hover:text-[#0b1f5c]">{sub.title}</button></li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </aside>
        <article className="bg-white rounded-2xl shadow-lg border border-gray-100 px-6 sm:px-10 py-8 min-w-0">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl text-white flex items-center justify-center" style={{ background: NAVY }}><topic.icon className="w-5 h-5" /></div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Topic {idx + 1} of {topics.length}</div>
              <h1 className="text-2xl font-bold text-gray-900">{topic.title}</h1>
            </div>
          </div>
          {topic.sections.map((s) => (
            <section key={s.slug}>
              <h2 id={s.slug} className="text-2xl font-bold text-[#0b1f5c] mt-10 mb-4 pt-6 border-t border-gray-200 scroll-mt-40">{s.title}</h2>
              {render(s.md)}
            </section>
          ))}
          <div className="mt-12 pt-6 border-t border-gray-200 flex justify-between gap-4 text-sm">
            {prev ? <button onClick={() => open(prev.id)} className="inline-flex items-center gap-1 text-[#0b1f5c] font-semibold hover:underline"><ChevronLeft className="w-4 h-4" /> {prev.title}</button> : <span />}
            {next ? <button onClick={() => open(next.id)} className="inline-flex items-center gap-1 text-[#0b1f5c] font-semibold hover:underline">{next.title} <ChevronRight className="w-4 h-4" /></button> : <span />}
          </div>
        </article>
      </div>
    </div>
  );
}

export default Help;
