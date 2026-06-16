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
  payoutPeriodsTableName: process.env.PAYOUT_PERIODS_AIRTABLE_TABLE_NAME || "Payout Periods",

  reverbApiBase: process.env.REVERB_API_BASE || "https://api.reverb.com/api",
  reverbWarehouseToken: process.env.REVERB_WAREHOUSE_PERSONAL_TOKEN || process.env.REVERB_PERSONAL_TOKEN || "",
  reverbWarehouseOrdersPath: process.env.REVERB_WAREHOUSE_ORDERS_PATH || "/my/orders/selling/all",
  reverbMainToken: process.env.REVERB_MAIN_PERSONAL_TOKEN || "",
  reverbMainOrdersPath: process.env.REVERB_MAIN_ORDERS_PATH || "/my/orders/selling/all",

  paypalClientId: process.env.PAYPAL_CLIENT_ID || "",
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET || "",
  paypalApiBase: process.env.PAYPAL_API_BASE || "https://api-m.paypal.com",

  shipStationApiKey: process.env.SHIPSTATION_API_KEY || "",
  shipStationApiSecret: process.env.SHIPSTATION_API_SECRET || "",
  shipStationApiBase: process.env.SHIPSTATION_API_BASE || "https://ssapi.shipstation.com",
  shipStationPageSize: Number(process.env.SHIPSTATION_PAGE_SIZE || 100),
  shipStationMaxPages: Number(process.env.SHIPSTATION_MAX_PAGES || 10),
  shipStationRepairStatuses: String(process.env.SHIPSTATION_REPAIR_STATUSES || "awaiting_shipment,on_hold,awaiting_payment")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  reverbPageSize: Number(process.env.REVERB_PAGE_SIZE || 50),
  reverbMaxPages: Number(process.env.REVERB_MAX_PAGES || 25),
  reverbImportStatuses: new Set(
    String(process.env.REVERB_IMPORT_ORDER_STATUSES || "paid,shipped,completed,delivered")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  ),
  reverbIgnoreStatuses: new Set(
    String(process.env.REVERB_IGNORE_ORDER_STATUSES || "pending,cancelled,canceled,refunded,failed,voided")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  )
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


async function reverbRequestWithToken(token, path, options = {}) {
  if (!token) {
    throw new Error("Missing REVERB_WAREHOUSE_PERSONAL_TOKEN or REVERB_PERSONAL_TOKEN");
  }

  const response = await fetch(`${CFG.reverbApiBase}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept-Version": "3.0",
      "Content-Type": "application/hal+json",
      "Accept": "application/hal+json",
      ...(options.headers || {})
    }
  });

  const responseText = await response.text();
  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    data = responseText;
  }

  if (!response.ok) {
    throw new Error(`Reverb API ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

function extractCollection(data, preferredKey) {
  if (Array.isArray(data?.[preferredKey])) return data[preferredKey];
  if (Array.isArray(data?.orders)) return data.orders;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data)) return data;
  return [];
}

async function fetchAllReverbPages({ token, path, collectionKey }) {
  const allItems = [];

  for (let page = 1; page <= CFG.reverbMaxPages; page += 1) {
    const params = new URLSearchParams({
      per_page: String(CFG.reverbPageSize),
      page: String(page)
    });

    const data = await reverbRequestWithToken(token, `${path}?${params.toString()}`);
    const items = extractCollection(data, collectionKey);
    allItems.push(...items);

    if (items.length < CFG.reverbPageSize) break;
  }

  return allItems;
}

function moneyAmount(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return normalizeCurrency(value);

  if (typeof value === "object") {
    const candidates = [
      value.amount,
      value.value,
      value.display,
      value.price,
      value.total,
      value.subtotal
    ];

    for (const candidate of candidates) {
      const parsed = moneyAmount(candidate);
      if (parsed) return parsed;
    }
  }

  return 0;
}

function extractReverbStatus(order) {
  const candidates = [
    order?.status,
    order?.state,
    order?.status?.slug,
    order?.status?.name,
    order?.status?.display_name,
    order?.state?.slug,
    order?.state?.name,
    order?.state?.display_name
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().toLowerCase();
    }
  }

  return "";
}

function shouldImportReverbOrder(order) {
  const status = extractReverbStatus(order);
  if (CFG.reverbIgnoreStatuses.has(status)) return false;
  if (!status) return true;
  return CFG.reverbImportStatuses.has(status);
}

function getReverbOrderDate(order) {
  return (
    order?.paid_at ||
    order?.payment_date ||
    order?.created_at ||
    order?.createdAt ||
    order?.updated_at ||
    order?.updatedAt ||
    order?.date ||
    null
  );
}

function isWithinLookback(dateValue) {
  if (!dateValue) return true;

  const saleDate = new Date(dateValue);
  if (Number.isNaN(saleDate.getTime())) return true;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CFG.lookbackDays);

  return saleDate >= cutoff;
}

function extractReverbLineItems(order) {
  const arrayCandidates = [
    order?.line_items,
    order?.lineItems,
    order?.items,
    order?.order_items,
    order?.orderItems,
    order?.products,
    order?.listings
  ];

  for (const candidate of arrayCandidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
  }

  const singleItemCandidates = [
    order?.listing,
    order?.item,
    order?.line_item,
    order?.order_item,
    order?.product,
    order?.inventory_item,
    order?.inventory
  ];

  for (const candidate of singleItemCandidates) {
    if (candidate && typeof candidate === "object") return [candidate];
  }

  if (
    extractReverbSku(order) ||
    extractReverbItemTitle(order) ||
    extractReverbLineUnitPrice(order)
  ) {
    return [order];
  }

  return [];
}

