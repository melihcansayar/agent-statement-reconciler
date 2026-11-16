import { ReconResult } from './types.js';
import { Narrative } from './llm.js';
import { fmt } from './normalize.js';

const LABEL: Record<string, string> = {
  AMOUNT_DIFFERENCE: 'Amount difference', BANK_CHARGE: 'Bank charges', DUPLICATE_IN_STATEMENT: 'Duplicate on statement',
  MISSING_IN_LEDGER: 'Not in our ledger', MISSING_IN_STATEMENT: 'Not on agent statement', IN_TRANSIT: 'In transit (timing)',
};

function rows(r: ReconResult) {
  const L = new Map(r.ledger.map(l => [l.id, l])), S = new Map(r.statement.lines.map(s => [s.id, s]));
  return r.groups.map(g => ({
    g,
    ledger: g.ledger.map(id => L.get(id)!).map(l => `${l.docNo} ${fmt(l.amount)}`).join(' + ') || '—',
    statement: g.statement.map(id => S.get(id)!).map(s => `${s.reference || s.description.slice(0, 28)} ${fmt(s.amount)}`).join(' + ') || '—',
  }));
}

export function toMarkdown(r: ReconResult, n: Narrative): string {
  const ex = rows(r).filter(x => x.g.status === 'exception');
  const ok = rows(r).filter(x => x.g.status === 'matched');
  return [
    `# Agent statement reconciliation – ${r.agent}`,
    `Period end ${r.periodEnd} · ${r.currency} · run ${r.runId} · statement read by **${r.statement.extraction.method}**`,
    '',
    '## Summary',
    n.summary,
    '',
    '## Balance proof (our sign: + agent owes us)',
    '| | Amount |', '|---|---:|',
    `| Our ledger | ${fmt(r.ledgerClosing)} |`,
    `| Agent statement | ${fmt(r.statementClosing)} |`,
    `| Difference | ${fmt(r.difference)} |`,
    `| Explained by exceptions | ${fmt(r.explained)} |`,
    `| **Unexplained** | **${fmt(r.unexplained)}** |`,
    '',
    `## Exceptions (${ex.length})`,
    '| # | Type | Ledger | Statement | Effect | Why | Action |', '|---|---|---|---|---:|---|---|',
    ...ex.map(x => `| ${x.g.id} | ${LABEL[x.g.exception!]} | ${x.ledger} | ${x.statement} | ${fmt(x.g.effect)} | ${x.g.reason} | ${x.g.action ?? ''} |`),
    '',
    `## Proposed journals (${r.journals.length}) – nothing is posted without approval`,
    ...r.journals.flatMap(j => [`**${j.id}** ${j.date} – ${j.memo}`, ...j.lines.map(l => `- ${l.debit ? 'Dr' : 'Cr'} ${l.account}  ${l.currency} ${fmt(l.debit || l.credit)}`), '']),
    `## Matched automatically (${ok.length})`,
    '| # | Rule | Confidence | Ledger | Statement |', '|---|---|---|---|---|',
    ...ok.map(x => `| ${x.g.id} | ${x.g.rule} | ${x.g.confidence} | ${x.ledger} | ${x.statement} |`),
    '',
    '## Draft email to the agent',
    '```', n.email, '```',
    '',
    '## Statement checks',
    ...r.statement.extraction.checks.map(c => `- ${c}`),
  ].join('\n');
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function toHtml(r: ReconResult, n: Narrative): string {
  const ex = rows(r).filter(x => x.g.status === 'exception');
  const ok = rows(r).filter(x => x.g.status === 'matched');
  const ties = r.unexplained === 0;
  const tone: Record<string, string> = { AMOUNT_DIFFERENCE: 'warn', BANK_CHARGE: 'info', DUPLICATE_IN_STATEMENT: 'warn', MISSING_IN_LEDGER: 'bad', MISSING_IN_STATEMENT: 'warn', IN_TRANSIT: 'muted' };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reconciliation – ${esc(r.agent)} – ${r.periodEnd}</title>
<style>
:root{--ink:#14202e;--muted:#5b6b7e;--line:#e3e8ef;--bg:#f5f7fa;--card:#fff;--navy:#11283f;--orange:#e8641c;--green:#1f8a4c;--red:#c2352b;--amber:#b7791f;--blue:#2563c9}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:var(--navy);color:#fff;padding:28px 40px}header h1{margin:0 0 6px;font-size:24px}header p{margin:0;color:#b9c7d6;font-size:13px}
main{max-width:1180px;margin:0 auto;padding:28px 24px 60px;display:grid;gap:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 24px}
h2{margin:0 0 14px;font-size:17px}.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.kpi{border:1px solid var(--line);border-radius:12px;padding:14px}.kpi b{display:block;font-size:22px}.kpi span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.tie{display:flex;align-items:center;gap:12px;margin-top:14px;padding:12px 16px;border-radius:10px;font-weight:600}
.tie.ok{background:#e8f6ee;color:var(--green)}.tie.no{background:#fdecea;color:var(--red)}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.badge{display:inline-block;padding:3px 9px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap}
.warn{background:#fdf3e1;color:var(--amber)}.bad{background:#fdecea;color:var(--red)}.info{background:#e8f0fc;color:var(--blue)}.muted{background:#eef1f5;color:var(--muted)}.good{background:#e8f6ee;color:var(--green)}
.j{border:1px dashed var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px}.j small{color:var(--orange);font-weight:700}
pre{white-space:pre-wrap;background:#f7f9fb;border:1px solid var(--line);border-radius:10px;padding:16px;font:13px/1.55 ui-monospace,Menlo,Consolas,monospace}
details summary{cursor:pointer;font-weight:600}.foot{color:var(--muted);font-size:12px}
@media(max-width:800px){.kpis{grid-template-columns:repeat(2,1fr)}header{padding:22px}}
</style></head><body>
<header><h1>Agent statement reconciliation – ${esc(r.agent)}</h1><p>Period end ${r.periodEnd} · ${r.currency} · statement read by ${r.statement.extraction.method}${r.statement.extraction.model ? ` (${esc(r.statement.extraction.model)})` : ''} · run ${r.runId}</p></header>
<main>
<section class="card"><h2>Balance proof <span class="foot">(our sign: + agent owes us)</span></h2>
<div class="kpis">
<div class="kpi"><span>Our ledger</span><b>${fmt(r.ledgerClosing)}</b></div>
<div class="kpi"><span>Agent statement</span><b>${fmt(r.statementClosing)}</b></div>
<div class="kpi"><span>Difference</span><b>${fmt(r.difference)}</b></div>
<div class="kpi"><span>Matched automatically</span><b>${ok.length} / ${r.groups.length}</b></div>
<div class="kpi"><span>Unexplained</span><b>${fmt(r.unexplained)}</b></div>
</div>
<div class="tie ${ties ? 'ok' : 'no'}">${ties ? '✓ The difference is fully explained by the exceptions below.' : '✗ Part of the difference is not explained. Review before closing.'}</div>
<p style="margin:14px 0 0">${esc(n.summary)}</p></section>
<section class="card"><h2>Exceptions for review (${ex.length})</h2><table><thead><tr><th>#</th><th>Type</th><th>Ledger</th><th>Statement</th><th>Effect</th><th>Why</th><th>Action</th></tr></thead><tbody>
${ex.map(x => `<tr><td>${x.g.id}</td><td><span class="badge ${tone[x.g.exception!]}">${LABEL[x.g.exception!]}</span></td><td>${esc(x.ledger)}</td><td>${esc(x.statement)}</td><td class="n">${fmt(x.g.effect)}</td><td>${esc(x.g.reason)}</td><td>${esc(x.g.action ?? '')}</td></tr>`).join('\n')}
</tbody></table></section>
<section class="card"><h2>Proposed journals (${r.journals.length}) – nothing is posted without approval</h2>
${r.journals.map(j => `<div class="j"><small>${j.id} · ${j.status.toUpperCase()}</small><div><b>${j.date}</b> – ${esc(j.memo)}</div><table><tbody>${j.lines.map(l => `<tr><td>${l.debit ? 'Dr' : 'Cr'}</td><td>${esc(l.account)}</td><td class="n">${l.currency} ${fmt(l.debit || l.credit)}</td></tr>`).join('')}</tbody></table></div>`).join('\n')}
${r.fx ? `<p class="foot">FX: agent balance revalued at ${r.fx.rate} ${r.fx.baseCurrency}/${r.currency}; booked ${r.fx.baseCurrency} ${fmt(r.fx.bookedBase)} → ${fmt(r.fx.revaluedBase)}.</p>` : ''}</section>
<section class="card"><h2>Draft email to the agent <span class="badge ${n.method === 'llm' ? 'info' : 'muted'}">${n.method === 'llm' ? 'written by Claude, checked' : 'template'}</span></h2><pre>${esc(n.email)}</pre></section>
<section class="card"><details><summary>Matched automatically (${ok.length})</summary><table><thead><tr><th>#</th><th>Rule</th><th>Confidence</th><th>Ledger</th><th>Statement</th></tr></thead><tbody>
${ok.map(x => `<tr><td>${x.g.id}</td><td>${x.g.rule}</td><td><span class="badge ${x.g.confidence === 'high' ? 'good' : 'warn'}">${x.g.confidence}</span></td><td>${esc(x.ledger)}</td><td>${esc(x.statement)}</td></tr>`).join('\n')}
</tbody></table></details></section>
<section class="card"><h2>Controls</h2><ul>${r.statement.extraction.checks.map(c => `<li>${esc(c)}</li>`).join('')}<li>Every match records the rule that made it; medium-confidence matches are flagged.</li><li>Journals are proposals only; the agent has no write access to the ledger.</li><li>Full audit trail in <code>audit.jsonl</code> with input file hashes.</li></ul></section>
<p class="foot">Sample data. Generated by agent-statement-reconciler.</p>
</main></body></html>`;
}

export function exceptionsCsv(r: ReconResult): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return ['group,type,ledger,statement,effect,reason,action', ...rows(r).filter(x => x.g.status === 'exception')
    .map(x => [x.g.id, x.g.exception, q(x.ledger), q(x.statement), x.g.effect.toFixed(2), q(x.g.reason), q(x.g.action ?? '')].join(','))].join('\n') + '\n';
}

export function journalsCsv(r: ReconResult): string {
  return ['journal,date,account,debit,credit,currency,memo,status', ...r.journals.flatMap(j => j.lines.map(l =>
    [j.id, j.date, `"${l.account}"`, l.debit.toFixed(2), l.credit.toFixed(2), l.currency, `"${j.memo.replace(/"/g, '""')}"`, j.status].join(',')))].join('\n') + '\n';
}
