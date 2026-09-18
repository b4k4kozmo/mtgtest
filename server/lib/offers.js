import { classifyPrinting } from './authenticity.js';
import { VENDORS, buildEbaySearchUrl, buildSearchVendorLinks } from './vendors.js';
import { shippingForSubtotal } from './shipping.js';

const FINISH_META = {
  nonfoil: { label: 'Non-foil', rank: 0 },
  foil: { label: 'Foil', rank: 1 },
  etched: { label: 'Etched foil', rank: 2 },
};

/** Scryfall price keys, per currency and finish. */
const PRICE_KEYS = {
  USD: { nonfoil: 'usd', foil: 'usd_foil', etched: 'usd_etched' },
  EUR: { nonfoil: 'eur', foil: 'eur_foil', etched: 'eur_etched' },
};

/** Which vendor supplies Scryfall's price for a given currency. */
const CURRENCY_VENDOR = { USD: 'tcgplayer', EUR: 'cardmarket' };

export const SUPPORTED_CURRENCIES = Object.keys(PRICE_KEYS);

/**
 * Pull the best available images off a printing, coping with the layouts where
 * art lives on `card_faces` instead of the top level (transform, modal DFC,
 * reversible cards).
 */
export function imagesFor(card) {
  const top = card?.image_uris;
  if (top) return { small: top.small, normal: top.normal, large: top.large ?? top.normal, art: top.art_crop };
  const face = Array.isArray(card?.card_faces)
    ? card.card_faces.find((f) => f && f.image_uris)
    : null;
  if (face?.image_uris) {
    const uris = face.image_uris;
    return { small: uris.small, normal: uris.normal, large: uris.large ?? uris.normal, art: uris.art_crop };
  }
  return { small: null, normal: null, large: null, art: null };
}

/** Compact, UI-ready view of a single printing. */
export function printingSummary(card) {
  return {
    id: card.id,
    oracleId: card.oracle_id,
    name: card.name,
    set: String(card.set || '').toUpperCase(),
    setName: card.set_name,
    setType: card.set_type,
    collectorNumber: card.collector_number,
    rarity: card.rarity,
    releasedAt: card.released_at,
    artist: card.artist,
    frameEffects: card.frame_effects ?? [],
    fullArt: card.full_art === true,
    promo: card.promo === true,
    borderColor: card.border_color,
    finishes: Array.isArray(card.finishes) ? card.finishes : [],
    typeLine: card.type_line,
    manaCost: card.mana_cost ?? card.card_faces?.[0]?.mana_cost ?? null,
    images: imagesFor(card),
    scryfallUri: card.scryfall_uri,
    prices: card.prices ?? {},
  };
}

