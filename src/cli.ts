#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { run } from './run.js';
import { fmt } from './normalize.js';

const { values } = parseArgs({ options: {
  ledger: { type: 'string' }, statement: { type: 'string' }, fx: { type: 'string' }, out: { type: 'string', default: 'out' },
  agent: { type: 'string' }, currency: { type: 'string' }, 'period-end': { type: 'string' },
} });
if (!values.ledger || !values.statement) {
  console.error('Usage: npm run reconcile -- --ledger ledger.csv --statement statement.(txt|csv) [--fx fx-rates.csv] [--out out]');
  process.exit(2);
}
const { result: r, narrative, files } = await run({ ...(values as { ledger: string; statement: string }), periodEnd: values['period-end'] });
const ex = r.groups.filter(g => g.status === 'exception');
console.log(`\n${r.agent} · ${r.currency} · statement to ${r.periodEnd} · read by ${r.statement.extraction.method}`);
console.log(`Ledger ${fmt(r.ledgerClosing)} | Statement ${fmt(r.statementClosing)} | Difference ${fmt(r.difference)} | Unexplained ${fmt(r.unexplained)}`);
console.log(`${r.groups.length - ex.length} matched, ${ex.length} exceptions, ${r.journals.length} journals proposed, narrative: ${narrative.method}\n`);
for (const g of ex) console.log(`  ${g.id}  ${g.exception!.padEnd(22)} ${fmt(g.effect).padStart(10)}  ${g.reason}`);
console.log(`\nWrote:\n${files.map(f => '  ' + f).join('\n')}\n`);
process.exit(r.unexplained === 0 ? 0 : 1);
