import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SHIPPING, defaultShippingFor, readShippingOptions,
  shippingForSubtotal, landedPriceFor, shippingForDeck,
} from '../server/lib/shipping.js';

const config = { enabled: true, perOrder: 1.29, freeOver: 5 };

test('shipping is added below the free threshold and waived above it', () => {
  assert.equal(shippingForSubtotal(4.99, config), 1.29);
  assert.equal(shippingForSubtotal(5, config), 0, 'exactly at the threshold ships free');
  assert.equal(shippingForSubtotal(12, config), 0);
});

test('a free-shipping threshold can make the pricier card the cheaper buy', () => {
  // This is the whole reason shipping belongs in the ranking.
  assert.equal(landedPriceFor(4.8, config), 6.09);
  assert.equal(landedPriceFor(5.2, config), 5.2);
  assert.ok(landedPriceFor(5.2, config) < landedPriceFor(4.8, config));
});

test('shipping is skipped entirely when switched off', () => {
  assert.equal(landedPriceFor(2, { ...config, enabled: false }), 2);
  assert.equal(shippingForDeck(2, { ...config, enabled: false, orders: 4 }), 0);
});

test('a zero rate adds nothing', () => {
  assert.equal(landedPriceFor(2, { enabled: true, perOrder: 0, freeOver: null }), 2);
});

test('no threshold means shipping always applies', () => {
  assert.equal(shippingForSubtotal(500, { enabled: true, perOrder: 2, freeOver: null }), 2);
});

test('deck shipping is charged per order, with the threshold applied per order', () => {
  // One order of $120 clears the threshold.
  assert.equal(shippingForDeck(120, { ...config, orders: 1 }), 0);
  // Four orders of $30 each still clear it.
  assert.equal(shippingForDeck(120, { ...config, orders: 4 }), 0);
  // Four orders of $3 each do not: 4 x 1.29.
  assert.equal(shippingForDeck(12, { ...config, orders: 4 }), 5.16);
  // One cheap order pays once.
  assert.equal(shippingForDeck(3, { ...config, orders: 1 }), 1.29);
});

test('request options are parsed and clamped', () => {
  const options = readShippingOptions({ shippingPerOrder: '2.5', shippingFreeOver: '25', orders: '3' }, 'USD');
  assert.deepEqual(options, { enabled: true, perOrder: 2.5, freeOver: 25, orders: 3, currency: 'USD', isEstimate: true });
});

test('absurd or missing values fall back to defaults', () => {
  const options = readShippingOptions({ shippingPerOrder: 'abc', orders: '999' }, 'USD');
  assert.equal(options.perOrder, DEFAULT_SHIPPING.USD.perOrder);
  assert.equal(options.orders, 20, 'orders are capped');
  assert.equal(readShippingOptions({ shippingPerOrder: '-5' }, 'USD').perOrder, 0);
  assert.equal(readShippingOptions({ shippingPerOrder: '99999' }, 'USD').perOrder, 100);
});

test('an empty free-over means no threshold', () => {
  assert.equal(readShippingOptions({ shippingFreeOver: '' }, 'USD').freeOver, null);
  assert.equal(readShippingOptions({ shippingFreeOver: 'none' }, 'USD').freeOver, null);
});

test('shipping can be switched off through the request', () => {
  assert.equal(readShippingOptions({ shipping: 'false' }, 'USD').enabled, false);
  assert.equal(readShippingOptions({ shipping: false }, 'USD').enabled, false);
  assert.equal(readShippingOptions({}, 'USD').enabled, true, 'on by default');
});

test('each market has its own default', () => {
  assert.equal(defaultShippingFor('EUR').perOrder, DEFAULT_SHIPPING.EUR.perOrder);
  assert.equal(defaultShippingFor('nonsense').perOrder, DEFAULT_SHIPPING.USD.perOrder);
});

test('defaults can be overridden per deployment', () => {
  process.env.SHIPPING_PER_ORDER_USD = '3.50';
  process.env.SHIPPING_FREE_OVER_USD = '40';
  try {
    assert.deepEqual(defaultShippingFor('USD'), { perOrder: 3.5, freeOver: 40 });
  } finally {
    delete process.env.SHIPPING_PER_ORDER_USD;
    delete process.env.SHIPPING_FREE_OVER_USD;
  }
});
