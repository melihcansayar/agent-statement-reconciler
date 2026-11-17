# Input formats

All files are CSV with a header row, comma-separated, UTF-8. Column names are case-insensitive. Templates are in `../assets/`.

## Dates and amounts

- **Dates:** `YYYY-MM-DD`, or day-first `DD.MM.YYYY` / `DD/MM/YYYY`. Slashes are always read **day first**, so US dates (`11/05/2026` for 5 November) must be converted to `2026-11-05` first.
- **Amounts:** `1234.56`, `1,234.56` or `1.234,56`. A leading minus or brackets `(1,234.56)` make the amount negative.

## Ledger export (`--ledger`)

One row per posting on the counterparty's account for the period, including the opening balance.

| Column | Required | Meaning |
|---|---|---|
| `date` | yes | Posting date |
| `doc_no` | yes | Document number as booked. References are normalised for matching, so `HAM/24/0121` matches `HAM-24-121` |
| `doc_type` | yes | One of the types below |
| `job_no` | no | Job, shipment or project number. Used in the accrual memo |
| `applies_to` | for payments | The documents a payment settles, separated by `;` |
| `description` | no | Free text |
| `currency` | yes | Currency of the account and statement, for example `EUR` |
| `amount` | yes | In the account currency, **signed from our side: positive = they owe us, negative = we owe them** |
| `usd_rate` | no | Booking rate to the functional currency |
| `amount_usd` | no | Amount in the functional currency as booked. Needed for FX revaluation |

`doc_type` values:

| Type | Meaning | Usual sign |
|---|---|---|
| `OB` | Opening balance | either |
| `INV` | Our invoice to them | + |
| `CN` | Our credit note to them | − |
| `AGINV` | Their invoice to us | − |
| `AGCN` | Their credit note to us | + |
| `PAYIN` | Payment we received from them | − |
| `PAYOUT` | Payment we made to them | + |

Mapping a typical ERP export: keep only the counterparty's account, take debit − credit from **our** books as `amount` (a receivable debit is positive), and set `doc_type` from the document type in the export. Write the result to a new file.

## Counterparty statement (`--statement`)

### CSV

| Column | Meaning |
|---|---|
| `date` | Line date |
| `reference` | Their reference; may be empty for payments and the opening balance |
| `description` | Text as printed. Words such as "payment", "remittance", "received" or "paid" mark a payment; "brought forward" or "opening balance" marks the opening line |
| `debit` | As printed **by the counterparty** |
| `credit` | As printed by the counterparty |

Pass `--agent`, `--currency` and `--period-end` with a CSV statement.

### Printed statement (`.txt`)

The text of a printed or PDF statement, with its columns kept (`pdftotext -layout`). The deterministic parser needs a running-balance column and a closing balance line. With `ANTHROPIC_API_KEY` set, Claude extracts the lines first, and the result is used only if the lines add up to the printed closing balance.

If a printed statement cannot be read, type or paste its lines into the CSV format instead.

## FX rates (`--fx`, optional)

| Column | Meaning |
|---|---|
| `date` | Rate date; the period-end date must be present |
| `currency` | The account currency, for example `EUR` |
| `usd_per_unit` | Functional currency per one unit of the account currency |
