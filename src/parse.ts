import { LedgerLine, LedgerType, LineKind, Statement, StatementLine } from './types.js';
import { parseAmount, parseDate, refKeys, refsInText, round2 } from './normalize.js';

/** Minimal RFC 4180 CSV parser (quoted fields, commas and quotes inside quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); if (row.some(f => f.trim() !== '')) rows.push(row); }
  const [head, ...body] = rows;
  const keys = head.map(h => h.trim().toLowerCase());
  return body.map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const KIND: Record<LedgerType, LineKind> = {
  OB: 'opening', INV: 'document', CN: 'document', AGINV: 'document', AGCN: 'document', PAYIN: 'payment', PAYOUT: 'payment',
};

export function parseLedger(csv: string): LedgerLine[] {
  return parseCsv(csv).map((r, i) => {
    const type = r.doc_type.toUpperCase() as LedgerType;
    if (!(type in KIND)) throw new Error(`Ledger row ${i + 2}: unknown doc_type "${r.doc_type}"`);
    const amount = parseAmount(r.amount);
    return {
      id: `L${String(i + 1).padStart(2, '0')}`,
      date: parseDate(r.date),
      docNo: r.doc_no,
      type,
      kind: KIND[type],
      jobNo: r.job_no ?? '',
      appliesTo: (r.applies_to ?? '').split(';').map(s => s.trim()).filter(Boolean),
      description: r.description ?? '',
      currency: r.currency || 'EUR',
      amount,
      amountBase: r.amount_usd ? parseAmount(r.amount_usd) : amount,
      rate: r.usd_rate ? Number(r.usd_rate) : 1,
      keys: refKeys(r.doc_no),
    };
  });
}

/** Classify a statement line from its wording. */
function kindOf(description: string): LineKind {
  const d = description.toLowerCase();
  if (/brought forward|opening balance|b\/f|balance forward/.test(d)) return 'opening';
  if (/payment|remittance|receipt|received|paid/.test(d)) return 'payment';
  return 'document';
}

export function toStatementLine(i: number, date: string, reference: string, description: string, debit: number, credit: number): StatementLine {
  const kind = kindOf(description);
  const refs = reference ? [reference] : kind === 'payment' ? refsInText(description) : [];
  return {
    id: `S${String(i + 1).padStart(2, '0')}`,
    date, reference, description, debit, credit,
    amount: round2(credit - debit), // agent debit = we owe them = negative for us
    kind,
    keys: refs.flatMap(refKeys),
  };
}

export function parseStatementCsv(csv: string, meta: { agent: string; currency: string; periodEnd?: string }): Statement {
  const rows = parseCsv(csv);
  const lines = rows.map((r, i) => toStatementLine(i, parseDate(r.date), r.reference ?? '', r.description ?? '', parseAmount(r.debit), parseAmount(r.credit)));
  const periodEnd = meta.periodEnd ?? lines.map(l => l.date).sort().at(-1)!;
  return { agent: meta.agent, currency: meta.currency, periodEnd, closingAgentView: null, lines, extraction: { method: 'csv', checks: [] } };
}

/**
 * Deterministic parser for a printed statement (PDF text). It does not trust column positions:
 * the running balance column tells whether each amount is a debit or a credit.
 */
export function parseStatementText(text: string): Statement {
  const all = text.split(/\r?\n/);
  const agent = titleCase(all.find(l => l.trim())?.trim() ?? 'Agent');
  const currency = text.match(/Currency:\s*([A-Z]{3})/)?.[1] ?? 'EUR';
  const period = text.match(/Period:\s*([\d.]+)\s*-\s*([\d.]+)/);
  const closingMatch = text.match(/Closing balance[^\n]*?(-?[\d.,]+)\s*$/m);
  const lines: StatementLine[] = [];
  const checks: string[] = [];
  let prev: number | null = null;
  for (const raw of all) {
    const m = raw.match(/^(\d{2}\.\d{2}\.\d{4})\s+(.*)$/);
    if (!m) continue;
    const date = parseDate(m[1]);
    const nums = [...m[2].matchAll(/-?\d{1,3}(?:,\d{3})*\.\d{2}/g)];
    if (!nums.length) continue;
    const balance = parseAmount(nums.at(-1)![0]);
    const amount = nums.length >= 2 ? parseAmount(nums.at(-2)![0]) : balance;
    let debit = 0, credit = 0;
    if (prev === null) debit = balance >= 0 ? amount : 0, credit = balance < 0 ? Math.abs(amount) : 0;
    else if (round2(prev + amount) === balance) debit = amount;
    else if (round2(prev - amount) === balance) credit = amount;
    else throw new Error(`Line ${m[1]}: amount ${amount} does not explain the running balance ${prev} → ${balance}`);
    prev = balance;
    const rest = m[2].slice(0, nums.at(nums.length >= 2 ? -2 : -1)!.index).trimEnd();
    const parts = rest.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
    const looksLikeRef = (s: string) => /\d/.test(s) && !/\s/.test(s) && /^[A-Z]/.test(s);
    const reference = parts.length > 1 && looksLikeRef(parts[0]) ? parts.shift()! : '';
    lines.push(toStatementLine(lines.length, date, reference, parts.join(' '), debit, credit));
  }
  const closing = closingMatch ? parseAmount(closingMatch[1]) : null;
  if (closing !== null) {
    const movement = round2(lines.reduce((s, l) => s + l.debit - l.credit, 0));
    if (movement !== closing) throw new Error(`Parsed lines total ${movement}, statement says closing ${closing}`);
    checks.push(`Line total ${movement} equals the printed closing balance ${closing}`);
  }
  checks.push('Every amount reconciles to the running balance column');
  return {
    agent, currency,
    periodEnd: period ? parseDate(period[2]) : lines.map(l => l.date).sort().at(-1)!,
    closingAgentView: closing,
    lines,
    extraction: { method: 'text-parser', checks },
  };
}

const SUFFIX: Record<string, string> = { GMBH: 'GmbH', LTD: 'Ltd', LLC: 'LLC', BV: 'B.V.', SA: 'S.A.', AG: 'AG', AS: 'A.S.', INC: 'Inc' };
/** "NORDHAFEN LOGISTIK GMBH" → "Nordhafen Logistik GmbH"; mixed-case names are left alone. */
export function titleCase(name: string): string {
  if (name !== name.toUpperCase()) return name;
  return name.split(/\s+/).map(w => SUFFIX[w.replace(/\./g, '')] ?? w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
}

export function parseFx(csv: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of parseCsv(csv)) m.set(`${r.currency}:${r.date}`, Number(r.usd_per_unit));
  return m;
}
