// Amounts are signed from OUR perspective in the statement currency:
//   positive = the agent owes us (receivable), negative = we owe the agent (payable).

export type LedgerType = 'OB' | 'INV' | 'CN' | 'AGINV' | 'AGCN' | 'PAYIN' | 'PAYOUT';
export type LineKind = 'opening' | 'document' | 'payment';

export interface LedgerLine {
  id: string;            // L01, L02 ...
  date: string;          // ISO yyyy-mm-dd
  docNo: string;
  type: LedgerType;
  kind: LineKind;
  jobNo: string;
  appliesTo: string[];   // for payments: the documents they settle
  description: string;
  currency: string;
  amount: number;        // statement currency, our sign
  amountBase: number;    // functional currency as booked
  rate: number;
  keys: string[];        // normalised reference keys of docNo
}

export interface StatementLine {
  id: string;            // S01, S02 ...
  date: string;
  reference: string;
  description: string;
  debit: number;         // as printed by the agent
  credit: number;
  amount: number;        // converted to our sign: credit - debit
  kind: LineKind;
  keys: string[];
}

export interface Statement {
  agent: string;
  currency: string;
  periodEnd: string;
  closingAgentView: number | null; // closing balance as printed (agent's sign), when present
  lines: StatementLine[];
  extraction: { method: 'csv' | 'text-parser' | 'llm'; model?: string; checks: string[] };
}

export type ExceptionType =
  | 'AMOUNT_DIFFERENCE'
  | 'BANK_CHARGE'
  | 'DUPLICATE_IN_STATEMENT'
  | 'MISSING_IN_LEDGER'
  | 'MISSING_IN_STATEMENT'
  | 'IN_TRANSIT';

export interface Group {
  id: string;                 // G01 ...
  status: 'matched' | 'exception';
  rule: string;               // which pass decided it
  confidence: 'high' | 'medium';
  ledger: string[];
  statement: string[];
  effect: number;             // ledger total - statement total for this group
  exception?: ExceptionType;
  reason: string;
  action?: string;
}

export interface JournalLine { account: string; debit: number; credit: number; currency: string; }
export interface ProposedJournal {
  id: string;                 // J01 ...
  group?: string;
  date: string;
  memo: string;
  status: 'proposed – needs approval';
  lines: JournalLine[];
  baseAmount?: number;        // functional currency amount when relevant
}

export interface ReconResult {
  runId: string;
  agent: string;
  currency: string;
  periodEnd: string;
  ledgerClosing: number;
  statementClosing: number;   // our sign
  difference: number;
  explained: number;
  unexplained: number;
  groups: Group[];
  journals: ProposedJournal[];
  ledger: LedgerLine[];
  statement: Statement;
  fx?: { rate: number; bookedBase: number; revaluedBase: number; adjustment: number; baseCurrency: string };
}
