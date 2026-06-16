# Shopify Sales Importer V1

Imports Shopify orders into Airtable Sales & Accounting.

## What it does

- Pulls paid Shopify orders.
- Reads each line item SKU.
- Prevents duplicates with `Sale ID = SHOPIFY-{order_id}-{sku}`.
- Looks up the SKU in the Inventory base.
- Creates a Sales record in the Sales & Accounting base.
- Links Owner Name to the Owners table.
- Assigns Payout Batch based on sale date.

## Endpoint

GET /jobs/shopify-sales/import?secret=YOUR_SECRET

## Required Railway Variables

PORT=3000
SYNC_TRIGGER_SECRET=your-secret

SHOPIFY_STORE_DOMAIN=aflashfloodofgear.myshopify.com
SHOPIFY_CLIENT_ID=your-client-id
SHOPIFY_CLIENT_SECRET=your-client-secret
SHOPIFY_API_VERSION=2026-01

INVENTORY_AIRTABLE_PAT=pat...
INVENTORY_AIRTABLE_BASE_ID=app2DxCRaxnHQL3zR
INVENTORY_AIRTABLE_TABLE_NAME=Inventory

SALES_AIRTABLE_PAT=pat...
SALES_AIRTABLE_BASE_ID=app05wGfuzfakil28
SALES_AIRTABLE_TABLE_NAME=Sales
OWNERS_AIRTABLE_TABLE_NAME=Owners
PAYOUT_PERIODS_AIRTABLE_TABLE_NAME=Payout Periods

DRY_RUN=false
IMPORT_LOOKBACK_DAYS=30


## Auth

This version uses Shopify Dev Dashboard client credentials. It exchanges SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET for a temporary Admin API access token automatically.


## v1.3.0 Owner SKU Fallback

Owner linking now uses SKU prefix safety rules:

- A-prefixed SKU -> Owner `FF`
- T-prefixed SKU -> Owner `50/50`
- C-prefixed SKU -> Inventory Owner; if blank, Owner `Other`
- Unknown prefix -> Inventory Owner; if blank, Owner `Other`

If an inferred owner does not exist in the Sales base `Owners` table, the app falls back to `Other`.


## v1.4.0 Backfill + Payout/Fee Safety

Adds:

- `/jobs/shopify-sales/backfill?secret=...`
- Backfills existing Shopify Sales records without creating duplicates.
- Refreshes Owner using SKU-prefix safety rules.
- Refreshes Inventory Record ID and tech cost snapshot fields.
- Refreshes Payout Batch based on Sale Date.
- Uses 5% Estimated Platform Fee for GXE sales.
- Uses 3% Estimated Payment Processing Fee for all Shopify sales.


## v1.5.0 Payout Status Automation

Adds automatic Sales `Payout Status` logic:

- A-prefixed SKU / FF owner -> `Not Applicable`
- Consignment with Payout Batch -> `Ready for Payout`
- Consignment without Payout Batch -> `Issue`

Backfill and new imports both apply this logic.

Safety:

- Existing `Paid Out` records are preserved.
- Existing `Held` records are preserved.


## v1.6.0 Final Service Notes

Adds Sales snapshot support for:

- `Final Service Notes`

The importer/backfill now copies:

- Inventory `Final Service Notes`
- to Sales `Final Service Notes`

This applies to both new Shopify sales imports and the `/jobs/shopify-sales/backfill` endpoint.


## v1.7.0 Reverb Warehouse Sales Import

Adds:

- `GET /jobs/reverb-warehouse-sales/import?secret=...`
- Imports sold Reverb Warehouse orders into the Sales table.
- Uses `Sale ID = REVERB-WAREHOUSE-{order_id}-{sku}` for duplicate protection.
- Uses the same Inventory lookup, Owner fallback, Payout Batch, Payout Status, tech costs, and Final Service Notes logic as Shopify.
- Estimated Platform Fee = 5%.
- Estimated Payment Processing Fee = 3%.

Additional Railway variable:

