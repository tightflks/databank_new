// Contact-level PII that a security review (Sep 25) flagged: the bulk property list was
// sending it to any trial account in one request, when nothing about search, sorting or the
// results table actually reads these — only the property page's Contacts section does, from
// the archive (/api/dropbox/report), a completely separate, per-property endpoint. Built from
// the real column list in a current weekly file, keyed by exact name so a generic phone/street
// pattern can't accidentally also strip the property's own address (the "P ..." columns).
const SENSITIVE_COLUMNS = new Set([
  // Phone / fax, every party prefix (O=owner, S=seller, B=broker, L=lender, C L=construction
  // lender, 2ND OWNER, LEASING, MANAGEMENT) plus the standalone ATTORNEY PHONE / FAX columns.
  'O PHONE', 'O PHONE2 FAX', 'S PHONE', 'S PHONE2 FAX', 'B PHONE', 'B PHONE2 FAX', 'BROKER PHONE',
  'L PHONE', 'L PHONE2 FAX', 'C L PHONE', 'C L PHONE2 FAX', 'LEASING PHONE', 'LEASING PHONE2',
  'MANAGEMENT PHONE', 'MANAGEMENT PHONE2 FAX', '2ND OWNER PHONE', '2ND OWNER PHONE2 FAX',
  'ATTORNEY PHONE', 'FAX',
  // Individual rep names, every party prefix.
  'O REP', 'O REP2', 'B REP', 'B REP2', 'S REP', 'S REP2', 'L REP', 'L REP2', 'C L REP', 'C L REP2',
  'LEASING REP', 'LEASING REP2', 'MANAGEMENT REP', 'MANAGEMENT REP2', '2ND OWNER REP', '2ND OWNER REP2',
  // Mailing addresses, every party prefix — the property's own address (the "P ..." columns)
  // is a different, separate set of columns and is never in this list.
  'O STREET NAME', 'O STREET NUMBER', 'O CITY', 'O STATE', 'O ZIP', 'O SUITE NUMBER', 'O P O BOX NUMBER',
  'B STREET NAME', 'B STREET NUMBER', 'B CITY', 'B STATE', 'B ZIP', 'B SUITE NUMBER', 'B P O BOX NUMBER',
  'S STREET NAME', 'S STREET NUMBER', 'S CITY', 'S STATE', 'S ZIP', 'S SUITE NUMBER', 'S P O BOX NUMBER',
  'L STREET NAME', 'L STREET NUMBER', 'L CITY', 'L STATE', 'L ZIP', 'L SUITE NUMBER', 'L P O BOX NUMBER',
  'C L STREET NAME', 'C L STREET NUMBER', 'C L CITY', 'C L STATE', 'C L ZIP', 'C L SUITE NUMBER', 'C L P O BOX NUMBER',
  'LEASING STREET NAME', 'LEASING STREET NUMBER', 'LEASING CITY', 'LEASING STATE', 'LEASING ZIP', 'LEASING SUITE NUMBER', 'LEASING P O BOX NUMBER',
  'MANAGEMENT STREET NAME', 'MANAGEMENT STREET NUMBER', 'MANAGEMENT CITY', 'MANAGEMENT STATE', 'MANAGEMENT ZIP', 'MANAGEMENT SUITE NUMBER', 'MANAGEMENT P O BOX NUMBER',
  '2ND OWNER STREET NAME', '2ND OWNER STREET NUMBER', '2ND OWNER CITY', '2ND OWNER STATE', '2ND OWNER ZIP', '2ND OWNER SUITE NUMBER', '2ND OWNER P O BOX NUMBER',
  // Financing specifics beyond the loan amount already shown on the property page.
  'EQUITY', 'PERCENTAGE EQUITY', 'DOWNPAYMENT', 'PERCENTAGE DOWNPAYMENT', 'YEARLY INCOME', 'ASSUMED LOAN',
  'LOAN PER SQ FT', 'C LOAN PER SQ FT', 'LOAN START DATE', 'LOAN COMPLETE DATE', 'LOAN TERMS',
  'C LOAN START DATE', 'C LOAN COMPLETE DATE', 'C LOAN TERMS', 'FORECLOSURE DATE', 'FORECLOSED PRICE',
  'EXISTING PERMANENT LOAN', 'EXISTING CONSTRUCITON LOAN', 'PURCHASE NOTE', 'PURCHASE NOTE START DATE', 'PURCHASE NOTE DUE DATE',
  // Attorney and a named point-of-contact field. ATTENTION/ATTENTION2 are deliberately NOT
  // included here — UserDashboard.tsx's name search matches against them (nameMatch), so
  // stripping them would silently break "find by attention line" searches for a name that's
  // no more sensitive than the OWNER field already shown.
  'ATTORNEY', 'KEY PLAYER',
  'UNDERLYING', 'FORECLOSURE PRICE',
]);

// Reflex names the same column differently from file to file ("O PHONE2\FAX" vs "O PHONE2 FAX",
// "$ EQUITY" / "% EQUITY" vs "EQUITY"), so names are compared with everything but letters and
// digits removed, and any phone/fax column or loan date/second-loan column is caught by pattern.
const normColumn = (h: unknown) => String(h ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const SENSITIVE_NORMALIZED = new Set([...SENSITIVE_COLUMNS].map(normColumn));
const SENSITIVE_PATTERN = /PHONE|FAX|LOAN\d*(START|COMPLETE|DUE)DATE|LOAN\d/;
export function isSensitiveColumn(header: unknown): boolean {
  const n = normColumn(header);
  return SENSITIVE_NORMALIZED.has(n) || SENSITIVE_PATTERN.test(n);
}

// Strips SENSITIVE_COLUMNS from a header+rows array (mutating neither; returns new arrays),
// keeping every remaining column's position stable relative to each other so nothing downstream
// that looks columns up by name (not by fixed index) needs to change.
export function stripSensitiveColumns(data: unknown[][]): unknown[][] {
  if (data.length === 0) return data;
  const header = data[0] as string[];
  const keepIdx = header.map((h, i) => (isSensitiveColumn(h) ? -1 : i)).filter((i) => i >= 0);
  return data.map((row) => keepIdx.map((i) => row[i]));
}
