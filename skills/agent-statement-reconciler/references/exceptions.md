# Exceptions and what to do about them

Each exception has an **effect**: its contribution to the difference between our ledger and the counterparty's statement (ledger − statement, in the account currency). The effects of all exceptions add up to the whole difference when the balance proof closes.

| Type | What it means | Who acts | Engine's action |
|---|---|---|---|
| `AMOUNT_DIFFERENCE` | The same document, or the opening balance, with different amounts on each side | Counterparty, after we check | Check the invoice and the agreed rate; ask for a credit note or support for the difference |
| `BANK_CHARGE` | They paid a document in full, we received less | Us only | Book the bank charges. A journal is proposed. Nothing to ask the counterparty |
| `DUPLICATE_IN_STATEMENT` | The same line appears twice on their statement | Counterparty | Ask them to reverse the duplicate |
| `MISSING_IN_LEDGER` | A line on their statement is not in our ledger | Us, then the counterparty | For their invoice: get a copy, check it against the job file; an accrual is proposed. Otherwise find the entry or ask for details |
| `MISSING_IN_STATEMENT` | A document in our ledger is not on their statement | Counterparty | Send them the document (or credit note) and ask them to book it |
| `IN_TRANSIT` | A payment we made shortly before the statement date is not on their statement yet | Nobody | Timing only. Confirm it appears on next month's statement |

## How lines are matched

Seven passes run in order, and each match records its rule:

1. `opening-balance`: opening balance lines.
2. `document-reference`: documents by normalised reference.
3. `payment-applied-documents`: payments by the documents they settle (`applies_to`), including one payment against several statement lines, and short receipts as bank charges.
4. `payment-amount-date`: payments with no reference, by equal amount within a date window. These are **medium confidence**: ask the user to confirm them.
5. `statement-duplicate`: duplicate lines on the statement.
6. `unmatched-statement`: lines only on the statement.
7. `unmatched-ledger`: lines only in our ledger, with in-transit detection near the period end.

## Proposed journals

Journals are proposed for bank charges, for accruals of counterparty invoices missing from our ledger, and for the period-end FX revaluation when FX rates and booked functional amounts are given. Each has the status `proposed – needs approval`. Account names are generic (for example "Bank charges", "Cost of sales – agent charges"); tell the user to map them to their chart of accounts before posting.