function cleanReverbSku(rawSku) {
  const cleanSku = normalizeAirtableCellValue(rawSku).trim();

  if (!cleanSku) return "";

  const embeddedInventorySku = cleanSku.match(/([ACT]\d{6,}[A-Z0-9]*(?:_[A-Z0-9]+)?)/i);

  if (embeddedInventorySku?.[1]) {
    return embeddedInventorySku[1].toUpperCase();
  }

  return cleanSku;
}

function extractReverbSku(item) {
  const candidates = [
    item?.sku,
    item?.shop_sku,
    item?.inventory_sku,
    item?.inventory?.sku,
    item?.inventory?.shop_sku,
    item?.listing?.sku,
    item?.listing?.shop_sku,
    item?.listing?.inventory_sku,
    item?.listing?.inventory?.sku,
    item?.listing?.inventory?.shop_sku,
    item?.product?.sku,
    item?.product?.shop_sku,
    item?.product?.inventory_sku
  ];

  for (const candidate of candidates) {
    const normalized = cleanReverbSku(candidate);
    if (normalized) return normalized;
  }

  return "";
}

function extractReverbQuantity(item) {
  const candidates = [
    item?.quantity,
    item?.qty,
    item?.inventory,
    item?.inventory_count,
    item?.available_quantity,
    item?.listing?.quantity,
    item?.listing?.inventory,
    item?.product?.quantity
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === "") continue;
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return 1;
}

function extractReverbItemTitle(item) {
  const candidates = [
    item?.title,
    item?.name,
    item?.listing?.title,
    item?.listing?.name,
    item?.product?.title,
    item?.product?.name
  ];

  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && String(candidate).trim()) {
      return String(candidate).trim();
    }
  }

  return "";
}

function extractReverbLineUnitPrice(item) {
  const candidates = [
    item?.price,
    item?.unit_price,
    item?.amount,
    item?.amount_product,
    item?.item_price,
    item?.sale_price,
    item?.accepted_price,
    item?.total,
    item?.subtotal,
    item?.product_amount,
    item?.total_product,
    item?.listing?.price,
    item?.listing?.amount,
    item?.listing?.amount_product,
    item?.product?.price,
    item?.product?.amount
  ];

  for (const candidate of candidates) {
    const parsed = moneyAmount(candidate);
    if (parsed) return parsed;
  }

  return 0;
}

function extractReverbOrderShipping(order) {
  const candidates = [
    order?.shipping,
    order?.shipping_price,
    order?.shipping_amount,
    order?.shipping_total,
    order?.amount_shipping,
    order?.amount_shipping_seller,
    order?.shipping?.price,
    order?.shipping?.amount,
    order?.shipping?.total
  ];

  for (const candidate of candidates) {
    const parsed = moneyAmount(candidate);
    if (parsed) return parsed;
  }

  return 0;
}

function extractReverbOrderTax(order) {
  const candidates = [
    order?.tax,
    order?.tax_amount,
    order?.tax_total,
    order?.sales_tax,
    order?.sales_tax_amount,
    order?.amount_tax,
    order?.tax?.amount,
    order?.tax?.total
  ];

  for (const candidate of candidates) {
    const parsed = moneyAmount(candidate);
    if (parsed) return parsed;
  }

  return 0;
}

function extractReverbCustomerName(order) {
  const buyer = order?.buyer || order?.buyer_info || order?.customer || {};
  const candidates = [
    order?.buyer_name,
    order?.customer_name,
    buyer?.name,
    [buyer?.first_name, buyer?.last_name].filter(Boolean).join(" "),
    [buyer?.firstName, buyer?.lastName].filter(Boolean).join(" ")
  ];

  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && String(candidate).trim()) {
      return String(candidate).trim();
    }
  }

  return "";
}

function getReverbOrderNumber(order) {
  return String(order?.order_number || order?.orderNumber || order?.number || order?.id || "");
}

function getReverbOrderId(order) {
  return String(order?.id || order?.uuid || order?.order_id || order?.orderId || getReverbOrderNumber(order));
}

function calculateReverbLineFinancials(order, item, allItems) {
  const quantity = extractReverbQuantity(item);
  const itemSubtotal = extractReverbLineUnitPrice(item) * quantity;
  const totalLineItemsSubtotal = allItems.reduce((sum, lineItem) => {
    return sum + extractReverbLineUnitPrice(lineItem) * extractReverbQuantity(lineItem);
  }, 0);

  const orderShippingCharged = extractReverbOrderShipping(order);
  const orderTaxCollected = extractReverbOrderTax(order);
  const allocationRatio = totalLineItemsSubtotal > 0 ? itemSubtotal / totalLineItemsSubtotal : 1;
  const shippingCharged = orderShippingCharged * allocationRatio;
  const salesTaxCollected = orderTaxCollected * allocationRatio;

  return {
    orderSubtotal: itemSubtotal,
    grossSalePrice: itemSubtotal + shippingCharged + salesTaxCollected,
    shippingCharged,
    salesTaxCollected,
    quantitySold: quantity
  };
}

async function fetchReverbWarehouseOrders() {
  const orders = await fetchAllReverbPages({
    token: CFG.reverbWarehouseToken,
    path: CFG.reverbWarehouseOrdersPath,
    collectionKey: "orders"
  });

  return orders.filter((order) => shouldImportReverbOrder(order) && isWithinLookback(getReverbOrderDate(order)));
}

async function fetchReverbMainOrders() {
  if (!CFG.reverbMainToken) {
    throw new Error("Missing REVERB_MAIN_PERSONAL_TOKEN");
  }

  const orders = await fetchAllReverbPages({
    token: CFG.reverbMainToken,
    path: CFG.reverbMainOrdersPath,
    collectionKey: "orders"
  });

  return orders.filter((order) => shouldImportReverbOrder(order) && isWithinLookback(getReverbOrderDate(order)));
}

