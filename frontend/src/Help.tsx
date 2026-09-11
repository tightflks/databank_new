import { useEffect, useState, type ReactNode } from 'react';
import { BookOpen, Loader2 } from 'lucide-react';

// Renders docs/walkthrough.md (served from /help/ via the public folder) as the
// site's handbook. Small purpose-built markdown subset: headings, paragraphs,
// bullets, numbered lists, tables, images, block quotes, <details>, hr, and
// inline **bold**, *italic*, `code`, [links](...).

const DOC_URL = '/help/walkthrough.md';

function slug(text: string) {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/ /g, '-');
}

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|(?<!\*)\*(?!\*)[^*]+\*(?!\*))/g;
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
    if (s.startsWith('### ')) { const t = s.slice(4); nodes.push(<h3 key={k++} id={slug(t)} className="text-lg font-semibold text-gray-800 mt-8 mb-3 scroll-mt-20">{inline(t)}</h3>); i++; continue; }
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

export function Help() {
  const [md, setMd] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(DOC_URL)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(setMd)
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    if (!md) return;
    const id = window.location.hash.replace(/^#help\/?/, '');
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
  }, [md]);

  return (
    <div className="max-w-4xl mx-auto bg-white rounded-2xl shadow-lg px-6 sm:px-10 py-8">
      <div className="flex items-center gap-2 text-sm text-[#0b1f5c] font-semibold uppercase tracking-wide mb-4">
        <BookOpen className="w-4 h-4" /> Handbook
      </div>
      {error && <p className="text-gray-600">The handbook could not be loaded. Please refresh the page.</p>}
      {!md && !error && <div className="flex items-center gap-2 text-gray-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}
      {md && <article>{render(md)}</article>}
    </div>
  );
}

export default Help;
