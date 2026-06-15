import express from "express";
import dotenv from "dotenv";
import Airtable from "airtable";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const CFG = {
  secret: process.env.SYNC_TRIGGER_SECRET || process.env.CRON_SECRET || "",
  dryRun: String(process.env.DRY_RUN || "false").toLowerCase() === "true",
  lookbackDays: Number(process.env.IMPORT_LOOKBACK_DAYS || 30),

  shopifyStoreDomain: requiredEnv("SHOPIFY_STORE_DOMAIN"),
  shopifyClientId: requiredEnv("SHOPIFY_CLIENT_ID"),
  shopifyClientSecret: requiredEnv("SHOPIFY_CLIENT_SECRET"),
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION || "2026-01",

  inventoryPat: requiredEnv("INVENTORY_AIRTABLE_PAT"),
  inventoryBaseId: requiredEnv("INVENTORY_AIRTABLE_BASE_ID"),
  inventoryTableName: process.env.INVENTORY_AIRTABLE_TABLE_NAME || "Inventory",

  salesPat: requiredEnv("SALES_AIRTABLE_PAT"),
  salesBaseId: requiredEnv("SALES_AIRTABLE_BASE_ID"),
  salesTableName: process.env.SALES_AIRTABLE_TABLE_NAME || "Sales",
  ownersTableName: process.env.OWNERS_AIRTABLE_TABLE_NAME || "Owners",
  payoutPeriodsTableName: process.env.PAYOUT_PERIODS_AIRTABLE_TABLE_NAME || "Payout Periods"
};

const inventoryBase = new Airtable({ apiKey: CFG.inventoryPat }).base(CFG.inventoryBaseId);
const salesBase = new Airtable({ apiKey: CFG.salesPat }).base(CFG.salesBaseId);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function requireSecret(req, res, next) {
  if (!CFG.secret) return next();

  const provided = req.query.secret || req.headers["x-sync-secret"];
  if (provided !== CFG.secret) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
}

function escapeAirtableFormulaString(value) {
  return String(value || "").replace(/'/g, "\\'");
}

function normalizeCurrency(value) {
  if (value === null || value === undefined || value === "") return 0;

  const normalizedValue = normalizeAirtableCellValue(value);

  const cleaned = String(normalizedValue)
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim();

  const parsed = parseFloat(cleaned);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return 0;

  const normalizedValue = normalizeAirtableCellValue(value);
  const parsed = parseFloat(String(normalizedValue).replace(/,/g, "").trim());

  return Number.isNaN(parsed) ? 0 : parsed;
}

function firstArrayValue(value) {
  if (Array.isArray(value)) return normalizeAirtableCellValue(value[0]);
  return normalizeAirtableCellValue(value);
}

function normalizeAirtableCellValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";

  if (typeof value === "object") {
    if (value.name) return String(value.name);
    if (value.value) return String(value.value);
    if (value.id && value.name) return String(value.name);
  }

  return String(value);
}

