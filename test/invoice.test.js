const assert = require('node:assert/strict');
const { test } = require('node:test');
const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

const rice = { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 500, qty: 2 };
const ghee = { id: 2, sku: 'GHEE', name: 'Ghee', hsn: '0405', price: 1000, qty: 1 };

function bill(items, coupon = '') {
  const totals = pricing.computeTotals(items, coupon);
  const db = { orders: [], nextOrderId: 1001 };
  return orders.add(db, { ...totals, items, coupon, date: '15/03/2022' });
}

test('invoice matches billed totals and per-line GST for mixed HSN items with a capped coupon', () => {
  const order = bill([rice, ghee], 'SAVE10');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(
    { discount: figures.discount, tax: figures.tax, total: figures.total },
    { discount: order.discount, tax: order.tax, total: order.total }
  );
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [5, 46.25],
    [12, 111]
  ]);
  assert.deepEqual([figures.cgst, figures.sgst], [78.63, 78.62]);
});

test('invoice agrees with billing at the fallback GST rate without a coupon', () => {
  const order = bill([{ ...rice, hsn: '', price: 100, qty: 1 }]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 18);
  assert.equal(order.total, 118);
  assert.equal(figures.tax, 18);
  assert.equal(figures.cgst, 9);
  assert.equal(figures.sgst, 9);
  assert.equal(figures.total, 118);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice uses the billed HSN rates for an order without a coupon', () => {
  const order = bill([rice, ghee]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.subtotal, 2000);
  assert.equal(order.tax, 170);
  assert.equal(order.total, 2170);
  assert.deepEqual(figures.rows.map(({ hsn, gstPercent, lineTax }) => ({
    hsn, gstPercent, lineTax
  })), [
    { hsn: '1006', gstPercent: 5, lineTax: 50 },
    { hsn: '0405', gstPercent: 12, lineTax: 120 }
  ]);
  assert.equal(figures.cgst, 85);
  assert.equal(figures.sgst, 85);
  assert.equal(figures.tax, 170);
  assert.equal(figures.total, 2170);
});

test('invoice applies the percentage coupon cap before GST', () => {
  const order = bill([rice, ghee], 'SAVE10');
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.discount, 150);
  assert.equal(order.tax, 157.25);
  assert.equal(order.total, 2007.25);
  assert.equal(figures.discount, 150);
  assert.equal(figures.tax, 157.25);
  assert.equal(figures.total, 2007.25);
});

test('a flat coupon reduces taxable value at checkout and on the invoice', () => {
  const order = bill([{ ...rice, qty: 1 }], 'FLAT50');
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.discount, 50);
  assert.equal(order.tax, 22.5);
  assert.equal(order.total, 472.5);
  assert.equal(figures.discount, 50);
  assert.equal(figures.tax, 22.5);
  assert.equal(figures.total, 472.5);
});

test('invoice uses the same percentage, decimal, and zero GST rates as billing', () => {
  const items = [5, 0.05, 0].map((gstRate, index) => ({
    ...rice, id: index + 1, price: 100, qty: 1, gstRate
  }));
  const billed = pricing.computeTotals(items, '');
  const figures = invoice.computeInvoiceFigures({ items });

  assert.deepEqual(billed.lines.map((line) => line.tax), [5, 5, 0]);
  assert.deepEqual(figures.rows.map((row) => row.lineTax), [5, 5, 0]);
  assert.equal(figures.tax, 10);
  assert.equal(figures.cgst, 5);
  assert.equal(figures.sgst, 5);
});

test('printable invoice shows the billed GST and total without a mismatch notice', () => {
  const order = bill([rice, ghee], 'SAVE10');
  const html = invoice.render(order);

  assert.match(html, /5%<\/td><td[^>]*>₹46\.25/);
  assert.match(html, /12%<\/td><td[^>]*>₹111\.00/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹157\.25/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹2007\.25/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('printable invoice still warns when the recorded total differs', () => {
  const order = { ...bill([rice, ghee], 'SAVE10'), total: 2000 };
  const html = invoice.render(order);

  assert.match(html, /Accountant Reconciliation Notice/);
  assert.match(html, /recorded total \(₹2000\.00\) by \+₹7\.25/);
});

test('GST reconciliation reports a match for the billed order and skips cancelled orders', () => {
  const order = bill([rice, ghee], 'SAVE10');
  const cancelled = { ...order, id: 1002, status: 'cancelled' };
  const summary = reports.getGstReconciliation({ orders: [order, cancelled] });

  assert.equal(summary.totalChecked, 1);
  assert.equal(summary.mismatchCount, 0);
  assert.equal(summary.totalDelta, 0);
  assert.deepEqual(summary.rows, [{
    orderId: 1001,
    date: '15/03/2022',
    customer: 'Walk-in',
    coupon: 'SAVE10',
    ledgerSubtotal: 2000,
    ledgerDiscount: 150,
    ledgerTax: 157.25,
    ledgerTotal: 2007.25,
    invoiceDiscount: 150,
    invoiceTax: 157.25,
    invoiceTotal: 2007.25,
    delta: 0,
    matched: true
  }]);
});

test('CURRENT BEHAVIOUR: a tax-only mismatch is flagged by reconciliation but has no invoice notice', () => {
  const order = {
    ...bill([{ ...rice, hsn: '', price: 100, qty: 1 }]),
    tax: 5,
    discount: 0,
    total: 118
  };
  const summary = reports.getGstReconciliation({ orders: [order] });

  assert.equal(summary.mismatchCount, 1);
  assert.equal(summary.totalDelta, 0);
  assert.equal(summary.rows[0].matched, false);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});
