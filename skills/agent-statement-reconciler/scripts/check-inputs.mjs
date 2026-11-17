#!/usr/bin/env node
// Checks the input files for agent-statement-reconciler before a run.
// Reads local files only. Writes nothing and makes no network calls.
// Usage: node check-inputs.mjs --ledger ledger.csv --statement statement.csv|txt [--fx fx-rates.csv] [--period-end YYYY-MM-DD]
import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { ledger: { type: 'string' }, statement: { type: 'string' }, fx: { type: 'string' }, 'period-end': { type: 'string' } } });
const errors = [];
const warns = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); if (row.some((f) => f.trim() !== '')) rows.push(row); }
  if (!rows.length) return { head: [], body: [] };
  const [head, ...body] = rows;
  const keys = head.map((h) => h.trim().toLowerCase().replace(/^﻿/, ''));
  return { head: keys, body: body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()]))) };
}

// Same rules as the engine: ISO, or day-first with dots or slashes.
function checkDate(raw, where) {
  const s = (raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (!m) { err(`${where}: "${s}" is not a date (use YYYY-MM-DD)`); return null; }
  const [d, mo] = [Number(m[1]), Number(m[2])];
  if (mo > 12) { err(`${where}: "${s}" looks like a US month-first date; the engine reads it day first. Convert to YYYY-MM-DD`); return null; }
  if (s.includes('/') && d <= 12) warn(`${where}: "${s}" will be read as day ${d}, month ${mo}. If it is a US date, convert to YYYY-MM-DD`);
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function checkAmount(raw, where, required = true) {
  let s = (raw ?? '').trim().replace(/\s/g, '');
  if (!s) { if (required) err(`${where}: amount is empty`); return 0; }
  const neg = /^-|\(.*\)$/.test(s);
  s = s.replace(/[()\-+]/g, '');
  if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) { err(`${where}: "${raw}" is not an amount`); return 0; }
  return neg ? -n : n;
}

function read(path, label) {
  if (!path) return null;
  if (!existsSync(path)) { err(`${label}: file not found: ${path}`); return null; }
  return readFileSync(path, 'utf8');
}

function needColumns(head, cols, label) {
  const missing = cols.filter((c) => !head.includes(c));
  if (missing.length) err(`${label}: missing column(s): ${missing.join(', ')}`);
  return missing.length === 0;
}

const TYPES = ['OB', 'INV', 'CN', 'AGINV', 'AGCN', 'PAYIN', 'PAYOUT'];
let ledgerCurrency = null;

// Ledger
if (!args.ledger) err('Pass --ledger <ledger.csv>');
const ledgerText = read(args.ledger, 'Ledger');
if (ledgerText !== null) {
  const { head, body } = parseCsv(ledgerText);
  if (needColumns(head, ['date', 'doc_no', 'doc_type', 'currency', 'amount'], 'Ledger')) {
    if (!body.length) err('Ledger: no rows');
    const docs = new Set(body.map((r) => r.doc_no));
    const currencies = new Set();
    let total = 0;
    body.forEach((r, i) => {
      const where = `Ledger row ${i + 2}`;
      checkDate(r.date, where);
      const type = (r.doc_type ?? '').toUpperCase();
      if (!TYPES.includes(type)) err(`${where}: doc_type "${r.doc_type}" must be one of ${TYPES.join(', ')}`);
      if (!r.doc_no) err(`${where}: doc_no is empty`);
      total += checkAmount(r.amount, where);
      if (r.currency) currencies.add(r.currency.toUpperCase());
      if (head.includes('amount_usd') && r.amount_usd) checkAmount(r.amount_usd, `${where} amount_usd`, false);
      if (type === 'PAYIN' || type === 'PAYOUT') {
        const applies = (r.applies_to ?? '').split(';').map((s) => s.trim()).filter(Boolean);
        if (!applies.length) warn(`${where}: payment ${r.doc_no} has no applies_to; it will be matched by amount and date only (medium confidence)`);
        for (const a of applies) if (!docs.has(a)) warn(`${where}: applies_to "${a}" is not a doc_no in this ledger file`);
      }
    });
    if (!body.some((r) => (r.doc_type ?? '').toUpperCase() === 'OB')) warn('Ledger: no opening balance (OB) row. Include it unless the account opened in this period');
    if (currencies.size > 1) err(`Ledger: more than one currency (${[...currencies].join(', ')}). Export one account and currency at a time`);
    ledgerCurrency = [...currencies][0] ?? null;
    if (!head.includes('applies_to')) warn('Ledger: no applies_to column; payments will be matched by amount and date only');
    console.log(`Ledger: ${body.length} rows, currency ${ledgerCurrency ?? '?'}, closing ${total.toFixed(2)} (positive = they owe us)`);
  }
}

// Statement
if (!args.statement) err('Pass --statement <statement.csv|txt>');
const statementText = read(args.statement, 'Statement');
let periodEnd = args['period-end'] ?? null;
if (statementText !== null) {
  if (args.statement.toLowerCase().endsWith('.csv')) {
    const { head, body } = parseCsv(statementText);
    if (needColumns(head, ['date', 'reference', 'description', 'debit', 'credit'], 'Statement')) {
      if (!body.length) err('Statement: no rows');
      const dates = [];
      body.forEach((r, i) => {
        const where = `Statement row ${i + 2}`;
        const d = checkDate(r.date, where);
        if (d) dates.push(d);
        const dr = checkAmount(r.debit, `${where} debit`, false);
        const cr = checkAmount(r.credit, `${where} credit`, false);
        if (dr === 0 && cr === 0) warn(`${where}: both debit and credit are zero`);
      });
      if (!body.some((r) => /brought forward|opening balance|b\/f|balance forward/i.test(r.description ?? ''))) {
        warn('Statement: no opening line ("Balance brought forward" / "Opening balance") found in the descriptions');
      }
      periodEnd = args['period-end'] ?? dates.sort().at(-1) ?? null;
      console.log(`Statement (CSV): ${body.length} lines, period end ${periodEnd ?? '?'}. Pass --agent, --currency and --period-end when you run it`);
    }
  } else {
    const lines = statementText.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 3) err('Statement: the text file has almost no lines; was the PDF text extracted?');
    if (!lines.some((l) => /closing balance|balance carried|balance due|closing/i.test(l))) {
      warn('Statement: no closing balance line found. The text parser needs one; without ANTHROPIC_API_KEY, consider converting the statement to CSV');
    }
    console.log(`Statement (text): ${lines.length} non-empty lines`);
  }
}