```
REVERB_WAREHOUSE_PERSONAL_TOKEN=your-reverb-warehouse-shop-token
```

Optional variables:

```
REVERB_API_BASE=https://api.reverb.com/api
REVERB_WAREHOUSE_ORDERS_PATH=/my/orders/selling/all
REVERB_PAGE_SIZE=50
REVERB_MAX_PAGES=25
REVERB_IMPORT_ORDER_STATUSES=paid,shipped,completed,delivered
REVERB_IGNORE_ORDER_STATUSES=pending,cancelled,canceled,refunded,failed,voided
```

For a safe preview without changing Airtable, run:

```
/jobs/reverb-warehouse-sales/import?secret=YOUR_SECRET&dry_run=true
```


## v1.7.1 Reverb Single Listing Parser

Fixes Reverb Warehouse sales dry-runs that scanned orders but found 0 line items.

Reverb can return sold orders as single listing/order objects instead of Shopify-style
line item arrays. This patch treats those objects as one sale item and expands SKU/price
parsing for common Reverb fields.


## v1.8.0 Reverb Main Sales

Adds Reverb Main shop sales import alongside Reverb Warehouse.

New required Railway variable:

- `REVERB_MAIN_PERSONAL_TOKEN`

New endpoint:

- `/jobs/reverb-main-sales/import?secret=...&dry_run=true`

Behavior:

- `Sale ID = REVERB-MAIN-{order_id}-{sku}`
- `Sale Channel = Reverb Main`
- `Sale Source = Reverb Main`
- `Estimated Platform Fee = Order Subtotal × 5%`
- `Estimated Payment Processing Fee = Order Subtotal × 3%`

Also keeps the existing Warehouse endpoint:

- `/jobs/reverb-warehouse-sales/import?secret=...`


## v1.8.1 Reverb Main SKU Cleaner

Adds Reverb SKU cleaning before Inventory matching and Sales creation.

Examples:

- `EXP-4-C06032530` -> `C06032530`
- `EXP-4-C03062302N` -> `C03062302N`

This keeps Reverb-export prefixes from breaking Inventory lookups, owner fallback logic,
payout status, and consignment formulas.


## v1.9.0 PayPal Preview

Adds PayPal Transaction Search preview endpoint.

New Railway variables:

- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_API_BASE=https://api-m.paypal.com`

New endpoint:

- `/jobs/paypal-sales/preview?secret=...&days=30`

This endpoint does not write to Airtable. It only previews PayPal transactions and attempts
to detect Inventory SKUs from invoice ID, custom field, subject, note, payer email, and item details.


## v1.9.1 PayPal Preview Strict SKU

Tightens PayPal preview before live import:

- Requires inventory-style SKU pattern: A/C/T + 8 digits, with optional suffix.
- Stops reading PayPal transaction/reference IDs as fake SKUs.
- Prioritizes PayPal item code / item name / item description over transaction IDs.
- Excludes obvious non-sale counterparties such as Shopify, Reverb, PayPal Working Capital,
  Adobe, Microsoft, Uber, Big Cartel, Dropbox, Soundstripe, and Apple.
- Marks possibleSale only for positive gross transactions with sale-like event codes:
  T0006, T0011, T0018.


## v1.10.0 ShipStation Order Location Preview

Adds a preview-only endpoint:

- `/jobs/shipstation-order-location-repair/preview?secret=...`

New Railway variables:

- `SHIPSTATION_API_KEY`
- `SHIPSTATION_API_SECRET`
- `SHIPSTATION_API_BASE=https://ssapi.shipstation.com`

Optional variables:

- `SHIPSTATION_PAGE_SIZE=100`
- `SHIPSTATION_MAX_PAGES=10`
- `SHIPSTATION_REPAIR_STATUSES=awaiting_shipment,on_hold,awaiting_payment`

This endpoint does not write to ShipStation. It only previews open order items and shows whether
the app can safely set each order item's SKU and warehouseLocation from Airtable Inventory.