function parsePrice(raw) {
  if (raw === null || raw === undefined) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Every buyable offer we can state a real price for on one printing.
 *
 * Only finishes the printing was actually released in are considered, so a
 * stale `usd_foil` on a non-foil-only printing cannot leak through.
 */
export function offersForPrinting(card, { currency = 'USD', shipping = null } = {}) {
  const keys = PRICE_KEYS[currency];
  if (!keys) return [];
  const vendor = VENDORS[CURRENCY_VENDOR[currency]];
  const purchaseUri = card.purchase_uris?.[vendor.id] ?? null;
  const released = Array.isArray(card.finishes) && card.finishes.length > 0 ? card.finishes : null;
  const summary = printingSummary(card);

  const offers = [];
  for (const [finish, key] of Object.entries(keys)) {
    if (released && !released.includes(finish)) continue;
    const price = parsePrice(card.prices?.[key]);
    if (price === null) continue;
    if (!purchaseUri) continue;
    const shippingCost = shippingForSubtotal(price, shipping ?? { enabled: false });
    offers.push({
      id: `${card.id}:${vendor.id}:${finish}`,
      vendorId: vendor.id,
      vendorName: vendor.name,
      vendorNote: vendor.note,
      vendorPriority: vendor.priority,
      vendorKind: vendor.kind,
      priceKind: 'market',
      price,
      shipping: shippingCost,
      landedPrice: Number((price + shippingCost).toFixed(2)),
      shippingFree: Boolean(shipping?.enabled) && shippingCost === 0,
      shippingIsEstimate: Boolean(shipping?.enabled),
      currency,
      finish,
      finishLabel: FINISH_META[finish].label,
      url: purchaseUri,
      printing: summary,
    });
  }
  return offers;
}

/** What a buyer actually pays: item plus shipping when shipping is switched on. */
export const payable = (offer) => offer.landedPrice ?? offer.price;

export function sortOffers(offers) {
  return [...offers].sort((a, b) => {
    // Shipping can flip the order: a pricier card that ships free can be the
    // cheaper one to get to your door.
    if (payable(a) !== payable(b)) return payable(a) - payable(b);
    if (a.price !== b.price) return a.price - b.price;
    if (a.vendorPriority !== b.vendorPriority) return a.vendorPriority - b.vendorPriority;
    const rankA = FINISH_META[a.finish]?.rank ?? 9;
    const rankB = FINISH_META[b.finish]?.rank ?? 9;
    if (rankA !== rankB) return rankA - rankB;
    // Same price and finish: prefer the printing that is easier to find today.
    return String(b.printing.releasedAt || '').localeCompare(String(a.printing.releasedAt || ''));
  });
}

/**
 * Offers close enough to the cheapest that they are a real alternative --
 * this is what backs the "similarly priced" gallery in the UI.
 *
 * The window is proportional with a small absolute floor, so bulk commons
 * (where $0.05 vs $0.35 is a 7x difference but pennies in practice) still
 * produce a useful set of alternatives.
 */
export function similarlyPriced(sorted, { limit = 12, ratio = 1.6, floor = 1 } = {}) {
  if (sorted.length === 0) return [];
  const cheapest = payable(sorted[0]);
  const ceiling = Math.max(cheapest * ratio, cheapest + floor);
  const seenPrintings = new Set();
  const picks = [];
  for (const offer of sorted) {
    if (payable(offer) > ceiling) break;
    // One entry per printing keeps the gallery visually varied.
    if (seenPrintings.has(offer.printing.id)) continue;
    seenPrintings.add(offer.printing.id);
    picks.push(offer);
    if (picks.length >= limit) break;
  }
  return picks;
}

/**
 * Turn a list of Scryfall printings into a priced, filtered, ranked result.
 *
 * @param {object[]} printings
 * @param {{ currency?: string, includeCollectibles?: boolean, finish?: string }} [options]
 */
export function buildCardPricing(printings, options = {}) {
  const { currency = 'USD', includeCollectibles = false, finish = 'any', shipping = null } = options;
  const kept = [];
  const excluded = [];

  for (const card of printings) {
    const verdict = classifyPrinting(card, { includeCollectibles });
    if (!verdict.ok) {
      excluded.push({ printing: printingSummary(card), reason: verdict.reason, code: verdict.code });
      continue;
    }
    kept.push(card);
  }

  let offers = kept.flatMap((card) => offersForPrinting(card, { currency, shipping }));
  if (finish !== 'any') offers = offers.filter((offer) => offer.finish === finish);

  const sorted = sortOffers(offers);
  return {
    currency,
    shipping: shipping?.enabled ? { ...shipping } : null,
    cheapest: sorted[0] ?? null,
    offers: sorted,
    similar: similarlyPriced(sorted),
    printings: kept.map(printingSummary),
    excluded,
    counts: {
      printingsConsidered: printings.length,
      printingsKept: kept.length,
      printingsExcluded: excluded.length,
      pricedOffers: sorted.length,
    },
  };
}

/** Reputable stores and marketplaces we can always point a shopper at. */
export function referenceLinksFor(card) {
  const links = buildSearchVendorLinks(card.name).map((vendor) => ({
    vendorId: vendor.id,
    vendorName: vendor.name,
    vendorNote: vendor.note,
    vendorPriority: vendor.priority,
    vendorKind: 'search',
    url: vendor.url,
  }));
  links.unshift({
    vendorId: 'ebay',
    vendorName: VENDORS.ebay.name,
    vendorNote: VENDORS.ebay.note,
    vendorPriority: VENDORS.ebay.priority,
    vendorKind: 'search',
    url: buildEbaySearchUrl(card.name, card.set_name),
  });
  return links.sort((a, b) => a.vendorPriority - b.vendorPriority);
}
