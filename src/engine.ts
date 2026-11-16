// The reconciliation engine. Deterministic passes, each one recorded as the "rule" on the group it creates.
import { Group, LedgerLine, ProposedJournal, ReconResult, Statement, StatementLine } from './types.js';
import { daysBetween, fmt, round2, sharesKey } from './normalize.js';
import { randomUUID } from 'node:crypto';

export interface Options {
  dateWindowDays: number;      // payments without a reference: same amount within ± days
  inTransitDays: number;       // our payments this close to period end may not have reached the agent yet
  bankChargeMax: number;       // a short receipt up to this amount (and 2%) is treated as bank charges
  accounts: { agent: string; bankCharges: string; costOfSales: string; fx: string };
  baseCurrency: string;
  closingRate?: number;        // statement currency → base currency at period end
}

export const defaultOptions = (agent: string, currency: string): Options => ({
  dateWindowDays: 5,
  inTransitDays: 5,
  bankChargeMax: 50,
  accounts: {
    agent: `Agent account – ${agent} (${currency})`,
    bankCharges: 'Bank charges',
    costOfSales: 'Cost of sales – agent charges',
    fx: 'Unrealised FX gain/loss',
  },
  baseCurrency: 'USD',
});

const sum = (xs: { amount: number }[]) => round2(xs.reduce((s, x) => s + x.amount, 0));

