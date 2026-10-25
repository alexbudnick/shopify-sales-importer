# FF Gear attachment uploader

Independent Railway Function in the existing Shopify Sales Importer project. The sales import worker is unchanged. Deployed source is `uploader.mjs`, copied to the Function's single TypeScript file. Source and tests are retained on branch `feature/airtable-attachment-uploader`.

## Status

Service created and credentials configured by Railway references. Public domain creation requires explicit approval; it has not been enabled. Local tests cover authentication, signature/size validation, bounded request streams, preserving attachments, repeated/concurrent uploads, interrupted uploads and escaped searches. Runtime logs report read-only credential preflights. A live upload must be verified after the endpoint is enabled.

## Configuration

`PORT=8080`; `UPLOADER_KEY` is a dedicated random access key stored only in Railway. `FINANCE_AIRTABLE_PAT` and `INVENTORY_AIRTABLE_PAT` reference the existing sales importer variables. They are never exposed to the web client. Retrieve the uploader key from the uploader service Variables panel; never put credentials in source, URLs, issue comments or logs.

## Use

After approved public domain setup, open the generated HTTPS URL, paste the uploader key, choose a destination, search, select the matching record and attach files. Destination selection does not change inventory prices, quantity, status or listing flags. Files are sent one at a time; the selected destination stays fixed during the batch.

For future assistant check-ins or scripts, use `upload.py` with `FF_UPLOADER_URL` and `FF_UPLOADER_KEY` supplied securely in the execution environment. This avoids Airtable browser sign-in entirely. The uploader is not automatically installed as a ChatGPT connector tool.

```
python upload.py inventory recExampleRecord1 photo.jpg
```

Actual record IDs must come from Airtable lookup; the example is illustrative.

## API

Public `GET /` serves the empty UI; public `GET /health` reports configuration state only. All `/api/*` calls require `Authorization: Bearer <UPLOADER_KEY>`. No credentials in query strings. `GET /api/targets` lists the four allowed destinations. `GET /api/search?target=inventory&q=A10252601` returns at most 20 matching records. `POST /api/upload?target=inventory&record=rec...` accepts exactly one multipart field named `file`.

Targets: `inventory` → Inventory / Tech Photos; `finance` → Purchases & Receipts / Receipt; `sourcing` → Purchases / Item Photos; `receipts` → Expenses & Receipts / Receipt. No arbitrary base, table or field can be supplied.

Supported originals: JPEG, PNG, GIF, WebP and PDF, 5 MB maximum each, 20 files per UI batch. HEIC and larger files need conversion or a smaller copy before upload; originals are never silently recompressed. The service stores no uploaded files and never fetches user-provided URLs.

Uploads append using Airtable's direct attachment API. Saved filenames include a SHA-256-derived suffix to detect duplicate bytes on subsequent uploader requests, even after restarts. Existing attachments made outside this uploader have no hash marker and are not deduplicated automatically. The API verifies filename, size and preservation of previously existing attachment IDs before reporting success. Locks serialize requests per record in one process; do not scale beyond one replica without a durable distributed lock. On a timeout, verify the record before retrying. No automatic POST retries.

## Validation

`node --test uploader.test.mjs`

Reference: https://airtable.com/developers/web/api/upload-attachment
