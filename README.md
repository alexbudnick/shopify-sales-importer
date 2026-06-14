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
