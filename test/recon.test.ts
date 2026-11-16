import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAmount, refKeys, sharesKey } from '../src/normalize.js';
import { parseLedger, parseStatementCsv, parseStatementText } from '../src/parse.js';
import { reconcile, defaultOptions } from '../src/engine.js';
import { writeNarrative } from '../src/llm.js';
import { Audit } from '../src/audit.js';

const read = (p: string) => readFileSync(new URL(`../data/sample/${p}`, import.meta.url), 'utf8');
const ledger = parseLedger(read('ledger.csv'));
const text = read('agent-statement-hamburg.txt');

test('references in different formats share a key', () => {
  assert.ok(sharesKey(refKeys('HAM/24/0121'), refKeys('HAM-24-121')));
  assert.ok(sharesKey(refKeys('AEF2610051'), refKeys('AEF-2610-051')));
  assert.ok(sharesKey(refKeys('AEF-2610-44'), refKeys('AEF-2610-044')));
  assert.ok(!sharesKey(refKeys('HAM-24-0121'), refKeys('HAM-24-0127')));
});

test('amounts in US and European formats', () => {
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('(300.00)'), -300);
  assert.equal(parseAmount(''), 0);
});

test('printed statement: debit or credit is read from the running balance, and the total must equal the closing balance', () => {
  const s = parseStatementText(text);
  assert.equal(s.lines.length, 14);
  assert.equal(s.closingAgentView, 380);
  assert.equal(s.agent, 'Nordhafen Logistik GmbH');
  const pay = s.lines.find(l => l.description.startsWith('Payment received, Aegean'))!;
  assert.equal(pay.credit, 4200);
  assert.throws(() => parseStatementText(text.replace('380.00\n\nPlease', '480.00\n\nPlease')), /closing/);
});

test('the sample reconciles with every difference explained', () => {
  const s = parseStatementText(text);
  const r = reconcile(ledger, s, { ...defaultOptions(s.agent, s.currency), closingRate: 1.0796 });
  assert.equal(r.ledgerClosing, 2995);
  assert.equal(r.statementClosing, -380);
  assert.equal(r.difference, 3375);
  assert.equal(r.unexplained, 0);
  const types = r.groups.filter(g => g.exception).map(g => g.exception).sort();
  assert.deepEqual(types, ['AMOUNT_DIFFERENCE', 'BANK_CHARGE', 'DUPLICATE_IN_STATEMENT', 'IN_TRANSIT', 'MISSING_IN_LEDGER', 'MISSING_IN_STATEMENT']);
  assert.equal(r.groups.find(g => g.exception === 'BANK_CHARGE')!.effect, 25);
  const split = r.groups.find(g => g.rule === 'payment-applied-documents' && g.status === 'matched')!;
  assert.equal(split.statement.length, 2, 'one payment settles two statement lines');
  assert.equal(r.groups.find(g => g.rule === 'payment-amount-date')!.confidence, 'medium');
  assert.equal(r.journals.length, 3);
  assert.ok(r.journals.every(j => j.status.startsWith('proposed')));
  for (const j of r.journals) assert.equal(j.lines.reduce((s, l) => s + l.debit - l.credit, 0), 0, `${j.id} balances`);
});

test('CSV and printed statements give the same result', () => {
  const a = parseStatementText(text);
  const b = parseStatementCsv(read('agent-statement-hamburg.csv'), { agent: a.agent, currency: 'EUR', periodEnd: '2026-10-31' });
  const opt = defaultOptions(a.agent, 'EUR');
  const ra = reconcile(ledger, a, opt), rb = reconcile(ledger, b, opt);
  assert.deepEqual(ra.groups.map(g => [g.status, g.exception, g.effect]), rb.groups.map(g => [g.status, g.exception, g.effect]));
});

test('the email to the agent lists every item the agent must act on, and nothing that is only ours', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const s = parseStatementText(text);
  const r = reconcile(ledger, s, defaultOptions(s.agent, s.currency));
  const n = await writeNarrative(r, new Audit());
  for (const ref of ['HAM-24-0123', 'HAM/24/0127', 'HAM/24/0129', 'AEF-CN-2610-007']) assert.ok(n.email.includes(ref), ref);
  assert.ok(!n.email.includes('RCV-1018'), 'bank charges are internal');
});