function isoDateOnly(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function getOrderCreatedAtMin() {
  const d = new Date();
  d.setDate(d.getDate() - CFG.lookbackDays);
  return d.toISOString();
}

function detectSaleSource(order) {
  const sourceName = String(order.source_name || "").toLowerCase();
  const appName = String(order.app?.name || "").toLowerCase();
  const tags = String(order.tags || "").toLowerCase();
  const referringSite = String(order.referring_site || "").toLowerCase();
  const landingSite = String(order.landing_site || "").toLowerCase();
  const combined = [sourceName, appName, tags, referringSite, landingSite].join(" ");

  if (combined.includes("gxe") || combined.includes("sweetwater")) return "GXE";
  if (combined.includes("google")) return "Google Shopping";
  if (combined.includes("facebook") || combined.includes("meta")) return "Facebook Shopping";
  if (combined.includes("youtube")) return "YouTube Shopping";
  return "Direct Shopify";
}

function calculateLineFinancials(order, lineItem) {
  const quantity = Number(lineItem.quantity || 1);
  const itemSubtotal = normalizeCurrency(lineItem.price) * quantity;
  const lineDiscount = Array.isArray(lineItem.discount_allocations)
    ? lineItem.discount_allocations.reduce((sum, discount) => sum + normalizeCurrency(discount.amount), 0)
    : 0;

  const orderShippingCharged = Array.isArray(order.shipping_lines)
    ? order.shipping_lines.reduce((sum, line) => sum + normalizeCurrency(line.price), 0)
    : 0;

  const totalLineItemsSubtotal = Array.isArray(order.line_items)
    ? order.line_items.reduce((sum, item) => sum + normalizeCurrency(item.price) * Number(item.quantity || 1), 0)
    : itemSubtotal;

  const shippingAllocated = totalLineItemsSubtotal > 0
    ? orderShippingCharged * (itemSubtotal / totalLineItemsSubtotal)
    : orderShippingCharged;

  const taxAllocated = Array.isArray(lineItem.tax_lines)
    ? lineItem.tax_lines.reduce((sum, tax) => sum + normalizeCurrency(tax.price), 0)
    : 0;

  const orderSubtotal = Math.max(itemSubtotal - lineDiscount, 0);

  return {
    orderSubtotal,
    grossSalePrice: orderSubtotal + shippingAllocated + taxAllocated,
    shippingCharged: shippingAllocated,
    salesTaxCollected: taxAllocated,
    quantitySold: quantity
  };
}

function calculateEstimatedPlatformFee({ saleChannel, saleSource, orderSubtotal }) {
  const cleanSaleChannel = String(saleChannel || "").trim();
  const cleanSaleSource = String(saleSource || "").trim();

  if (
    cleanSaleChannel === "Reverb Main" ||
    cleanSaleChannel === "Reverb Warehouse" ||
    cleanSaleSource === "GXE"
  ) {
    return orderSubtotal * 0.05;
  }

  return 0;
}

function calculateEstimatedPaymentProcessingFee({ orderSubtotal }) {
  return orderSubtotal * 0.03;
}

let cachedShopifyAccessToken = null;
let cachedShopifyAccessTokenExpiresAt = 0;

async function getShopifyAccessToken() {
  const now = Date.now();

  if (cachedShopifyAccessToken && now < cachedShopifyAccessTokenExpiresAt) {
    return cachedShopifyAccessToken;
  }

  const tokenUrl = `https://${CFG.shopifyStoreDomain}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CFG.shopifyClientId,
    client_secret: CFG.shopifyClientSecret
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Shopify token request failed ${response.status}: ${text}`);
  }

  const data = JSON.parse(text);

  if (!data.access_token) {
    throw new Error(`Shopify token request did not return access_token: ${text}`);
  }

  cachedShopifyAccessToken = data.access_token;

  const expiresInSeconds = Number(data.expires_in || 86399);
  cachedShopifyAccessTokenExpiresAt = now + Math.max(expiresInSeconds - 300, 60) * 1000;

  return cachedShopifyAccessToken;
}