// FX
const fxText = read(args.fx, 'FX rates');
if (fxText !== null) {
  const { head, body } = parseCsv(fxText);
  if (needColumns(head, ['date', 'currency', 'usd_per_unit'], 'FX rates')) {
    body.forEach((r, i) => {
      const where = `FX row ${i + 2}`;
      checkDate(r.date, where);
      if (!(Number(r.usd_per_unit) > 0)) err(`${where}: usd_per_unit "${r.usd_per_unit}" must be a positive number`);
    });
    if (ledgerCurrency && !body.some((r) => (r.currency ?? '').toUpperCase() === ledgerCurrency)) {
      warn(`FX rates: no rate for ${ledgerCurrency}; no revaluation will be proposed`);
    }
    if (periodEnd && ledgerCurrency && !body.some((r) => (r.currency ?? '').toUpperCase() === ledgerCurrency && r.date === periodEnd)) {
      warn(`FX rates: no ${ledgerCurrency} rate dated ${periodEnd} (the period end); no revaluation will be proposed`);
    }
    console.log(`FX rates: ${body.length} rows`);
  }
}

for (const w of warns) console.log(`WARN   ${w}`);
for (const e of errors) console.log(`ERROR  ${e}`);
console.log(errors.length ? `\n${errors.length} error(s): fix them before running the reconciliation.` : '\nInputs look usable.');
process.exit(errors.length ? 1 : 0);
