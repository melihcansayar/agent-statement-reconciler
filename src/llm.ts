// The AI layer. Claude reads messy statements and writes the human parts (commentary, the email to the agent).
// It never decides a match and never posts anything: every AI output is validated before it is used,
// and every call is written to the audit log. Without ANTHROPIC_API_KEY the agent falls back to
// deterministic code, so the demo always runs.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ReconResult, Statement } from './types.js';
import { parseStatementText, toStatementLine } from './parse.js';
import { fmt, parseDate, round2 } from './normalize.js';
import { Audit } from './audit.js';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
const client = () => (process.env.ANTHROPIC_API_KEY ? new Anthropic() : null);
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const LineSchema = z.object({
  date: z.string(), reference: z.string(), description: z.string(),
  debit: z.number().nonnegative(), credit: z.number().nonnegative(),
});
const StatementSchema = z.object({
  agent: z.string(), currency: z.string().length(3), period_end: z.string(),
  closing_balance: z.number().describe('As printed. Positive when the customer owes the agent.'),
  lines: z.array(LineSchema).min(1),
});

/** Read a statement in any layout. Claude extracts; code checks the arithmetic before anything is used. */
export async function readStatement(text: string, audit: Audit): Promise<Statement> {
  const c = client();
  if (!c) {
    const s = parseStatementText(text);
    audit.log('extract', { method: 'text-parser', lines: s.lines.length, checks: s.extraction.checks });
    return s;
  }
  const tool = {
    name: 'record_statement',
    description: 'Record every line of the agent statement exactly as printed. Do not compute, merge or skip lines.',
    input_schema: z.toJSONSchema(StatementSchema) as Anthropic.Tool.InputSchema,
  };
  const msg = await c.messages.create({
    model: MODEL, max_tokens: 4000, tool_choice: { type: 'tool', name: tool.name }, tools: [tool],
    system: 'You extract accounting data. Copy references and amounts exactly. Dates as yyyy-mm-dd. Debit and credit as printed by the agent (non-negative numbers). The opening balance is a line.',
    messages: [{ role: 'user', content: `Extract this statement of account:\n\n${text}` }],
  });
  const use = msg.content.find(b => b.type === 'tool_use');
  const parsed = StatementSchema.safeParse(use && 'input' in use ? use.input : null);
  const checks: string[] = [];
  const reject = (why: string) => {
    audit.log('extract-rejected', { model: MODEL, promptHash: sha(text), why });
    const s = parseStatementText(text);
    s.extraction.checks.unshift(`AI extraction rejected (${why}); used the deterministic parser`);
    return s;
  };
  if (!parsed.success) return reject('output did not match the schema');
  const d = parsed.data;
  const movement = round2(d.lines.reduce((s, l) => s + l.debit - l.credit, 0));
  if (movement !== round2(d.closing_balance)) return reject(`lines total ${movement} ≠ printed closing ${d.closing_balance}`);
  checks.push(`AI-extracted lines total ${fmt(movement)}, equal to the printed closing balance`);
  audit.log('extract', { method: 'llm', model: MODEL, promptHash: sha(text), lines: d.lines.length, checks, usage: msg.usage });
  return {
    agent: d.agent, currency: d.currency, periodEnd: parseDate(d.period_end), closingAgentView: d.closing_balance,
    lines: d.lines.map((l, i) => toStatementLine(i, parseDate(l.date), l.reference, l.description, l.debit, l.credit)),
    extraction: { method: 'llm', model: MODEL, checks },
  };
}

export interface Narrative { summary: string; email: string; method: 'llm' | 'template' }

/** Commentary for the reviewer and a draft email to the agent. Facts come only from the reconciliation result. */
export async function writeNarrative(r: ReconResult, audit: Audit, company = 'Aegean Express Forwarding'): Promise<Narrative> {
  const facts = factsFor(r);
  const c = client();
  if (c) {
    try {
      const msg = await c.messages.create({
        model: MODEL, max_tokens: 1500,
        system: 'You are a careful accounts assistant. Use only the facts given. Do not invent amounts, dates or references. Plain, polite business English.',
        messages: [{ role: 'user', content: `Facts (JSON):\n${JSON.stringify(facts, null, 2)}\n\nWrite two parts separated by a line "---EMAIL---":\n1) A 4-6 sentence summary for the finance reviewer: whether the reconciliation ties, what needs action, what is timing only.\n2) An email from ${company} accounts to the agent listing ONLY the items the agent must act on, each with reference and amount, asking for a reply by a date 5 working days after the period end. Sign as "Accounts team, ${company}".` }],
      });
      const text = msg.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');
      const [summary, email] = text.split('---EMAIL---').map(s => s.trim());
      const missing = facts.agentItems.filter(i => !email?.includes(i.reference));
      if (summary && email && !missing.length) {
        audit.log('narrative', { method: 'llm', model: MODEL, usage: msg.usage });
        return { summary, email, method: 'llm' };
      }
      audit.log('narrative-rejected', { model: MODEL, why: missing.length ? `email misses ${missing.map(m => m.reference).join(', ')}` : 'missing a part' });
    } catch (e) {
      audit.log('narrative-error', { model: MODEL, error: String(e) });
    }
  }
  const t = template(r, facts, company);
  audit.log('narrative', { method: 'template' });
  return t;
}

