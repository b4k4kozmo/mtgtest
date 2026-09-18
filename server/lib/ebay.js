import { TtlCache } from './cache.js';
import { looksLikeProxyListing, titleMentionsCard, MARKETPLACE_NEGATIVE_KEYWORDS } from './authenticity.js';

const OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const BROWSE_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const CCG_SINGLES_CATEGORY = '183454';

/** Sellers below these thresholds are dropped: "reputable vendors" only. */
const MIN_FEEDBACK_PERCENT = 95;
const MIN_FEEDBACK_SCORE = 10;

/**
 * Optional live-listing source.
 *
 * With `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` set, this returns real eBay
 * listings including the seller's own photo, which is what powers the
 * "pictures of similarly priced listings" strip. Without credentials it
 * reports `configured: false` and the UI falls back to a pre-filtered eBay
 * search link -- it never invents a price.
 */
export function createEbayClient({
  fetchImpl = globalThis.fetch,
  clientId = process.env.EBAY_CLIENT_ID,
  clientSecret = process.env.EBAY_CLIENT_SECRET,
  marketplaceId = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US',
  cache = new TtlCache({ ttlMs: 15 * 60 * 1000, maxEntries: 500 }),
} = {}) {
  const configured = Boolean(clientId && clientSecret);
  let token = null;
  let tokenExpiresAt = 0;

  async function getToken() {
    if (token && Date.now() < tokenExpiresAt - 60_000) return token;
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetchImpl(OAUTH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'https://api.ebay.com/oauth/api_scope',
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(`eBay auth failed with status ${response.status}.`);
    }
    const payload = await response.json();
    token = payload.access_token;
    tokenExpiresAt = Date.now() + (payload.expires_in ?? 7200) * 1000;
    return token;
  }

  return {
    get configured() {
      return configured;
    },

    /**
     * @returns {Promise<{configured: boolean, listings: object[], error: string|null}>}
     */
    async searchListings(cardName, { setName = null, limit = 8 } = {}) {
      if (!configured) return { configured: false, listings: [], error: null };
      const name = String(cardName || '').trim();
      if (!name) return { configured: true, listings: [], error: null };

      const key = `ebay:${marketplaceId}:${name.toLowerCase()}:${setName ?? ''}:${limit}`;
      try {
        return await cache.wrap(key, async () => {
          const accessToken = await getToken();
          const terms = ['mtg', `"${name}"`];
          if (setName) terms.push(`"${setName}"`);
          const params = new URLSearchParams({
            q: `${terms.join(' ')} -(${MARKETPLACE_NEGATIVE_KEYWORDS.join(',')})`,
            category_ids: CCG_SINGLES_CATEGORY,
            filter: 'buyingOptions:{FIXED_PRICE}',
            sort: 'price',
            limit: String(Math.min(limit * 4, 50)),
          });
          const response = await fetchImpl(`${BROWSE_URL}?${params.toString()}`, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw new Error(`eBay search failed with status ${response.status}.`);
          const payload = await response.json();
          const listings = (payload.itemSummaries ?? [])
            .map((item) => normalizeListing(item))
            .filter((listing) => listing !== null && isTrustworthy(listing, name))
            .sort((a, b) => a.totalPrice - b.totalPrice)
            .slice(0, limit);
          return { configured: true, listings, error: null };
        });
      } catch (err) {
        // A marketplace outage must never take the page down.
        return { configured: true, listings: [], error: err.message };
      }
    },
  };
}

function normalizeListing(item) {
  const price = Number.parseFloat(item?.price?.value);
  if (!Number.isFinite(price)) return null;
  const shipping = Number.parseFloat(item?.shippingOptions?.[0]?.shippingCost?.value ?? '0');
  const shippingCost = Number.isFinite(shipping) ? shipping : 0;
  return {
    id: item.itemId,
    title: item.title ?? '',
    price,
    shipping: shippingCost,
    totalPrice: Number((price + shippingCost).toFixed(2)),
    currency: item?.price?.currency ?? 'USD',
    condition: item.condition ?? null,
    imageUrl: item?.image?.imageUrl ?? item?.thumbnailImages?.[0]?.imageUrl ?? null,
    url: item.itemWebUrl,
    seller: {
      name: item?.seller?.username ?? null,
      feedbackPercent: Number.parseFloat(item?.seller?.feedbackPercentage ?? 'NaN'),
      feedbackScore: Number.parseInt(item?.seller?.feedbackScore ?? 'NaN', 10),
    },
    location: item?.itemLocation?.country ?? null,
    vendorId: 'ebay',
    vendorName: 'eBay',
  };
}

/** Reject proxies, unrelated items, and low-reputation sellers. */
export function isTrustworthy(listing, cardName) {
  if (looksLikeProxyListing(listing.title)) return false;
  if (!titleMentionsCard(listing.title, cardName)) return false;
  const { feedbackPercent, feedbackScore } = listing.seller;
  if (Number.isFinite(feedbackPercent) && feedbackPercent < MIN_FEEDBACK_PERCENT) return false;
  if (Number.isFinite(feedbackScore) && feedbackScore < MIN_FEEDBACK_SCORE) return false;
  return true;
}
