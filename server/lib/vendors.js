import { MARKETPLACE_NEGATIVE_KEYWORDS } from './authenticity.js';

/**
 * Vendor registry.
 *
 * `priority` breaks ties when two offers cost the same: lower wins. The order
 * reflects how established the seller is for Magic singles, with the two big
 * marketplaces that Scryfall gives us live pricing for at the top.
 *
 * `kind`:
 *   'market'  -- we have a real, dated price for this exact printing.
 *   'search'  -- reputable store, but no public price API; we deep-link into
 *                their catalogue search instead of inventing a number.
 */
export const VENDORS = {
  tcgplayer: {
    id: 'tcgplayer',
    name: 'TCGplayer',
    priority: 1,
    currency: 'USD',
    kind: 'market',
    region: 'US',
    note: 'Largest US marketplace for Magic singles, with buyer protection on direct orders.',
  },
  cardmarket: {
    id: 'cardmarket',
    name: 'Cardmarket',
    priority: 2,
    currency: 'EUR',
    kind: 'market',
    region: 'EU',
    note: 'Largest European marketplace for Magic singles.',
  },
  ebay: {
    id: 'ebay',
    name: 'eBay',
    priority: 3,
    currency: 'USD',
    kind: 'listing',
    region: 'US',
    note: 'Live listings, screened for proxy / custom / altered wording.',
  },
  cardkingdom: {
    id: 'cardkingdom',
    name: 'Card Kingdom',
    priority: 4,
    currency: 'USD',
    kind: 'search',
    region: 'US',
    note: 'Long-established US store, grades conservatively.',
  },
  starcitygames: {
    id: 'starcitygames',
    name: 'Star City Games',
    priority: 5,
    currency: 'USD',
    kind: 'search',
    region: 'US',
    note: 'Long-established US store and tournament organiser.',
  },
  coolstuffinc: {
    id: 'coolstuffinc',
    name: 'CoolStuffInc',
    priority: 6,
    currency: 'USD',
    kind: 'search',
    region: 'US',
    note: 'Established US store with a large singles catalogue.',
  },
};

/** Vendors we can send a shopper to even when we have no live price. */
const SEARCH_VENDOR_IDS = ['cardkingdom', 'starcitygames', 'coolstuffinc'];

/**
 * eBay category 183454 is "Collectible Card Games > CCG Individual Cards",
 * which keeps sleeves, playmats and sealed product out of the results.
 */
const EBAY_CCG_SINGLES_CATEGORY = '183454';

/**
 * Build an eBay search URL scoped to genuine single cards: fixed-price only,
 * sorted by price + shipping, with proxy vocabulary excluded via eBay's
 * `-(a,b,c)` negative-keyword syntax.
 */
export function buildEbaySearchUrl(cardName, setName) {
  const terms = ['mtg', quoteIfNeeded(cardName)];
  if (setName) terms.push(quoteIfNeeded(setName));
  const negatives = `-(${MARKETPLACE_NEGATIVE_KEYWORDS.join(',')})`;
  const params = new URLSearchParams({
    _nkw: `${terms.join(' ')} ${negatives}`,
    _sacat: EBAY_CCG_SINGLES_CATEGORY,
    _sop: '15', // price + shipping: lowest first
    LH_BIN: '1', // Buy It Now, so the displayed price is the price you pay
  });
  return `https://www.ebay.com/sch/i.html?${params.toString()}`;
}

function quoteIfNeeded(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return /\s/.test(text) ? `"${text}"` : text;
}

/** Deep links into the reputable stores that have no public price API. */
export function buildSearchVendorLinks(cardName) {
  const name = String(cardName || '').trim();
  if (!name) return [];
  const encoded = encodeURIComponent(name);
  const urls = {
    cardkingdom: `https://www.cardkingdom.com/catalog/search?search=header&filter%5Bname%5D=${encoded}`,
    starcitygames: `https://starcitygames.com/search/?search_query=${encoded}`,
    coolstuffinc: `https://www.coolstuffinc.com/main_search.php?q=${encoded}&pa=searchOnSale&page=1&resultsPerPage=25`,
  };
  return SEARCH_VENDOR_IDS.map((id) => ({
    ...VENDORS[id],
    url: urls[id],
  }));
}

export function vendorPriority(vendorId) {
  return VENDORS[vendorId]?.priority ?? 99;
}
