# AFFOG Sales / Finance integration

Finance base: https://airtable.com/app7b0v3wEXudVmkD

The optional `src/finance-sync.js` job runs in the existing Shopify Sales Importer service. Existing legacy sales endpoints and inventory integrations are unchanged. New imports use only the new finance tables. No inventory API writes are made.

## Current activation blocker

Live test on October 25, 2026 returned `Airtable tblJF93j14JRV8d5y: HTTP 401`. The existing sales Airtable credential is invalid. The job stops before any import when finance access cannot be verified. Do not treat a successful Railway deployment as a successful data import.

1. Create an Airtable personal access token named `AFFOG Finance Sync` with `data.records:read` and `data.records:write` scopes.
2. Grant access to **AFFOG Sales & Finance** (`app7b0v3wEXudVmkD`) and **Japan 2026 / Sourcing & Events** (`appyiRn4kLqU03S1i`). The new finance job does not require access to the inventory base.
3. In Railway, project **Shopify Sales Importer**, service **shopify-sales-importer**, add **FINANCE_AIRTABLE_PAT** with that token. Save/deploy. Do not paste the token in chat. Existing variables do not need to be replaced for this new job.
4. To enable direct Gear Exchange reads, add **GXE_API_TOKEN** to the same service, reusing the token already configured on the existing **shopify-gxe-sync** service. No changes to the working GXE service are required.
5. Confirm a completed import in Railway's `FINANCE_SYNC` logs and the finance base's **Import Runs & Errors** page. Provider credentials and historical coverage still need live verification after Airtable authorization works.

`FINANCE_SYNC_ENABLED=true` and `FINANCE_START_DATE=2026-01-01T00:00:00-05:00` are configured. Runs occur about ten seconds after startup, then hourly. Keep one replica. Do not separately schedule duplicate invocations. A running invocation skips another call in the same process; Airtable upsert uses stable source keys to make repeated imports update existing rows. The job rejects duplicate keys already in the ledger before writing.

## Sources

- Shopify: all returned order states, paginated; pulls from January 1, 2026. Historical access depends on Shopify order permissions; compare source reports for coverage. Unknown or marketplace-mirrored sources are flagged, never approved automatically.
- Reverb Main / Warehouse: separate order-key namespaces; updated-date pagination, with order date in the configured year. Explicit source selling, processing and shipping-label fees retained. Refund/cancellation rows excluded pending reconciliation.
- Gear Exchange: direct read-only orders, separate from Hyperwallet settlements. Requires GXE_API_TOKEN on this service. Currency, quantity and settlement fees remain review items.
- PayPal: paginated activity in windows of at most 30 days, including positive and negative activity. Imported into **PayPal Activity Review**, not automatically counted as sales. Invoice, POS, Shopify checkout, transfer and loan classification must be validated using actual activity/export samples. Supply one PayPal POS transaction-level report and, if needed, an invoice report to finish mapping. Do not sum settlements as extra sales.
- Source receipts: copied from the sourcing base's **Expenses & Receipts**, including attachments when supplied. Stable key `SRC-<source record id>`. Receipt attachments use a source-ID fingerprint so temporary URL changes do not trigger repeated replacement. Finance receipt deletion is not propagated from sourcing.
- Show cash sales: source **Show Transactions** rows with `Type=Sale` and `Payment Method=Cash`. Date, item amount before tax, tax (including explicit zero), cash received, event and SKU must be entered. Trade/POS rows are not silently converted into cash sales. Imported records remain **Needs review** and do not alter inventory.

## Review / accounting boundaries

- New orders are **Needs review**. Only **Included** USD orders enter reviewed monthly sales.
- Changed source financial details/status return an included order to review. Manual notes are preserved; manual duplicate exclusions remain excluded.
- Missing fees are blank, never estimated. **Sales After Fees** remains blank until **Fee Status=Verified**. This is not net profit; shipping labels and other charges are separate.
- Monthly sales are grouped by original order month; refund timing needs a separate period reconciliation before treating this as accounting-period revenue.
- Receipt matching suggests only unique Amex matches with exact settled USD, vendor overlap and a date within three days. Pending charges, repeated amounts and ambiguous Chase account names are not automatically matched. Suggestions do not mark transactions reconciled. Mapping the three Chase cards needs account identification from the owner.
- Bank cash dashboard is posted movement in connected checking accounts, including financing/owner movements and card payments. It excludes physical cash, PayPal/Hyperwallet balances and is not operating cash flow or profit.
- Tax readiness, cash-on-hand reconciliation, consignor liabilities and final fee/refund settlement reconciliation remain separate review work. Verify finance-base sharing in Airtable; permissions have not been audited through the connector.

## Mobile entry links

- Add Receipt: https://airtable.com/appyiRn4kLqU03S1i/pagvoLLgVCvesOYoZ
- Show Cash Sales Entry: https://airtable.com/appyiRn4kLqU03S1i/pagqIbAB6nc3wTOSx
- Finance Sources & Connection Status: https://airtable.com/app7b0v3wEXudVmkD/pagsGTU43f7wTahzT

## Validation

Run `node --test test/finance-sync.test.js`. Tests cover stable identities, repeated SKUs, tax/refund separation, review reset, unknown fees, receipt ambiguity, source mirroring, cash vs trades/POS, pagination and fail-before-write behavior on invalid credentials.
