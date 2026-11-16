// MCP server: lets Claude (Desktop, Code or any MCP client) run the reconciliation as a tool and reason over the result.
// The tools only read inputs and write report files. There is no tool that posts to a ledger.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { run, RunOutput } from './run.js';

const server = new McpServer({ name: 'agent-statement-reconciler', version: '1.0.0' });
let last: RunOutput | null = null;
const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const need = () => { if (!last) throw new Error('Run reconcile_statement first.'); return last; };

server.registerTool('reconcile_statement', {
  title: 'Reconcile an agent statement',
  description: 'Match an agent or intercompany statement (CSV, or printed text) against the ledger export. Returns the balance proof, the exceptions and the proposed journals. Writes report files; posts nothing.',
  inputSchema: {
    ledger: z.string().describe('Path to the ledger CSV for the agent account'),
    statement: z.string().describe('Path to the agent statement (.csv or .txt)'),
    fx: z.string().optional().describe('Path to FX rates CSV for period-end revaluation'),
    out: z.string().optional().describe('Output folder, default "out"'),
  },
}, async (args) => {
  last = await run(args);
  const r = last.result;
  return text({
    agent: r.agent, periodEnd: r.periodEnd, currency: r.currency, statementReadBy: r.statement.extraction.method,
    balanceProof: { ledger: r.ledgerClosing, statement: r.statementClosing, difference: r.difference, explained: r.explained, unexplained: r.unexplained },
    matched: r.groups.filter(g => g.status === 'matched').length,
    exceptions: r.groups.filter(g => g.status === 'exception').map(g => ({ id: g.id, type: g.exception, effect: g.effect, reason: g.reason, action: g.action })),
    proposedJournals: r.journals.map(j => ({ id: j.id, memo: j.memo, lines: j.lines })),
    files: last.files,
  });
});

server.registerTool('explain_item', {
  title: 'Explain a line or group',
  description: 'Explain how a ledger line (L..), statement line (S..) or group (G..) was matched, by which rule and with what effect.',
  inputSchema: { id: z.string().describe('L01, S07 or G12') },
}, async ({ id }) => {
  const r = need().result;
  const g = r.groups.find(g => g.id === id || g.ledger.includes(id) || g.statement.includes(id));
  if (!g) return text(`No item ${id}`);
  return text({ group: g, ledgerLines: r.ledger.filter(l => g.ledger.includes(l.id)), statementLines: r.statement.lines.filter(s => g.statement.includes(s.id)) });
});

server.registerTool('draft_agent_email', {
  title: 'Draft the email to the agent',
  description: 'Return the draft email listing only the items the agent must act on. It is a draft: a person sends it.',
  inputSchema: {},
}, async () => text(need().narrative.email));

await server.connect(new StdioServerTransport());