function factsFor(r: ReconResult) {
  const line = (id: string) => r.ledger.find(l => l.id === id) ?? r.statement.lines.find(s => s.id === id)!;
  const ref = (id: string) => { const x = line(id) as { docNo?: string; reference?: string }; return x.docNo ?? x.reference ?? id; };
  const items = r.groups.filter(g => g.status === 'exception').map(g => ({
    type: g.exception!, reference: [...g.ledger, ...g.statement].map(ref).filter(Boolean)[0] ?? g.id,
    effect: g.effect, reason: g.reason, action: g.action,
  }));
  const forAgent = new Set(['AMOUNT_DIFFERENCE', 'DUPLICATE_IN_STATEMENT', 'MISSING_IN_LEDGER', 'MISSING_IN_STATEMENT']);
  return {
    agent: r.agent, currency: r.currency, periodEnd: r.periodEnd,
    ledgerClosing: r.ledgerClosing, statementClosing: r.statementClosing, difference: r.difference, unexplained: r.unexplained,
    matched: r.groups.filter(g => g.status === 'matched').length,
    exceptions: items,
    agentItems: items.filter(i => forAgent.has(i.type)),
  };
}

function template(r: ReconResult, f: ReturnType<typeof factsFor>, company: string): Narrative {
  const ties = r.unexplained === 0;
  const timing = f.exceptions.filter(e => e.type === 'IN_TRANSIT');
  const summary = [
    `${r.agent}, ${r.currency}, statement to ${r.periodEnd}: ${f.matched} items matched automatically and ${f.exceptions.length} need attention.`,
    `Our ledger shows ${fmt(r.ledgerClosing)} and the agent's statement ${fmt(r.statementClosing)} (our sign); the ${fmt(r.difference)} difference is ${ties ? 'fully explained by the items below' : `NOT fully explained: ${fmt(r.unexplained)} remains`}.`,
    `${f.agentItems.length} item(s) need the agent's action, ${r.journals.length} journal(s) are proposed for approval${timing.length ? `, and ${timing.length} item(s) are timing only` : ''}.`,
  ].join(' ');
  const lines = f.agentItems.map(i => {
    const amt = fmt(Math.abs(i.effect));
    switch (i.type) {
      case 'AMOUNT_DIFFERENCE': return `- ${i.reference}: we booked a different amount (difference ${r.currency} ${amt}). Please send a credit note or the supporting calculation.`;
      case 'DUPLICATE_IN_STATEMENT': return `- ${i.reference}: appears twice on your statement (${r.currency} ${amt}). Please reverse the duplicate.`;
      case 'MISSING_IN_LEDGER': return `- ${i.reference}: we have no record of this invoice (${r.currency} ${amt}). Please send a copy with the job reference and proof of delivery.`;
      case 'MISSING_IN_STATEMENT': return `- ${i.reference}: our ${/CN/.test(i.reference) ? 'credit note' : 'invoice'} (${r.currency} ${amt}) is not on your statement. Please book it; a copy is attached.`;
      default: return `- ${i.reference}: ${i.reason}`;
    }
  });
  const due = new Date(Date.parse(r.periodEnd) + 7 * 86_400_000).toISOString().slice(0, 10);
  const email = [
    `Subject: Statement reconciliation ${r.periodEnd} – ${lines.length} open item(s)`,
    '',
    `Dear ${r.agent} accounts team,`,
    '',
    `Thank you for your statement of account to ${r.periodEnd}. We reconciled it with our ledger and need your help with the following:`,
    '',
    ...lines,
    '',
    ...(timing.length ? [`For information: our payment ${timing.map(t => t.reference).join(', ')} was sent just before the statement date and should appear on your next statement.`, ''] : []),
    `Could you reply by ${due}? Thank you.`,
    '',
    `Best regards,`,
    `Accounts team, ${company}`,
  ].join('\n');
  return { summary, email, method: 'template' };
}