export function reconcile(ledger: LedgerLine[], statement: Statement, opt: Options): ReconResult {
  const groups: Group[] = [];
  const usedL = new Set<string>(), usedS = new Set<string>();
  const freeL = () => ledger.filter(l => !usedL.has(l.id));
  const freeS = () => statement.lines.filter(s => !usedS.has(s.id));
  const add = (g: Omit<Group, 'id' | 'effect' | 'ledger' | 'statement'>, L: LedgerLine[], S: StatementLine[]) => {
    L.forEach(l => usedL.add(l.id)); S.forEach(s => usedS.add(s.id));
    groups.push({ id: `G${String(groups.length + 1).padStart(2, '0')}`, ...g, ledger: L.map(l => l.id), statement: S.map(s => s.id), effect: round2(sum(L) - sum(S)) });
  };

  // 1. Opening balances
  for (const l of freeL().filter(l => l.kind === 'opening')) {
    const s = freeS().find(s => s.kind === 'opening');
    if (!s) continue;
    const ok = l.amount === s.amount;
    add({ status: ok ? 'matched' : 'exception', rule: 'opening-balance', confidence: 'high', exception: ok ? undefined : 'AMOUNT_DIFFERENCE',
      reason: ok ? 'Opening balances agree' : `Opening balance differs: ledger ${fmt(l.amount)}, statement ${fmt(s.amount)}`,
      action: ok ? undefined : 'Agree last month\'s closing balance with the agent first' }, [l], [s]);
  }

  // 2. Documents by reference
  for (const l of freeL().filter(l => l.kind === 'document')) {
    const cands = freeS().filter(s => s.kind === 'document' && sharesKey(l.keys, s.keys));
    if (!cands.length) continue;
    const exact = cands.find(s => s.amount === l.amount);
    if (exact) { add({ status: 'matched', rule: 'document-reference', confidence: 'high', reason: `${l.docNo} found on the statement as ${exact.reference}, amounts agree` }, [l], [exact]); continue; }
    const s = cands[0];
    add({ status: 'exception', rule: 'document-reference', confidence: 'high', exception: 'AMOUNT_DIFFERENCE',
      reason: `${l.docNo}: ledger ${fmt(Math.abs(l.amount))}, agent's statement ${fmt(Math.abs(s.amount))} (difference ${fmt(Math.abs(round2(l.amount - s.amount)))})`,
      action: 'Check the invoice and the agreed rate; ask the agent for a credit note or support for the difference' }, [l], [s]);
  }

  // 3. Payments by the documents they settle (one ledger payment may settle several statement lines)
  for (const l of freeL().filter(l => l.kind === 'payment' && l.appliesTo.length)) {
    const settled = ledger.filter(x => l.appliesTo.includes(x.docNo));
    const keys = [...l.keys, ...settled.flatMap(x => x.keys), ...l.appliesTo.flatMap(a => a.split(/\s+/))];
    const cands = freeS().filter(s => s.kind === 'payment' && sharesKey(keys, s.keys));
    if (!cands.length) continue;
    const diff = round2(sum([l]) - sum(cands));
    const split = cands.length > 1 ? ` (${cands.length} statement lines)` : '';
    if (diff === 0) { add({ status: 'matched', rule: 'payment-applied-documents', confidence: 'high', reason: `${l.docNo} settles ${l.appliesTo.join(', ')}; agent shows the same total${split}` }, [l], cands); continue; }
    const pct = Math.abs(diff) / Math.abs(sum(cands));
    const shortReceipt = l.type === 'PAYIN' && Math.abs(l.amount) < Math.abs(sum(cands));
    if (shortReceipt && Math.abs(diff) <= opt.bankChargeMax && pct <= 0.02) {
      add({ status: 'exception', rule: 'payment-applied-documents', confidence: 'high', exception: 'BANK_CHARGE',
        reason: `Agent paid ${fmt(Math.abs(sum(cands)))}, we received ${fmt(Math.abs(l.amount))}: ${fmt(Math.abs(diff))} kept by the banks`,
        action: 'Book the bank charges (proposed journal); nothing to ask the agent' }, [l], cands);
    } else {
      add({ status: 'exception', rule: 'payment-applied-documents', confidence: 'high', exception: 'AMOUNT_DIFFERENCE',
        reason: `${l.docNo}: ledger ${fmt(Math.abs(l.amount))}, statement ${fmt(Math.abs(sum(cands)))}${split}`,
        action: 'Agree the payment allocation with the agent' }, [l], cands);
    }
  }

  // 4. Payments without a usable reference: same amount, close dates
  for (const l of freeL().filter(l => l.kind === 'payment')) {
    const s = freeS().filter(s => s.kind === 'payment' && s.amount === l.amount && Math.abs(daysBetween(l.date, s.date)) <= opt.dateWindowDays)
      .sort((a, b) => Math.abs(daysBetween(l.date, a.date)) - Math.abs(daysBetween(l.date, b.date)))[0];
    if (s) add({ status: 'matched', rule: 'payment-amount-date', confidence: 'medium', reason: `Same amount ${fmt(Math.abs(l.amount))}, ${Math.abs(daysBetween(l.date, s.date))} day(s) apart; no reference on the statement` }, [l], [s]);
  }

  // 5. Duplicates on the statement
  const matchedS = statement.lines.filter(s => usedS.has(s.id));
  for (const s of freeS()) {
    const twin = matchedS.find(m => m.kind === s.kind && m.amount === s.amount && sharesKey(m.keys, s.keys));
    if (twin) add({ status: 'exception', rule: 'statement-duplicate', confidence: 'high', exception: 'DUPLICATE_IN_STATEMENT',
      reason: `${s.reference} appears twice on the statement (${twin.id} and ${s.id}), ${fmt(Math.abs(s.amount))} each`,
      action: 'Ask the agent to reverse the duplicate line' }, [], [s]);
  }

  // 6. On the statement only
  for (const s of freeS()) {
    const theirInvoice = s.kind === 'document' && s.amount < 0;
    add({ status: 'exception', rule: 'unmatched-statement', confidence: 'high', exception: 'MISSING_IN_LEDGER',
      reason: theirInvoice ? `Agent invoice ${s.reference} (${fmt(Math.abs(s.amount))}) is not in our ledger` : `${s.description} (${fmt(Math.abs(s.amount))}) is not in our ledger`,
      action: theirInvoice ? 'Ask for a copy and check it against the job file; accrual proposed' : 'Find the entry or ask the agent for details' }, [], [s]);
  }

  // 7. In our ledger only
  for (const l of freeL()) {
    const late = l.type === 'PAYOUT' && daysBetween(l.date, statement.periodEnd) <= opt.inTransitDays;
    add({ status: 'exception', rule: 'unmatched-ledger', confidence: late ? 'medium' : 'high', exception: late ? 'IN_TRANSIT' : 'MISSING_IN_STATEMENT',
      reason: late ? `${l.docNo} paid on ${l.date}, ${daysBetween(l.date, statement.periodEnd)} day(s) before the statement date` : `${l.docNo} (${fmt(Math.abs(l.amount))}) is not on the agent's statement`,
      action: late ? 'Timing only; confirm it appears on next month\'s statement' : (l.type === 'CN' ? 'Send the credit note to the agent and ask them to book it' : 'Send the document to the agent') }, [l], []);
  }

  const ledgerClosing = sum(ledger);
  const statementClosing = sum(statement.lines);
  const difference = round2(ledgerClosing - statementClosing);
  const explained = round2(groups.reduce((s, g) => s + g.effect, 0));
  const result: ReconResult = {
    runId: randomUUID(), agent: statement.agent, currency: statement.currency, periodEnd: statement.periodEnd,
    ledgerClosing, statementClosing, difference, explained, unexplained: round2(difference - explained),
    groups, journals: [], ledger, statement,
  };
  result.journals = proposeJournals(result, opt);
  return result;
}

