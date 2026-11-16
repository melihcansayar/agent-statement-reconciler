// One reconciliation run: read inputs, reconcile, write the outputs. Used by the CLI, the MCP server and the schedule.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Audit } from './audit.js';
import { parseFx, parseLedger, parseStatementCsv } from './parse.js';
import { readStatement, writeNarrative, Narrative } from './llm.js';
import { reconcile, defaultOptions } from './engine.js';
import { exceptionsCsv, journalsCsv, toHtml, toMarkdown } from './report.js';
import { ReconResult } from './types.js';

export interface RunInput { ledger: string; statement: string; fx?: string; out?: string; agent?: string; currency?: string; periodEnd?: string }
export interface RunOutput { result: ReconResult; narrative: Narrative; files: string[]; audit: Audit }

export async function run(input: RunInput): Promise<RunOutput> {
  const out = input.out ?? 'out';
  mkdirSync(out, { recursive: true });
  const audit = new Audit(join(out, 'audit.jsonl'));
  audit.log('start', { input: { ...input } });

  const ledger = parseLedger(audit.input(input.ledger));
  const raw = audit.input(input.statement);
  const statement = input.statement.toLowerCase().endsWith('.csv')
    ? parseStatementCsv(raw, { agent: input.agent ?? 'Agent', currency: input.currency ?? ledger[0]?.currency ?? 'EUR', periodEnd: input.periodEnd })
    : await readStatement(raw, audit);

  const opt = defaultOptions(statement.agent, statement.currency);
  if (input.fx) {
    const fx = parseFx(audit.input(input.fx));
    opt.closingRate = fx.get(`${statement.currency}:${statement.periodEnd}`);
  }
  const result = reconcile(ledger, statement, opt);
  result.runId = audit.runId;
  for (const g of result.groups) audit.log('decision', { group: g.id, status: g.status, rule: g.rule, confidence: g.confidence, exception: g.exception, ledger: g.ledger, statement: g.statement, effect: g.effect, reason: g.reason });
  audit.log('balance-proof', { ledgerClosing: result.ledgerClosing, statementClosing: result.statementClosing, difference: result.difference, explained: result.explained, unexplained: result.unexplained });
  for (const j of result.journals) audit.log('journal-proposed', { journal: j.id, memo: j.memo, lines: j.lines, status: j.status });

  const narrative = await writeNarrative(result, audit);
  const files: [string, string][] = [
    ['report.html', toHtml(result, narrative)],
    ['report.md', toMarkdown(result, narrative)],
    ['exceptions.csv', exceptionsCsv(result)],
    ['proposed-journals.csv', journalsCsv(result)],
    ['agent-email.txt', narrative.email + '\n'],
    ['result.json', JSON.stringify({ ...result, narrative }, null, 2)],
  ];
  for (const [name, body] of files) writeFileSync(join(out, name), body);
  audit.log('done', { files: files.map(f => f[0]), unexplained: result.unexplained });
  return { result, narrative, files: [...files.map(f => join(out, f[0])), join(out, 'audit.jsonl')], audit };
}
