// Pure helpers for product batches (no DB access) - kept separate so the rules are easy to unit-test.
//
// Background (why this file exists):
//   - Every product has a top-level `stock` AND an optional `batches[]` array.
//   - As soon as `batches` has ANY entry, the whole system (Billing, Dashboard, Admin list) reads the stock as the SUM of
//     the batches and ignores the top-level `stock`.
//   - A legacy product (stock 10 @ cost 280, batches = []) therefore LOSES its old 10 units from view the moment a first
//     batch (e.g. 20 @ cost 300) is pushed: the screen shows only 20. `buildLegacyBatch` converts the loose top-level stock
//     into a real batch first, so the old stock keeps its own cost price and both batches are sold/costed separately.

const roundQty = (n) => Math.round((parseFloat(n) || 0) * 1000) / 1000;

const sumBatchStock = (batches) =>
  roundQty((batches || []).reduce((t, b) => t + (parseFloat(b.stock) || 0), 0));

// If the product has loose stock but no batch at all, returns the batch that represents that stock (else null).
function buildLegacyBatch(product) {
  const hasBatches = Array.isArray(product.batches) && product.batches.length > 0;
  const stock = roundQty(product.stock);
  if (hasBatches || stock <= 0) return null;
  return {
    batchId: "B-1",
    label: "",
    price: parseFloat(product.price) || 0,
    costPrice: parseFloat(product.costPrice) || 0,
    marketPrice: parseFloat(product.marketPrice) || parseFloat(product.price) || 0,
    discount: parseFloat(product.discount) || 0,
    stock,
    expiryDate: product.expiryDate || null,
  };
}

// Admin "Edit product" saves the batches array it loaded earlier. While the form was open, cashiers may have sold
// stock, so the submitted `stock` of existing batches is STALE. Rule: for batches that already exist in the DB the
// DB stock always wins (the form cannot edit batch stock anyway); other fields (price, cost, label, discount, expiry)
// come from the form; batches missing from the submission were removed by the admin; unknown batchIds are new.
// `B-old-<id>` is the auto-batch the form creates for a legacy product - its stock is the DB's current loose stock.
function mergeBatchesForUpdate(dbProduct, submitted) {
  const dbBatches = Array.isArray(dbProduct.batches) ? dbProduct.batches : [];
  const byId = new Map(dbBatches.map((b) => [b.batchId, b]));
  const seen = new Set();
  const out = [];
  for (const s of submitted) {
    if (!s || !s.batchId || seen.has(s.batchId)) continue; // drop blanks and duplicate ids
    seen.add(s.batchId);
    const existing = byId.get(s.batchId);
    let stock;
    if (existing) stock = roundQty(existing.stock);
    else if (String(s.batchId).startsWith("B-old-") && dbBatches.length === 0) stock = roundQty(dbProduct.stock);
    else stock = roundQty(s.stock);
    out.push({
      batchId: s.batchId,
      label: s.label || "",
      price: parseFloat(s.price) || 0,
      costPrice: parseFloat(s.costPrice) || 0,
      marketPrice: parseFloat(s.marketPrice) || 0,
      discount: parseFloat(s.discount) || 0,
      stock,
      expiryDate: s.expiryDate || null,
    });
  }
  return out;
}

// Effective expiry of a product = the earliest expiry among batches that still have stock.
// Falls back to the product-level date when no in-stock batch carries its own date (legacy products).
function effectiveExpiry(product) {
  const dates = (product.batches || [])
    .filter((b) => (parseFloat(b.stock) || 0) > 0 && b.expiryDate)
    .map((b) => new Date(b.expiryDate))
    .filter((d) => !isNaN(d));
  if (dates.length > 0) return new Date(Math.min(...dates.map((d) => d.getTime())));
  return product.expiryDate ? new Date(product.expiryDate) : null;
}

// Which batch does a sale line hit? Normally the batchId the cashier screen sent. If the product HAS batches but the
// line carries no batchId (old offline cart / draft), and exactly one batch still has stock, that one is used - otherwise
// the sale would decrement only the loose top-level stock, the batches would never shrink and the shelf count would drift.
function resolveSaleBatch(product, batchId) {
  const batches = Array.isArray(product.batches) ? product.batches : [];
  if (batches.length === 0) return null;
  if (batchId) return batches.find((b) => b.batchId === batchId) || null;
  const active = batches.filter((b) => (parseFloat(b.stock) || 0) > 0);
  return active.length === 1 ? active[0] : null;
}

// Optional selling price typed on a GRN line. Blank = keep the current price. Returns { value } (null when blank) or { error }.
function parseSellingPrice(raw) {
  if (raw === undefined || raw === null || raw === "") return { value: null };
  const v = parseFloat(raw);
  if (!isFinite(v) || v <= 0) return { error: "The new selling price must be a number greater than 0!" };
  return { value: Math.round(v * 100) / 100 };
}

// Returns an error message (string) or null.
function validateProductInput({ price, costPrice, marketPrice, stock, discount, batches }) {
  const bad = (v) => v !== undefined && v !== null && v !== "" && (isNaN(parseFloat(v)) || parseFloat(v) < 0);
  if (bad(price)) return "Price must be a number that is not negative!";
  if (bad(costPrice)) return "Cost price must be a number that is not negative!";
  if (bad(marketPrice)) return "Market price must be a number that is not negative!";
  if (bad(stock)) return "Stock cannot be negative!";
  if (bad(discount) || parseFloat(discount) > 100) return "Discount must be between 0 and 100!";
  if (Array.isArray(batches)) {
    for (const b of batches) {
      if (bad(b.price) || bad(b.costPrice) || bad(b.marketPrice) || bad(b.stock) || bad(b.discount) || parseFloat(b.discount) > 100) {
        return "A batch has an invalid (negative or non-numeric) value!";
      }
    }
  }
  return null;
}

module.exports = { roundQty, sumBatchStock, buildLegacyBatch, mergeBatchesForUpdate, effectiveExpiry, resolveSaleBatch, parseSellingPrice, validateProductInput };