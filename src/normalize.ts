// Reference and number normalisation. Deterministic, no AI.

/** Parse "1,234.56", "1.234,56", "-300.00" or "" into a number (2 dp). */
export function parseAmount(raw: string | undefined): number {
  if (!raw) return 0;
  let s = raw.trim().replace(/\s/g, '');
  if (!s) return 0;
  const neg = /^-|\(.*\)$/.test(s);
  s = s.replace(/[()\-+]/g, '');
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Not an amount: "${raw}"`);
  return round2(neg ? -n : n);
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** dd.mm.yyyy, dd/mm/yyyy or yyyy-mm-dd → yyyy-mm-dd */
export function parseDate(raw: string): string {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  throw new Error(`Not a date: "${raw}"`);
}

export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * Turn a document reference into comparison keys.
 * "HAM/24/0121", "HAM-24-121" and "ham 24 0121" share a key; "AEF2610051" and "AEF-2610-051" share another.
 * Two keys are produced: groups with leading zeros stripped, and all characters concatenated.
 */
export function refKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  const up = raw.toUpperCase().trim();
  if (!/\d/.test(up)) return [];
  const groups = up.split(/[^A-Z0-9]+/).filter(Boolean);
  const stripped = groups.map(g => (/^\d+$/.test(g) ? String(Number(g)) : g)).join('-');
  const joined = groups.join('');
  return [...new Set([`G:${stripped}`, `J:${joined}`])];
}

export const sharesKey = (a: string[], b: string[]) => a.some(k => b.includes(k));

/** Find invoice-like references inside free text, e.g. "Payment to Aegean, your invoice AEF-2610-044". */
export function refsInText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b[A-Z]{2,5}(?:[-/ ]?[A-Z]{0,3})?[-/ ]?\d{2,4}[-/ ]?\d{1,6}\b/g)) out.push(m[0]);
  return out;
}

export const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
