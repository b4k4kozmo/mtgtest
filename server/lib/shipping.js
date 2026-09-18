/**
 * Shipping.
 *
 * Only eBay gives us a real, per-listing shipping cost, and that number flows
 * straight through untouched. For TCGplayer and Cardmarket there is no public
 * per-seller shipping quote for a given card, so this module applies a clearly
 * labelled *estimate* that the visitor can edit, rather than quietly inventing
 * a figure and calling it a price.
 *
 * The free-shipping threshold matters more than it looks: it can reorder
 * results, because a $5.20 card that ships free beats a $4.80 card that does
 * not.
 */

/**
 * Starting points, not quotes. Every store sets its own rates and most let
 * sellers choose, so these are editable in the UI and overridable per
 * deployment through the environment.
 */
export const DEFAULT_SHIPPING = {
  USD: { perOrder: 1.29, freeOver: 5 },
  EUR: { perOrder: 1.5, freeOver: null },
};

const MAX_PER_ORDER = 100;
const MAX_ORDERS = 20;

/** Env lookup that also works in a browser, where `process` does not exist. */
const env = (name) => globalThis.process?.env?.[name];

export function defaultShippingFor(currency) {
  const base = DEFAULT_SHIPPING[currency] ?? DEFAULT_SHIPPING.USD;
  const envPerOrder = Number.parseFloat(env(`SHIPPING_PER_ORDER_${currency}`));
  const envFreeOver = Number.parseFloat(env(`SHIPPING_FREE_OVER_${currency}`));
  return {
    perOrder: Number.isFinite(envPerOrder) ? envPerOrder : base.perOrder,
    freeOver: Number.isFinite(envFreeOver) ? envFreeOver : base.freeOver,
  };
}

/**
 * Read and clamp the shipping settings a request asked for.
 *
 * @param {object} source query string or JSON body
 * @param {string} currency
 */
export function readShippingOptions(source = {}, currency = 'USD') {
  const defaults = defaultShippingFor(currency);
  const enabled = source.shipping === undefined ? true : source.shipping !== false && source.shipping !== 'false';

  const perOrder = clampNumber(source.shippingPerOrder, defaults.perOrder, 0, MAX_PER_ORDER);
  const freeOverRaw = source.shippingFreeOver;
  const freeOver =
    freeOverRaw === '' || freeOverRaw === null || freeOverRaw === 'none'
      ? null
      : clampNumber(freeOverRaw, defaults.freeOver, 0, 10000);
  const orders = Math.round(clampNumber(source.orders, 1, 1, MAX_ORDERS));

  return { enabled, perOrder, freeOver, orders, currency, isEstimate: true };
}

/**
 * Shipping added to a single order of `subtotal`.
 * Returns 0 when the order clears the free-shipping threshold.
 */
export function shippingForSubtotal(subtotal, { enabled = true, perOrder = 0, freeOver = null } = {}) {
  if (!enabled || !(perOrder > 0)) return 0;
  if (freeOver !== null && freeOver !== undefined && subtotal >= freeOver) return 0;
  return round2(perOrder);
}

/** What one card actually costs to get to your door, on its own. */
export function landedPriceFor(price, config) {
  return round2(price + shippingForSubtotal(price, config));
}

/**
 * Shipping across a deck order split into `orders` shipments. The threshold is
 * applied per shipment, since that is how stores actually charge it.
 */
export function shippingForDeck(subtotal, config) {
  const { enabled = true, perOrder = 0, orders = 1 } = config ?? {};
  if (!enabled || !(perOrder > 0)) return 0;
  const perShipment = orders > 0 ? subtotal / orders : subtotal;
  return round2(shippingForSubtotal(perShipment, config) * orders);
}

function clampNumber(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

const round2 = (value) => Number(value.toFixed(2));
