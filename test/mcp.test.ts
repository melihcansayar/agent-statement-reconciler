import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('MCP server exposes the tools and reconciles the sample', async () => {
  const env = { ...process.env } as Record<string, string>;
  delete env.ANTHROPIC_API_KEY;
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp-server.ts'], env });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(tools, ['draft_agent_email', 'explain_item', 'reconcile_statement']);
  const out = mkdtempSync(join(tmpdir(), 'recon-'));
  const res = await client.callTool({ name: 'reconcile_statement', arguments: { ledger: 'data/sample/ledger.csv', statement: 'data/sample/agent-statement-hamburg.txt', fx: 'data/sample/fx-rates.csv', out } });
  const body = JSON.parse((res.content as { text: string }[])[0].text);
  assert.equal(body.balanceProof.unexplained, 0);
  assert.equal(body.exceptions.length, 6);
  const ex = await client.callTool({ name: 'explain_item', arguments: { id: 'S08' } });
  assert.match((ex.content as { text: string }[])[0].text, /DUPLICATE_IN_STATEMENT/);
  await client.close();
});
