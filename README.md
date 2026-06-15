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