function proposeJournals(r: ReconResult, opt: Options): ProposedJournal[] {
  const J: ProposedJournal[] = [];
  const cur = r.currency;
  const push = (j: Omit<ProposedJournal, 'id' | 'status'>) => J.push({ id: `J${String(J.length + 1).padStart(2, '0')}`, status: 'proposed – needs approval', ...j });
  for (const g of r.groups) {
    const amt = Math.abs(g.effect);
    if (g.exception === 'BANK_CHARGE') {
      push({ group: g.id, date: r.periodEnd, memo: `Bank charges on receipt ${r.ledger.find(l => l.id === g.ledger[0])?.docNo}`,
        lines: [{ account: opt.accounts.bankCharges, debit: amt, credit: 0, currency: cur }, { account: opt.accounts.agent, debit: 0, credit: amt, currency: cur }] });
    }
    if (g.exception === 'MISSING_IN_LEDGER') {
      const s = r.statement.lines.find(x => x.id === g.statement[0])!;
      if (s.kind === 'document' && s.amount < 0) {
        const job = s.description.match(/\b[A-Z]{2,4}-\d{3,5}\b/)?.[0];
        push({ group: g.id, date: r.periodEnd, memo: `Accrue agent invoice ${s.reference}${job ? `, job ${job}` : ''} – verify against the job file first`,
          lines: [{ account: opt.accounts.costOfSales + (job ? ` (${job})` : ''), debit: amt, credit: 0, currency: cur }, { account: opt.accounts.agent, debit: 0, credit: amt, currency: cur }] });
      }
    }
  }
  if (opt.closingRate) {
    // Revalue the agent balance (after the proposed entries) at the period-end rate.
    const proposedEffect = round2(J.reduce((s, j) => s + j.lines.filter(x => x.account === opt.accounts.agent).reduce((t, x) => t + x.debit - x.credit, 0), 0));
    const balance = round2(r.ledgerClosing + proposedEffect);
    const bookedBase = round2(r.ledger.reduce((s, l) => s + l.amountBase, 0) + proposedEffect * opt.closingRate);
    const revaluedBase = round2(balance * opt.closingRate);
    const adj = round2(revaluedBase - bookedBase);
    r.fx = { rate: opt.closingRate, bookedBase, revaluedBase, adjustment: adj, baseCurrency: opt.baseCurrency };
    if (adj !== 0) {
      const b = opt.baseCurrency, a = Math.abs(adj);
      push({ date: r.periodEnd, memo: `Revalue ${cur} ${fmt(balance)} agent balance at ${opt.closingRate} (${b} ${fmt(bookedBase)} → ${fmt(revaluedBase)})`, baseAmount: adj,
        lines: adj > 0
          ? [{ account: opt.accounts.agent, debit: a, credit: 0, currency: b }, { account: opt.accounts.fx, debit: 0, credit: a, currency: b }]
          : [{ account: opt.accounts.fx, debit: a, credit: 0, currency: b }, { account: opt.accounts.agent, debit: 0, credit: a, currency: b }] });
    }
  }
  return J;
}