async function shopifyRequest(path) {
  const accessToken = await getShopifyAccessToken();
  const url = `https://${CFG.shopifyStoreDomain}/admin/api/${CFG.shopifyApiVersion}${path}`;

  const response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Shopify API ${response.status}: ${text}`);
  }

  return JSON.parse(text);
}

async function fetchPaidShopifyOrders() {
  const createdAtMin = encodeURIComponent(getOrderCreatedAtMin());

  const data = await shopifyRequest(
    `/orders.json?status=any&financial_status=paid&limit=250&created_at_min=${createdAtMin}`
  );

  return data.orders || [];
}

async function findExistingSaleIds(saleIds) {
  if (!saleIds.length) return new Set();

  const existing = new Set();

  for (const saleId of saleIds) {
    const formula = `{Sale ID}='${escapeAirtableFormulaString(saleId)}'`;
    const records = await salesBase(CFG.salesTableName)
      .select({ filterByFormula: formula, maxRecords: 1 })
      .firstPage();

    if (records.length) existing.add(saleId);
  }

  return existing;
}

async function findInventoryBySku(sku) {
  if (!sku) return null;

  const formula = `{SKU}='${escapeAirtableFormulaString(sku)}'`;
  const records = await inventoryBase(CFG.inventoryTableName)
    .select({ filterByFormula: formula, maxRecords: 1 })
    .firstPage();

  if (!records.length) return null;

  const record = records[0];
  return {
    recordId: record.id,
    fields: record.fields
  };
}

function inferOwnerNameFromSku({ sku, inventoryOwnerName }) {
  const prefix = String(sku || "").trim().charAt(0).toUpperCase();
  const cleanInventoryOwner = String(firstArrayValue(inventoryOwnerName) || "").trim();

  if (prefix === "A") return "FF";
  if (prefix === "T") return "50/50";
  if (prefix === "C") return cleanInventoryOwner || "Other";

  return cleanInventoryOwner || "Other";
}

async function findOwnerRecordId(ownerName) {
  const cleanOwner = firstArrayValue(ownerName);
  if (!cleanOwner) return null;

  const formula = `{Owner Name}='${escapeAirtableFormulaString(cleanOwner)}'`;
  const records = await salesBase(CFG.ownersTableName)
    .select({ filterByFormula: formula, maxRecords: 1 })
    .firstPage();

  return records[0]?.id || null;
}

async function findOwnerRecordIdWithFallback(ownerName) {
  const ownerRecordId = await findOwnerRecordId(ownerName);
  if (ownerRecordId) return ownerRecordId;

  if (String(ownerName || "").trim() !== "Other") {
    return await findOwnerRecordId("Other");
  }

  return null;
}

async function findPayoutPeriodRecordId(saleDateIso) {
  if (!saleDateIso) return null;

  const formula = `AND(
    DATETIME_FORMAT({Start Date}, 'YYYY-MM-DD') <= '${saleDateIso}',
    DATETIME_FORMAT({End Date}, 'YYYY-MM-DD') >= '${saleDateIso}'
  )`;

  const records = await salesBase(CFG.payoutPeriodsTableName)
    .select({ filterByFormula: formula, maxRecords: 1 })
    .firstPage();

  return records[0]?.id || null;
}

function buildSalesFields({ order, lineItem, inventory, ownerRecordId, payoutPeriodRecordId }) {
  const sku = String(lineItem.sku || "").trim();
  const saleId = `SHOPIFY-${order.id}-${sku || lineItem.id}`;
  const saleDate = isoDateOnly(order.created_at);
  const inv = inventory?.fields || {};
  const financials = calculateLineFinancials(order, lineItem);
  const saleChannel = "Shopify";
  const saleSource = detectSaleSource(order);

  const fields = {
    "Sale ID": saleId,
    "SKU": sku,
    "Item Name": inv["Name"] || lineItem.title || "",
    "Brand": inv["Make"] || "",
    "Model": inv["Model"] || "",
    "Product Type": inv["Product Type"] || "",
    "Added Parts": normalizeAirtableCellValue(inv["Added Parts"]),
    "Parts Cost": normalizeCurrency(inv["Parts Cost"]),
    "Setup String Gauge": normalizeAirtableCellValue(inv["Setup String Gauge"]),
    "String Cost": normalizeCurrency(inv["String Cost"]),
    "Total Tech Time": normalizeNumber(inv["Total Tech Time"]),
    "Tech Labor Rate": normalizeCurrency(inv["Tech Labor Rate"] || 50),
    "Cost": normalizeCurrency(inv["Cost"]),
    "Sale Date": saleDate,
    "Sale Channel": saleChannel,
    "Sale Source": saleSource,
    "Order Number": String(order.name || order.order_number || order.id),
    "Marketplace Order ID": String(order.id),
    "Order Subtotal": financials.orderSubtotal,
    "Gross Sale Price": financials.grossSalePrice,
    "Shipping Charged": financials.shippingCharged,
    "Sales Tax Collected": financials.salesTaxCollected,
    "Estimated Platform Fee": calculateEstimatedPlatformFee({
      saleChannel,
      saleSource,
      orderSubtotal: financials.orderSubtotal
    }),
    "Estimated Payment Processing Fee": calculateEstimatedPaymentProcessingFee({
      orderSubtotal: financials.orderSubtotal
    }),
    "Quantity Sold": financials.quantitySold,
    "Customer Name": [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" "),
    "Imported Source": "Shopify",
    "Sale Status": "Paid",
    "Inventory Record ID": inventory?.recordId || "",
    "Location": inv["Location"] || ""
  };

  if (ownerRecordId) {
    fields["Owner"] = [ownerRecordId];
  }

  if (payoutPeriodRecordId) {
    fields["Payout Batch"] = [payoutPeriodRecordId];
  }

  return fields;
}

function removeEmptyFields(fields) {
  const cleaned = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    cleaned[key] = value;
  }

  return cleaned;
}

async function createSalesRecords(records) {
  if (!records.length) return [];

  const created = [];

  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);

    const response = await salesBase(CFG.salesTableName).create(
      batch.map((fields) => ({ fields: removeEmptyFields(fields) }))
    );

    created.push(...response);
  }

  return created;
}

async function fetchShopifySalesRecordsForBackfill() {
  return await new Promise((resolve, reject) => {
    const records = [];

    salesBase(CFG.salesTableName)
      .select({
        filterByFormula: "OR({Imported Source}='Shopify', {Sale Channel}='Shopify')"
      })
      .eachPage(
        (pageRecords, fetchNextPage) => {
          records.push(...pageRecords);
          fetchNextPage();
        },
        (error) => {
          if (error) reject(error);
          else resolve(records);
        }
      );
  });
}

function buildBackfillFields({ salesRecord, inventory, ownerRecordId, payoutPeriodRecordId }) {
  const sales = salesRecord.fields || {};
  const inv = inventory?.fields || {};
  const sku = String(sales["SKU"] || "").trim();
  const saleChannel = normalizeAirtableCellValue(sales["Sale Channel"]) || "Shopify";
  const saleSource = normalizeAirtableCellValue(sales["Sale Source"]) || "Direct Shopify";
  const orderSubtotal = normalizeCurrency(sales["Order Subtotal"]);

  const fields = {
    "Inventory Record ID": inventory?.recordId || "",
    "Added Parts": normalizeAirtableCellValue(inv["Added Parts"]),
    "Parts Cost": normalizeCurrency(inv["Parts Cost"]),
    "Setup String Gauge": normalizeAirtableCellValue(inv["Setup String Gauge"]),
    "String Cost": normalizeCurrency(inv["String Cost"]),
    "Total Tech Time": normalizeNumber(inv["Total Tech Time"]),
    "Tech Labor Rate": normalizeCurrency(inv["Tech Labor Rate"] || 50),
    "Estimated Platform Fee": calculateEstimatedPlatformFee({
      saleChannel,
      saleSource,
      orderSubtotal
    }),
    "Estimated Payment Processing Fee": calculateEstimatedPaymentProcessingFee({
      orderSubtotal
    })
  };

  if (ownerRecordId) {
    fields["Owner"] = [ownerRecordId];
  }

  if (payoutPeriodRecordId) {
    fields["Payout Batch"] = [payoutPeriodRecordId];
  }

  return fields;
}

async function updateSalesRecords(updates) {
  if (!updates.length) return [];

  const updated = [];

  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);

    const response = await salesBase(CFG.salesTableName).update(
      batch.map((update) => ({
        id: update.id,
        fields: removeEmptyFields(update.fields)
      }))
    );

    updated.push(...response);
  }

  return updated;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "shopify-sales-importer",
    version: "1.4.0-backfill-payout-fees"
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/jobs/shopify-sales/import", requireSecret, async (req, res) => {
  try {
    const orders = await fetchPaidShopifyOrders();

    const candidates = [];

    for (const order of orders) {
      for (const lineItem of order.line_items || []) {
        const sku = String(lineItem.sku || "").trim();
        if (!sku) continue;

        candidates.push({
          saleId: `SHOPIFY-${order.id}-${sku || lineItem.id}`,
          order,
          lineItem,
          sku
        });
      }
    }

    const existingSaleIds = await findExistingSaleIds(candidates.map((c) => c.saleId));
    const toCreate = [];
    const skipped = [];

    for (const candidate of candidates) {
      if (existingSaleIds.has(candidate.saleId)) {
        skipped.push({
          saleId: candidate.saleId,
          sku: candidate.sku,
          reason: "already_exists"
        });
        continue;
      }

      const inventory = await findInventoryBySku(candidate.sku);
      const inventoryOwnerName = inventory?.fields?.["Owner"] || inventory?.fields?.["Owner Name"] || "";
      const ownerName = inferOwnerNameFromSku({
        sku: candidate.sku,
        inventoryOwnerName
      });
      const ownerRecordId = await findOwnerRecordIdWithFallback(ownerName);
      const saleDate = isoDateOnly(candidate.order.created_at);
      const payoutPeriodRecordId = await findPayoutPeriodRecordId(saleDate);

      const fields = buildSalesFields({
        order: candidate.order,
        lineItem: candidate.lineItem,
        inventory,
        ownerRecordId,
        payoutPeriodRecordId
      });

      if (CFG.dryRun) {
        toCreate.push(fields);
      } else {
        toCreate.push(fields);
      }
    }

    const createdRecords = CFG.dryRun ? [] : await createSalesRecords(toCreate);

    res.json({
      ok: true,
      dryRun: CFG.dryRun,
      ordersScanned: orders.length,
      lineItemsScanned: candidates.length,
      skippedCount: skipped.length,
      createdCount: CFG.dryRun ? toCreate.length : createdRecords.length,
      skipped,
      created: CFG.dryRun
        ? toCreate.map((fields) => ({
            saleId: fields["Sale ID"],
            sku: fields["SKU"],
            orderNumber: fields["Order Number"],
            orderSubtotal: fields["Order Subtotal"],
            saleSource: fields["Sale Source"]
          }))
        : createdRecords.map((record) => ({
            recordId: record.id,
            saleId: record.fields["Sale ID"],
            sku: record.fields["SKU"],
            orderNumber: record.fields["Order Number"]
          }))
    });
  } catch (error) {
    console.error("Shopify sales import failed:", error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/jobs/shopify-sales/backfill", requireSecret, async (req, res) => {
  try {
    const records = await fetchShopifySalesRecordsForBackfill();
    const updates = [];
    const skipped = [];

    for (const record of records) {
      const sku = String(record.fields["SKU"] || "").trim();

      if (!sku) {
        skipped.push({
          recordId: record.id,
          reason: "missing_sku"
        });
        continue;
      }

      const inventory = await findInventoryBySku(sku);
      const inventoryOwnerName = inventory?.fields?.["Owner"] || inventory?.fields?.["Owner Name"] || "";
      const ownerName = inferOwnerNameFromSku({
        sku,
        inventoryOwnerName
      });
      const ownerRecordId = await findOwnerRecordIdWithFallback(ownerName);
      const saleDate = isoDateOnly(record.fields["Sale Date"]);
      const payoutPeriodRecordId = await findPayoutPeriodRecordId(saleDate);

      updates.push({
        id: record.id,
        sku,
        ownerName,
        fields: buildBackfillFields({
          salesRecord: record,
          inventory,
          ownerRecordId,
          payoutPeriodRecordId
        })
      });
    }

    const updatedRecords = CFG.dryRun ? [] : await updateSalesRecords(updates);

    res.json({
      ok: true,
      dryRun: CFG.dryRun,
      scannedCount: records.length,
      skippedCount: skipped.length,
      updatedCount: CFG.dryRun ? updates.length : updatedRecords.length,
      skipped,
      updated: CFG.dryRun
        ? updates.map((update) => ({
            recordId: update.id,
            sku: update.sku,
            ownerName: update.ownerName,
            fields: update.fields
          }))
        : updatedRecords.map((record) => ({
            recordId: record.id,
            saleId: record.fields["Sale ID"],
            sku: record.fields["SKU"],
            owner: record.fields["Owner"]
          }))
    });
  } catch (error) {
    console.error("Shopify sales backfill failed:", error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Shopify Sales Importer listening on port ${PORT}`);
});
