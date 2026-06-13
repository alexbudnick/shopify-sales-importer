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
  shopifyToken: requiredEnv("SHOPIFY_ADMIN_ACCESS_TOKEN"),
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

  const cleaned = String(value)
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim();

  const parsed = parseFloat(cleaned);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function firstArrayValue(value) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
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

async function shopifyRequest(path) {
  const url = `https://${CFG.shopifyStoreDomain}/admin/api/${CFG.shopifyApiVersion}${path}`;

  const response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": CFG.shopifyToken,
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

async function findOwnerRecordId(ownerName) {
  const cleanOwner = firstArrayValue(ownerName);
  if (!cleanOwner) return null;

  const formula = `{Owner Name}='${escapeAirtableFormulaString(cleanOwner)}'`;
  const records = await salesBase(CFG.ownersTableName)
    .select({ filterByFormula: formula, maxRecords: 1 })
    .firstPage();

  return records[0]?.id || null;
}

async function findPayoutPeriodRecordId(saleDateIso) {
  if (!saleDateIso) return null;

  const formula = `AND(
    IS_AFTER('${saleDateIso}', DATEADD({Start Date}, -1, 'days')),
    IS_BEFORE('${saleDateIso}', DATEADD({End Date}, 1, 'days'))
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

  const fields = {
    "Sale ID": saleId,
    "SKU": sku,
    "Item Name": inv["Name"] || lineItem.title || "",
    "Brand": inv["Make"] || "",
    "Model": inv["Model"] || "",
    "Product Type": inv["Product Type"] || "",
    "Added Parts": inv["Added Parts"] || "",
    "Parts Cost": normalizeCurrency(inv["Parts Cost"]),
    "String Cost": normalizeCurrency(inv["String Cost"]),
    "Total Tech Time": Number(inv["Total Tech Time"] || 0),
    "Tech Labor Rate": normalizeCurrency(inv["Tech Labor Rate"] || 50),
    "Cost": normalizeCurrency(inv["Cost"]),
    "Sale Date": saleDate,
    "Sale Channel": "Shopify",
    "Sale Source": detectSaleSource(order),
    "Order Number": String(order.name || order.order_number || order.id),
    "Marketplace Order ID": String(order.id),
    "Order Subtotal": financials.orderSubtotal,
    "Gross Sale Price": financials.grossSalePrice,
    "Shipping Charged": financials.shippingCharged,
    "Sales Tax Collected": financials.salesTaxCollected,
    "Quantity Sold": financials.quantitySold,
    "Customer Name": [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" "),
    "Imported Source": "Shopify",
    "Sale Status": "Paid",
    "Inventory Record ID": inventory?.recordId || "",
    "Location": inv["Location"] || ""
  };

  if (ownerRecordId) {
    fields["Owner Name"] = [ownerRecordId];
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

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "shopify-sales-importer",
    version: "1.0.0"
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
      const ownerName = inventory?.fields?.["Owner"] || inventory?.fields?.["Owner Name"] || "";
      const ownerRecordId = await findOwnerRecordId(ownerName);
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

app.listen(PORT, () => {
  console.log(`Shopify Sales Importer listening on port ${PORT}`);
});
