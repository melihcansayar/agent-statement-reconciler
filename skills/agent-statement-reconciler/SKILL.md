---
name: agent-statement-reconciler
description: Reconciles an overseas agent, supplier or intercompany statement of account against the ledger export, explains every difference, proposes correcting journals and drafts the email to the counterparty, with a person approving anything that is posted or sent. Use when the user asks to reconcile an agent statement, a statement of account against the ledger, an intercompany or partner balance, to find out why our balance and theirs do not match, or to prepare a month-end agent reconciliation for a freight forwarder or any business with foreign agents.
---

# Agent Statement Reconciler

Matches every line that ties between a counterparty's statement and our ledger, explains the rest as exceptions, proves that the explained exceptions add up to the whole difference, proposes journals, and drafts the email to the counterparty.

The matching is deterministic code, not AI, and every match records the rule that made it. AI is used only, and optionally, to read messy printed statements and to write the summary and the email, and the code checks that output before it is used.

## Ground rules

- **Never post anything to a ledger and never send the email.** Journals are proposals with the status `proposed – needs approval`. The email is a draft for a person to send.
- **Every figure you report comes from the tool's output.** Do not compute, round or invent balances yourself.
- **The balance proof must close.** `unexplained` must be `0.00` before you present the result as final.
- **Never edit the user's original files.** When an export needs reshaping, write a new file next to it and say so.

## One-time setup

The engine is open source (MIT): https://github.com/melihcansayar/agent-statement-reconciler. It needs Node.js 20 or later.

If the user does not have it yet, tell them you are about to download it from GitHub and install its npm dependencies, then:

```bash
git clone https://github.com/melihcansayar/agent-statement-reconciler
cd agent-statement-reconciler
npm install
npm test        # 7 tests should pass
npm run demo    # sample run, writes out/report.html
```

Below, `RECONCILER_DIR` is that folder.

Optional:

- `ANTHROPIC_API_KEY` lets the engine use Claude to read printed or PDF statements in any layout and to write the summary and email. Without it, a deterministic text parser and templates are used, and nothing is sent to any outside service.
- The engine includes an MCP server (`.mcp.json` in `RECONCILER_DIR`), with the tools `reconcile_statement`, `explain_item` and `draft_agent_email`. Use them when they are available; otherwise use the command line below. Both give the same result.

## Workflow

### 1. Collect the inputs

Ask the user for, or find:

1. **Ledger export** for the counterparty's account, for the statement period, including the opening balance. CSV.
2. **The counterparty's statement** for the same period: `.csv`, or the printed statement as `.txt`. For a PDF, extract the text with its layout kept (for example `pdftotext -layout statement.pdf statement.txt`).
3. **FX rates** (optional) for period-end revaluation, when the account is in a foreign currency.

The formats are in [references/input-formats.md](references/input-formats.md), with templates in `assets/`. If the user's export uses other column names, sign conventions or date formats, map it to the ledger format in a new file and show the user the mapping before you run.

### 2. Check the inputs

```bash
node scripts/check-inputs.mjs --ledger <ledger.csv> --statement <statement.csv|txt> [--fx <fx-rates.csv>] [--period-end <YYYY-MM-DD>]
```

Run this from the skill folder. It reads the files locally and changes nothing. Fix every `ERROR` before the run, and tell the user about each `WARN`. US-style dates (`11/05/2026`) are the most common problem: the engine reads slashes day-first, so convert them to `2026-11-05`.

### 3. Run the reconciliation

With the MCP server: call `reconcile_statement` with `ledger`, `statement`, and optionally `fx` and `out`.

From the command line, in `RECONCILER_DIR`:

```bash
npm run reconcile -- --ledger <ledger.csv> --statement <statement.txt> --fx <fx-rates.csv> --out <out-folder>
```

For a CSV statement, also pass `--agent "<counterparty name>" --currency <EUR> --period-end <YYYY-MM-DD>`, because a CSV carries no header.

Exit code `0` means the balance proof closed; `1` means part of the difference is unexplained.

### 4. Check the balance proof

Ledger closing − statement closing must equal the sum of the exception effects, so `unexplained` is `0.00`.

If it is not, do not present the result as final. Tell the user the unexplained amount and check, in this order:

1. The ledger signs: positive means the counterparty owes us.
2. Lines outside the statement period, in either file.
3. A missing opening balance line.
4. A printed statement that was misread: convert it to CSV and run again.

### 5. Report to the user

Lead with the balance proof, then:

- A table of the exceptions: id, type, effect, reason and action. The types and what each one means are in [references/exceptions.md](references/exceptions.md).
- The medium-confidence matches (matched by amount and date only, with no reference), so the user can confirm them.
- The proposed journals, each marked as needing approval.
- The output files: `report.html`, `exceptions.csv`, `proposed-journals.csv`, `agent-email.txt`, `result.json` and `audit.jsonl`.

When the user asks why a line was matched or not, use `explain_item` with the line or group id (`L03`, `S07`, `G12`), or read `result.json`.

### 6. Draft the email

Use `draft_agent_email`, or read `agent-email.txt` from the output folder. It lists only what the counterparty must act on: their amount differences, their duplicates, our documents missing from their statement. Show it to the user as a draft. Do not send it.

## Example

User: "Reconcile the Hamburg agent's October statement against our ledger and draft the email."

1. Find or ask for the ledger CSV and the statement.
2. Run `check-inputs.mjs`, then the reconciliation.
3. Report: "Ledger 2,995.00, statement −380.00, difference 3,375.00, unexplained 0.00. 9 of 15 groups matched automatically. 6 exceptions: …", then the exceptions table, the three proposed journals (bank charges, an accrual for the missing agent invoice, and the period-end FX revaluation) and the email draft.

The engine's own sample (`npm run demo` in `RECONCILER_DIR`) produces exactly this result and is a quick way to show the user what to expect.