function buildReverbWarehouseSalesFields({ order, item, itemIndex, allItems, inventory, ownerName, ownerRecordId, payoutPeriodRecordId }) {
  const sku = extractReverbSku(item);
  const orderId = getReverbOrderId(order);
  const saleId = `REVERB-WAREHOUSE-${orderId}-${sku || item?.id || itemIndex}`;
  const saleDate = isoDateOnly(getReverbOrderDate(order));
  const inv = inventory?.fields || {};
  const financials = calculateReverbLineFinancials(order, item, allItems);
  const saleChannel = "Reverb Warehouse";
  const saleSource = "Reverb Warehouse";

  const fields = {
    "Sale ID": saleId,
    "SKU": sku,
    "Item Name": inv["Name"] || extractReverbItemTitle(item) || "",
    "Brand": inv["Make"] || "",
    "Model": inv["Model"] || "",
    "Product Type": inv["Product Type"] || "",
    "Added Parts": normalizeAirtableCellValue(inv["Added Parts"]),
    "Final Service Notes": normalizeAirtableCellValue(inv["Final Service Notes"]),
    "Parts Cost": normalizeCurrency(inv["Parts Cost"]),
    "Setup String Gauge": normalizeAirtableCellValue(inv["Setup String Gauge"]),
    "String Cost": normalizeCurrency(inv["String Cost"]),
    "Total Tech Time": normalizeNumber(inv["Total Tech Time"]),
    "Tech Labor Rate": normalizeCurrency(inv["Tech Labor Rate"] || 50),
    "Cost": normalizeCurrency(inv["Cost"]),
    "Sale Date": saleDate,
    "Sale Channel": saleChannel,
    "Sale Source": saleSource,
    "Order Number": getReverbOrderNumber(order),
    "Marketplace Order ID": orderId,
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
    "Customer Name": extractReverbCustomerName(order),
    "Imported Source": "Reverb Warehouse",
    "Sale Status": "Paid",
    "Payout Status": determinePayoutStatus({
      sku,
      ownerName,
      payoutPeriodRecordId
    }),
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

function buildReverbMainSalesFields({ order, item, itemIndex, allItems, inventory, ownerName, ownerRecordId, payoutPeriodRecordId }) {
  const sku = extractReverbSku(item);
  const orderId = getReverbOrderId(order);
  const saleId = `REVERB-MAIN-${orderId}-${sku || item?.id || itemIndex}`;
  const saleDate = isoDateOnly(getReverbOrderDate(order));
  const inv = inventory?.fields || {};
  const financials = calculateReverbLineFinancials(order, item, allItems);
  const saleChannel = "Reverb Main";
  const saleSource = "Reverb Main";

  const fields = {
    "Sale ID": saleId,
    "SKU": sku,
    "Item Name": inv["Name"] || extractReverbItemTitle(item) || "",
    "Brand": inv["Make"] || "",
    "Model": inv["Model"] || "",
    "Product Type": inv["Product Type"] || "",
    "Added Parts": normalizeAirtableCellValue(inv["Added Parts"]),
    "Final Service Notes": normalizeAirtableCellValue(inv["Final Service Notes"]),
    "Parts Cost": normalizeCurrency(inv["Parts Cost"]),
    "Setup String Gauge": normalizeAirtableCellValue(inv["Setup String Gauge"]),
    "String Cost": normalizeCurrency(inv["String Cost"]),
    "Total Tech Time": normalizeNumber(inv["Total Tech Time"]),
    "Tech Labor Rate": normalizeCurrency(inv["Tech Labor Rate"] || 50),
    "Cost": normalizeCurrency(inv["Cost"]),
    "Sale Date": saleDate,
    "Sale Channel": saleChannel,
    "Sale Source": saleSource,
    "Order Number": getReverbOrderNumber(order),
    "Marketplace Order ID": orderId,
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
    "Customer Name": extractReverbCustomerName(order),
    "Imported Source": "Reverb Main",
    "Sale Status": "Paid",
    "Payout Status": determinePayoutStatus({
      sku,
      ownerName,
      payoutPeriodRecordId
    }),
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

let paypalAccessTokenCache = {
  token: "",
  expiresAt: 0
};

function requirePayPalConfig() {
  if (!CFG.paypalClientId || !CFG.paypalClientSecret) {
    throw new Error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET");
  }
}

async function getPayPalAccessToken() {
  requirePayPalConfig();

  const now = Date.now();

  if (paypalAccessTokenCache.token && paypalAccessTokenCache.expiresAt > now + 60000) {
    return paypalAccessTokenCache.token;
  }

  const response = await fetch(`${CFG.paypalApiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Language": "en_US",
      Authorization: `Basic ${Buffer.from(`${CFG.paypalClientId}:${CFG.paypalClientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`PayPal OAuth failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  paypalAccessTokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(Number(payload.expires_in || 300) - 60, 60) * 1000
  };

  return paypalAccessTokenCache.token;
}

function paypalAmount(value) {
  if (value === null || value === undefined || value === "") return 0;

  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    return normalizeCurrency(value);
  }

  if (typeof value === "object") {
    const candidates = [
      value.value,
      value.amount,
      value.gross_amount,
      value.net_amount,
      value.fee_amount
    ];

    for (const candidate of candidates) {
      const parsed = paypalAmount(candidate);
      if (parsed) return parsed;
    }
  }

  return 0;
}

function paypalCurrency(value) {
  if (!value || typeof value !== "object") return "";

  return (
    value.currency_code ||
    value.currency ||
    value.currencyCode ||
    ""
  );
}

function detectInventorySkuFromText(text) {
  const cleanText = normalizeAirtableCellValue(text);

  if (!cleanText) return "";

  const match = cleanText.match(/(?:^|[^A-Z0-9])([ACT]\d{8}(?:[A-Z0-9]{0,4})?(?:_[A-Z0-9]+)?)(?=$|[^A-Z0-9])/i);

  return match?.[1] ? match[1].toUpperCase() : "";
}

function extractPayPalItemDetails(detail) {
  const itemDetails = detail?.cart_info?.item_details;

  if (Array.isArray(itemDetails)) return itemDetails;

  return [];
}

function extractPayPalTextSources(detail) {
  const tx = detail?.transaction_info || {};
  const payer = detail?.payer_info || {};
  const items = extractPayPalItemDetails(detail);

  const sources = [];

  for (const item of items) {
    sources.push(
      item.item_code,
      item.sku,
      item.item_name,
      item.item_description,
      item.invoice_number
    );
  }

  sources.push(
    tx.invoice_id,
    tx.custom_field,
    tx.transaction_subject,
    tx.transaction_note,
    tx.transaction_memo,
    tx.reference_id,
    payer.email_address
  );

  return sources
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .map((value) => normalizeAirtableCellValue(value));
}

function extractPayPalDetectedSku(detail) {
  for (const source of extractPayPalTextSources(detail)) {
    const sku = detectInventorySkuFromText(source);

    if (sku) return sku;
  }

  return "";
}
function isExcludedPayPalCounterparty(detail) {
  const payer = detail?.payer_info || {};
  const tx = detail?.transaction_info || {};

  const combinedText = [
    payer.email_address,
    extractPayPalPayerName(detail),
    tx.transaction_subject,
    tx.transaction_note,
    tx.transaction_memo
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const excludedNeedles = [
    "shopify",
    "reverb.com",
    "paypal-admin@ma.reverb.com",
    "paypal working capital",
    "adobe",
    "microsoft",
    "uber",
    "bigcartel",
    "dropbox",
    "soundstripe",
    "apple services"
  ];

  return excludedNeedles.some((needle) => combinedText.includes(needle));
}

function isLikelyPayPalSale(detail, detectedSku) {
  const tx = detail?.transaction_info || {};
  const status = String(tx.transaction_status || "").trim();
  const eventCode = String(tx.transaction_event_code || "").trim();
  const grossAmount = paypalAmount(tx.transaction_amount);

  if (!detectedSku) return false;
  if (status && status !== "S") return false;
  if (grossAmount <= 0) return false;
  if (isExcludedPayPalCounterparty(detail)) return false;

  const allowedSaleEventCodes = new Set([
    "T0006",
    "T0011",
    "T0018"
  ]);

  return allowedSaleEventCodes.has(eventCode);
}


function extractPayPalPayerName(detail) {
  const payerName = detail?.payer_info?.payer_name || {};

  return [
    payerName.given_name,
    payerName.surname,
    payerName.alternate_full_name
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function summarizePayPalTransaction(detail) {
  const tx = detail?.transaction_info || {};
  const payer = detail?.payer_info || {};
  const items = extractPayPalItemDetails(detail);
  const detectedSku = extractPayPalDetectedSku(detail);
  const transactionId = normalizeAirtableCellValue(tx.transaction_id);
  const possibleSale = isLikelyPayPalSale(detail, detectedSku);

  return {
    transactionId,
    saleId: possibleSale && transactionId ? `PAYPAL-${transactionId}-${detectedSku}` : "",
    detectedSku,
    possibleSale,
    transactionDate: tx.transaction_initiation_date || tx.transaction_updated_date || "",
    transactionUpdatedDate: tx.transaction_updated_date || "",
    status: tx.transaction_status || "",
    eventCode: tx.transaction_event_code || "",
    transactionType: tx.transaction_event_type || tx.transaction_type || "",
    grossAmount: paypalAmount(tx.transaction_amount),
    feeAmount: paypalAmount(tx.fee_amount),
    netAmount: paypalAmount(tx.net_amount),
    currency: paypalCurrency(tx.transaction_amount) || paypalCurrency(tx.net_amount) || paypalCurrency(tx.fee_amount),
    invoiceId: tx.invoice_id || "",
    customField: tx.custom_field || "",
    subject: tx.transaction_subject || "",
    note: tx.transaction_note || tx.transaction_memo || "",
    payerEmail: payer.email_address || "",
    payerName: extractPayPalPayerName(detail),
    itemCount: items.length,
    itemPreview: items.slice(0, 3).map((item) => ({
      itemCode: item.item_code || item.sku || "",
      itemName: item.item_name || "",
      itemDescription: item.item_description || "",
      itemAmount: paypalAmount(item.item_amount),
      totalItemAmount: paypalAmount(item.total_item_amount),
      quantity: Number(item.item_quantity || item.quantity || 0) || ""
    })),
    textSourcesChecked: extractPayPalTextSources(detail).slice(0, 8)
  };
}

function isoDateWithMilliseconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function fetchPayPalTransactions({ days }) {
  requirePayPalConfig();

  const accessToken = await getPayPalAccessToken();
  const safeDays = Math.max(1, Math.min(Number(days || CFG.lookbackDays || 30), 31));
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - safeDays * 24 * 60 * 60 * 1000);
  const transactions = [];

  for (let page = 1; page <= 20; page += 1) {
    const url = new URL(`${CFG.paypalApiBase}/v1/reporting/transactions`);

    url.searchParams.set("start_date", isoDateWithMilliseconds(startDate));
    url.searchParams.set("end_date", isoDateWithMilliseconds(endDate));
    url.searchParams.set("fields", "all");
    url.searchParams.set("page_size", "100");
    url.searchParams.set("page", String(page));

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`
      }
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(`PayPal Transaction Search failed: ${response.status} ${JSON.stringify(payload)}`);
    }

    const details = Array.isArray(payload.transaction_details) ? payload.transaction_details : [];
    transactions.push(...details);

    const totalPages = Number(payload.total_pages || 1);

    if (!details.length || page >= totalPages) break;
  }

  return transactions;
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

function determinePayoutStatus({ sku, ownerName, payoutPeriodRecordId, existingPayoutStatus }) {
  const currentStatus = normalizeAirtableCellValue(existingPayoutStatus);

  if (currentStatus === "Paid Out" || currentStatus === "Held") {
    return currentStatus;
  }

  const cleanOwnerName = String(firstArrayValue(ownerName) || "").trim();
  const prefix = String(sku || "").trim().charAt(0).toUpperCase();

  if (prefix === "A" || cleanOwnerName === "FF") {
    return "Not Applicable";
  }

  if (payoutPeriodRecordId) {
    return "Ready for Payout";
  }

  return "Issue";
}

function buildSalesFields({ order, lineItem, inventory, ownerName, ownerRecordId, payoutPeriodRecordId }) {
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
    "Final Service Notes": normalizeAirtableCellValue(inv["Final Service Notes"]),
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
    "Payout Status": determinePayoutStatus({
      sku,
      ownerName,
      payoutPeriodRecordId
    }),
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

function buildBackfillFields({ salesRecord, inventory, ownerName, ownerRecordId, payoutPeriodRecordId }) {
  const sales = salesRecord.fields || {};
  const inv = inventory?.fields || {};
  const sku = String(sales["SKU"] || "").trim();
  const saleChannel = normalizeAirtableCellValue(sales["Sale Channel"]) || "Shopify";
  const saleSource = normalizeAirtableCellValue(sales["Sale Source"]) || "Direct Shopify";
  const orderSubtotal = normalizeCurrency(sales["Order Subtotal"]);

  const fields = {
    "Inventory Record ID": inventory?.recordId || "",
    "Added Parts": normalizeAirtableCellValue(inv["Added Parts"]),
    "Final Service Notes": normalizeAirtableCellValue(inv["Final Service Notes"]),
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
    }),
    "Payout Status": determinePayoutStatus({
      sku,
      ownerName,
      payoutPeriodRecordId,
      existingPayoutStatus: sales["Payout Status"]
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

function requireShipStationConfig() {
  if (!CFG.shipStationApiKey || !CFG.shipStationApiSecret) {
    throw new Error("Missing SHIPSTATION_API_KEY or SHIPSTATION_API_SECRET");
  }
}

function shipStationAuthHeader() {
  requireShipStationConfig();

  return `Basic ${Buffer.from(`${CFG.shipStationApiKey}:${CFG.shipStationApiSecret}`).toString("base64")}`;
}

async function shipStationGetJson(path, params = {}) {
  const url = new URL(`${CFG.shipStationApiBase}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      Authorization: shipStationAuthHeader()
    }
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`ShipStation request failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function shipStationPostJson(path, body) {
  const response = await fetch(`${CFG.shipStationApiBase}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: shipStationAuthHeader(),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`ShipStation POST failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  return payload;
}

function compactObject(value) {
  if (Array.isArray(value)) {
    return value.map(compactObject);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const output = {};

  for (const [key, childValue] of Object.entries(value)) {
    if (childValue === undefined || childValue === null || childValue === "") continue;
    output[key] = compactObject(childValue);
  }

  return output;
}

function sanitizeShipStationItemForUpdate(item) {
  return compactObject({
    lineItemKey: item.lineItemKey,
    sku: item.sku,
    name: item.name,
    imageUrl: item.imageUrl,
    weight: item.weight,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    taxAmount: item.taxAmount,
    shippingAmount: item.shippingAmount,
    warehouseLocation: item.warehouseLocation,
    options: Array.isArray(item.options) ? item.options : undefined,
    productId: item.productId,
    fulfillmentSku: item.fulfillmentSku,
    adjustment: item.adjustment,
    upc: item.upc
  });
}

function sanitizeShipStationOrderForUpdate(order) {
  return compactObject({
    orderNumber: order.orderNumber,
    orderKey: order.orderKey,
    orderDate: order.orderDate,
    paymentDate: order.paymentDate,
    shipByDate: order.shipByDate,
    orderStatus: order.orderStatus,
    customerUsername: order.customerUsername,
    customerEmail: order.customerEmail,
    billTo: order.billTo,
    shipTo: order.shipTo,
    items: Array.isArray(order.items) ? order.items.map(sanitizeShipStationItemForUpdate) : [],
    amountPaid: order.amountPaid,
    taxAmount: order.taxAmount,
    shippingAmount: order.shippingAmount,
    customerNotes: order.customerNotes,
    internalNotes: order.internalNotes,
    gift: order.gift,
    giftMessage: order.giftMessage,
    paymentMethod: order.paymentMethod,
    requestedShippingService: order.requestedShippingService,
    carrierCode: order.carrierCode,
    serviceCode: order.serviceCode,
    packageCode: order.packageCode,
    confirmation: order.confirmation,
    shipDate: order.shipDate,
    holdUntilDate: order.holdUntilDate,
    weight: order.weight,
    dimensions: order.dimensions,
    insuranceOptions: order.insuranceOptions,
    internationalOptions: order.internationalOptions,
    advancedOptions: order.advancedOptions,
    tagIds: order.tagIds
  });
}

async function fetchShipStationOpenOrders() {
  const statuses = CFG.shipStationRepairStatuses.length
    ? CFG.shipStationRepairStatuses
    : ["awaiting_shipment", "on_hold", "awaiting_payment"];

  const allOrders = [];

  for (const status of statuses) {
    for (let page = 1; page <= CFG.shipStationMaxPages; page += 1) {
      const payload = await shipStationGetJson("/orders", {
        orderStatus: status,
        page,
        pageSize: CFG.shipStationPageSize,
        sortBy: "ModifyDate",
        sortDir: "DESC"
      });

      const orders = Array.isArray(payload.orders) ? payload.orders : [];
      allOrders.push(...orders);

      const pages = Number(payload.pages || 1);

      if (!orders.length || page >= pages) break;
    }
  }

  const byOrderId = new Map();

  for (const order of allOrders) {
    const key = order.orderId || `${order.orderNumber || ""}-${order.orderKey || ""}`;

    if (key && !byOrderId.has(key)) {
      byOrderId.set(key, order);
    }
  }

  return Array.from(byOrderId.values());
}

async function fetchShipStationOrderById(orderId) {
  if (!orderId) {
    throw new Error("Missing ShipStation orderId for full order fetch");
  }

  return shipStationGetJson(`/orders/${orderId}`);
}

function buildUpdatedShipStationItemsFromFullOrder(fullOrder, changedItemsById, changedItemsByLineKey) {
  const fullItems = Array.isArray(fullOrder.items) ? fullOrder.items : [];

  return fullItems.map((fullItem) => {
    const byIdKey = String(fullItem.orderItemId || "");
    const byLineKey = String(fullItem.lineItemKey || "");
    const changedItem =
      (byIdKey && changedItemsById.get(byIdKey)) ||
      (byLineKey && changedItemsByLineKey.get(byLineKey));

    if (!changedItem) {
      return fullItem;
    }

    return {
      ...fullItem,
      sku: changedItem.sku,
      warehouseLocation: changedItem.warehouseLocation
    };
  });
}

function stringifyShipStationItemOptions(item) {
  if (!Array.isArray(item.options)) return "";

  return item.options
    .map((option) => [
      option.name,
      option.value
    ].filter(Boolean).join(": "))
    .filter(Boolean)
    .join(" ");
}

function detectExplicitSkuTagFromText(value) {
  const cleanText = normalizeAirtableCellValue(value);

  if (!cleanText) return "";

  const match = cleanText.match(/(?:^|\b)SKU\s*[:#-]?\s*([ACT]\d{8}(?:[A-Z0-9]{0,4})?(?:_[A-Z0-9]+)?)(?=$|[^A-Z0-9])/i);

  return match?.[1] ? match[1].toUpperCase() : "";
}

function detectShipStationItemSku(item) {
  const currentSku = normalizeAirtableCellValue(item?.sku);

  if (currentSku) {
    return {
      sku: currentSku.toUpperCase(),
      source: "shipstation_item_sku"
    };
  }

  const textSources = [
    item?.name,
    item?.lineItemKey,
    item?.productId,
    item?.fulfillmentSku,
    stringifyShipStationItemOptions(item)
  ];

  for (const source of textSources) {
    const sku = detectExplicitSkuTagFromText(source);

    if (sku) {
      return {
        sku,
        source: "explicit_sku_tag"
      };
    }
  }

  return {
    sku: "",
    source: ""
  };
}

function getInventoryLocation(inventoryRecord) {
  const fields = inventoryRecord?.fields || {};
  return normalizeAirtableCellValue(fields.Location || fields["Warehouse Location"] || "");
}

async function buildShipStationLocationRepairPreview() {
  const orders = await fetchShipStationOpenOrders();
  const inventoryCache = new Map();
  const rows = [];

  let itemsScanned = 0;

  for (const order of orders) {
    const items = Array.isArray(order.items) ? order.items : [];

    for (const item of items) {
      itemsScanned += 1;

      const currentSku = normalizeAirtableCellValue(item.sku);
      const currentLocation = normalizeAirtableCellValue(item.warehouseLocation);
      const detected = detectShipStationItemSku(item);

      let inventoryRecord = null;
      let airtableLocation = "";
      let action = "review";
      let reason = "";

      if (!detected.sku) {
        reason = "missing_sku";
      } else {
        if (inventoryCache.has(detected.sku)) {
          inventoryRecord = inventoryCache.get(detected.sku);
        } else {
          inventoryRecord = await findInventoryBySku(detected.sku);
          inventoryCache.set(detected.sku, inventoryRecord);
        }

        airtableLocation = getInventoryLocation(inventoryRecord);

        if (!inventoryRecord) {
          reason = "inventory_record_not_found";
        } else if (!airtableLocation) {
          reason = "airtable_location_blank";
        } else if (currentSku && currentSku.toUpperCase() !== detected.sku) {
          action = "review";
          reason = "sku_mismatch_existing_shipstation_sku";
        } else if (currentLocation === airtableLocation && currentSku) {
          action = "no_op";
          reason = "sku_and_location_already_correct";
        } else if (currentLocation === airtableLocation && !currentSku) {
          action = "update_candidate";
          reason = "sku_blank_location_already_correct";
        } else {
          action = "update_candidate";
          reason = currentLocation ? "location_differs" : "location_blank";
        }
      }

      rows.push({
        orderId: order.orderId || "",
        orderNumber: order.orderNumber || "",
        orderKey: order.orderKey || "",
        orderStatus: order.orderStatus || "",
        orderDate: order.orderDate || "",
        storeId: order.storeId || "",
        customerName: order.shipTo?.name || order.billTo?.name || "",
        itemId: item.orderItemId || "",
        lineItemKey: item.lineItemKey || "",
        itemName: item.name || "",
        quantity: item.quantity || "",
        currentSku,
        detectedSku: detected.sku,
        detectionSource: detected.source,
        currentWarehouseLocation: currentLocation,
        airtableLocation,
        action,
        reason
      });
    }
  }

  return {
    ordersScanned: orders.length,
    itemsScanned,
    rows
  };
}

async function runShipStationLocationRepair({ dryRun }) {
  const orders = await fetchShipStationOpenOrders();
  const inventoryCache = new Map();
  const results = [];

  let itemsScanned = 0;
  let ordersUpdated = 0;
  let itemsUpdated = 0;

  for (const order of orders) {
    const originalItems = Array.isArray(order.items) ? order.items : [];
    let orderChanged = false;
    const updatedItems = [];

    for (const item of originalItems) {
      itemsScanned += 1;

      const currentSku = normalizeAirtableCellValue(item.sku);
      const currentLocation = normalizeAirtableCellValue(item.warehouseLocation);
      const detected = detectShipStationItemSku(item);

      let inventoryRecord = null;
      let airtableLocation = "";
      let action = "review";
      let reason = "";
      let updatedItem = { ...item };

      if (!detected.sku) {
        reason = "missing_sku";
      } else {
        if (inventoryCache.has(detected.sku)) {
          inventoryRecord = inventoryCache.get(detected.sku);
        } else {
          inventoryRecord = await findInventoryBySku(detected.sku);
          inventoryCache.set(detected.sku, inventoryRecord);
        }

        airtableLocation = getInventoryLocation(inventoryRecord);

        if (!inventoryRecord) {
          reason = "inventory_record_not_found";
        } else if (!airtableLocation) {
          reason = "airtable_location_blank";
        } else if (currentSku && currentSku.toUpperCase() !== detected.sku) {
          action = "review";
          reason = "sku_mismatch_existing_shipstation_sku";
        } else if (currentLocation === airtableLocation && currentSku) {
          action = "no_op";
          reason = "sku_and_location_already_correct";
        } else {
          action = "updated";
          reason = currentLocation ? "location_replaced_from_airtable" : "location_added_from_airtable";

          updatedItem = {
            ...updatedItem,
            sku: detected.sku,
            warehouseLocation: airtableLocation
          };

          orderChanged = true;
          itemsUpdated += 1;
        }
      }

      updatedItems.push(updatedItem);

      results.push({
        orderId: order.orderId || "",
        orderNumber: order.orderNumber || "",
        orderKey: order.orderKey || "",
        orderStatus: order.orderStatus || "",
        orderDate: order.orderDate || "",
        customerName: order.shipTo?.name || order.billTo?.name || "",
        itemId: item.orderItemId || "",
        itemName: item.name || "",
        quantity: item.quantity || "",
        currentSku,
        detectedSku: detected.sku,
        detectionSource: detected.source,
        currentWarehouseLocation: currentLocation,
        airtableLocation,
        action: dryRun && action === "updated" ? "dry_run_update_candidate" : action,
        reason
      });
    }

    if (orderChanged && !dryRun) {
      const fullOrder = await fetchShipStationOrderById(order.orderId);
      const changedItemsById = new Map();
      const changedItemsByLineKey = new Map();

      for (const item of updatedItems) {
        const idKey = String(item.orderItemId || "");
        const lineKey = String(item.lineItemKey || "");

        if (idKey) changedItemsById.set(idKey, item);
        if (lineKey) changedItemsByLineKey.set(lineKey, item);
      }

      const payload = sanitizeShipStationOrderForUpdate({
        ...fullOrder,
        orderKey: fullOrder.orderKey || order.orderKey,
        items: buildUpdatedShipStationItemsFromFullOrder(fullOrder, changedItemsById, changedItemsByLineKey)
      });

      await shipStationPostJson("/orders/createorder", payload);
      ordersUpdated += 1;
    } else if (orderChanged && dryRun) {
      ordersUpdated += 1;
    }
  }

  return {
    dryRun,
    ordersScanned: orders.length,
    itemsScanned,
    ordersUpdated,
    itemsUpdated,
    results
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "shopify-sales-importer",
    version: "1.10.2-shipstation-full-order-update"
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/jobs/shopify-sales/import", requireSecret, async (req, res) => {
  try {
    const routeDryRun = CFG.dryRun || String(req.query.dry_run || req.query.dryRun || "false").toLowerCase() === "true";
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
        ownerName,
        ownerRecordId,
        payoutPeriodRecordId
      });

      if (CFG.dryRun) {
        toCreate.push(fields);
      } else {
        toCreate.push(fields);
      }
    }

    const createdRecords = routeDryRun ? [] : await createSalesRecords(toCreate);

    res.json({
      ok: true,
      dryRun: routeDryRun,
      ordersScanned: orders.length,
      lineItemsScanned: candidates.length,
      skippedCount: skipped.length,
      createdCount: routeDryRun ? toCreate.length : createdRecords.length,
      skipped,
      created: routeDryRun
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
          ownerName,
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


app.get("/jobs/reverb-warehouse-sales/import", requireSecret, async (req, res) => {
  try {
    const routeDryRun = CFG.dryRun || String(req.query.dry_run || req.query.dryRun || "false").toLowerCase() === "true";
    const orders = await fetchReverbWarehouseOrders();
    const candidates = [];

    for (const order of orders) {
      const lineItems = extractReverbLineItems(order);

      for (const [itemIndex, item] of lineItems.entries()) {
        const sku = extractReverbSku(item);
        if (!sku) continue;

        const orderId = getReverbOrderId(order);
        candidates.push({
          saleId: `REVERB-WAREHOUSE-${orderId}-${sku || item?.id || itemIndex}`,
          order,
          item,
          itemIndex,
          allItems: lineItems,
          sku
        });
      }
    }

    const existingSaleIds = await findExistingSaleIds(candidates.map((candidate) => candidate.saleId));
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
      const saleDate = isoDateOnly(getReverbOrderDate(candidate.order));
      const payoutPeriodRecordId = await findPayoutPeriodRecordId(saleDate);

      const fields = buildReverbWarehouseSalesFields({
        order: candidate.order,
        item: candidate.item,
        itemIndex: candidate.itemIndex,
        allItems: candidate.allItems,
        inventory,
        ownerName,
        ownerRecordId,
        payoutPeriodRecordId
      });

      toCreate.push(fields);
    }

    const createdRecords = routeDryRun ? [] : await createSalesRecords(toCreate);

    res.json({
      ok: true,
      dryRun: routeDryRun,
      ordersScanned: orders.length,
      lineItemsScanned: candidates.length,
      skippedCount: skipped.length,
      createdCount: routeDryRun ? toCreate.length : createdRecords.length,
      skipped,
      created: routeDryRun
        ? toCreate.map((fields) => ({
            saleId: fields["Sale ID"],
            sku: fields["SKU"],
            orderNumber: fields["Order Number"],
            orderSubtotal: fields["Order Subtotal"]
          }))
        : createdRecords.map((record) => ({
            recordId: record.id,
            saleId: record.fields["Sale ID"],
            sku: record.fields["SKU"],
            orderNumber: record.fields["Order Number"]
          }))
    });
  } catch (error) {
    console.error("Reverb Warehouse sales import failed:", error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/jobs/reverb-main-sales/import", requireSecret, async (req, res) => {
  try {
    const routeDryRun = CFG.dryRun || String(req.query.dry_run || req.query.dryRun || "false").toLowerCase() === "true";
    const orders = await fetchReverbMainOrders();
    const candidates = [];

    for (const order of orders) {
      const lineItems = extractReverbLineItems(order);

      for (const [itemIndex, item] of lineItems.entries()) {
        const sku = extractReverbSku(item);
        if (!sku) continue;

        const orderId = getReverbOrderId(order);
        candidates.push({
          saleId: `REVERB-MAIN-${orderId}-${sku || item?.id || itemIndex}`,
          order,
          item,
          itemIndex,
          allItems: lineItems,
          sku
        });
      }
    }

    const existingSaleIds = await findExistingSaleIds(candidates.map((candidate) => candidate.saleId));
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
      const saleDate = isoDateOnly(getReverbOrderDate(candidate.order));
      const payoutPeriodRecordId = await findPayoutPeriodRecordId(saleDate);

      const fields = buildReverbMainSalesFields({
        order: candidate.order,
        item: candidate.item,
        itemIndex: candidate.itemIndex,
        allItems: candidate.allItems,
        inventory,
        ownerName,
        ownerRecordId,
        payoutPeriodRecordId
      });

      toCreate.push(fields);
    }

    const createdRecords = routeDryRun ? [] : await createSalesRecords(toCreate);

    res.json({
      ok: true,
      dryRun: routeDryRun,
      ordersScanned: orders.length,
      lineItemsScanned: candidates.length,
      skippedCount: skipped.length,
      createdCount: routeDryRun ? toCreate.length : createdRecords.length,
      skipped,
      created: routeDryRun
        ? toCreate.map((fields) => ({
            saleId: fields["Sale ID"],
            sku: fields["SKU"],
            orderNumber: fields["Order Number"],
            orderSubtotal: fields["Order Subtotal"]
          }))
        : createdRecords.map((record) => ({
            recordId: record.id,
            saleId: record.fields["Sale ID"],
            sku: record.fields["SKU"],
            orderNumber: record.fields["Order Number"]
          }))
    });
  } catch (error) {
    console.error("Reverb Main sales import failed:", error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/jobs/paypal-sales/preview", requireSecret, async (req, res) => {
  try {
    const days = Number(req.query.days || CFG.lookbackDays || 30);
    const transactions = await fetchPayPalTransactions({ days });
    const previews = transactions.map(summarizePayPalTransaction);

    res.json({
      ok: true,
      dryRun: true,
      endpointMode: "preview_only_no_airtable_writes",
      days: Math.max(1, Math.min(days, 31)),
      scannedCount: previews.length,
      detectedSkuCount: previews.filter((transaction) => transaction.detectedSku).length,
      possibleSaleCount: previews.filter((transaction) => transaction.possibleSale).length,
      transactions: previews
    });
  } catch (error) {
    console.error("PayPal preview failed:", error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/jobs/shipstation-order-location-repair/preview", requireSecret, async (req, res) => {
  try {
    const preview = await buildShipStationLocationRepairPreview();
    const rows = preview.rows;

    res.json({
      ok: true,
      dryRun: true,
      endpointMode: "preview_only_no_shipstation_writes",
      statusesScanned: CFG.shipStationRepairStatuses,
      ordersScanned: preview.ordersScanned,
      itemsScanned: preview.itemsScanned,
      updateCandidateCount: rows.filter((row) => row.action === "update_candidate").length,
      noOpCount: rows.filter((row) => row.action === "no_op").length,
      reviewCount: rows.filter((row) => row.action === "review").length,
      rows
    });
  } catch (error) {
    console.error("ShipStation order location repair preview failed:", error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/jobs/shipstation-order-location-repair/run", requireSecret, async (req, res) => {
  try {
    const queryDryRun = String(req.query.dry_run || "").toLowerCase();
    const dryRun = CFG.dryRun || queryDryRun === "true" || queryDryRun === "1";
    const result = await runShipStationLocationRepair({ dryRun });

    res.json({
      ok: true,
      endpointMode: dryRun ? "dry_run_no_shipstation_writes" : "live_shipstation_order_item_update",
      statusesScanned: CFG.shipStationRepairStatuses,
      ordersScanned: result.ordersScanned,
      itemsScanned: result.itemsScanned,
      ordersUpdated: result.ordersUpdated,
      itemsUpdated: result.itemsUpdated,
      updatedCount: result.results.filter((row) => row.action === "updated").length,
      dryRunUpdateCandidateCount: result.results.filter((row) => row.action === "dry_run_update_candidate").length,
      noOpCount: result.results.filter((row) => row.action === "no_op").length,
      reviewCount: result.results.filter((row) => row.action === "review").length,
      rows: result.results
    });
  } catch (error) {
    console.error("ShipStation order location repair run failed:", error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Shopify Sales Importer listening on port ${PORT}`);
});
