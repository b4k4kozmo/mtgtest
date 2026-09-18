import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../web/api-direct.js';
import { boltPrintings, splitCard } from './fixtures/cards.js';

/**
 * A fetch double that answers like Scryfall, so the browser transport can be
 * exercised without the network.
 */
function scryfallFetch({ onRequest = () => {} } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    onRequest(String(url), options);
    const u = new URL(String(url));
    const json = (body) => ({ ok: true, status: 200, json: async () => body });

    if (u.pathname === '/cards/autocomplete') {
      return json({ object: 'catalog', data: ['Lightning Bolt', 'Lightning Helix'] });
    }
    if (u.pathname === '/cards/named') {
      const wanted = (u.searchParams.get('fuzzy') ?? u.searchParams.get('exact') ?? '').toLowerCase();
      if (wanted.includes('fire')) return json(splitCard);
      if (wanted.includes('lightning')) return json(boltPrintings[1]);
      return { ok: false, status: 404, json: async () => ({ details: 'No card found.' }) };
    }
    if (u.pathname === '/cards/search') {
      const q = u.searchParams.get('q') ?? '';
      if (q.includes('split-oracle')) return json({ data: [splitCard], has_more: false });
      return json({ data: boltPrintings, has_more: false });
    }
    if (u.pathname === '/cards/collection') {
      const { identifiers } = JSON.parse(options.body);
      const pool = [...boltPrintings, splitCard];
      const found = [];
      const notFound = [];
      for (const id of identifiers) {
        const hit = pool.find((c) => c.name.toLowerCase() === String(id.name ?? '').toLowerCase());
        if (hit) found.push(hit);
        else notFound.push(id);
      }
      return json({ data: found, not_found: notFound });
    }
    return { ok: false, status: 404, json: async () => ({ details: 'unknown' }) };
  };
  impl.calls = calls;
  return impl;
}

const api = (fetchImpl) => createApi({ fetchImpl });

test('the static build reads card prices straight from Scryfall', async () => {
  const fetchImpl = scryfallFetch();
  const result = await api(fetchImpl).card({ q: 'Lightning Bolt', shipping: 'false' });

  assert.equal(result.card.name, 'Lightning Bolt');
  assert.equal(result.pricing.cheapest.price, 1.2);
  assert.equal(result.pricing.cheapest.vendorName, 'TCGplayer');
  assert.ok(fetchImpl.calls[0].url.startsWith('https://api.scryfall.com/'));
});

test('browser requests carry no custom headers, so no CORS preflight is forced', async () => {
  const fetchImpl = scryfallFetch();
  await api(fetchImpl).autocomplete({ q: 'light' });
  const sent = fetchImpl.calls[0].options.headers ?? {};
  assert.deepEqual(Object.keys(sent), [], 'a GET must stay a simple CORS request');
});

test('the same authenticity rules apply with no server in the loop', async () => {
  const { pricing } = await api(scryfallFetch()).card({ q: 'Lightning Bolt' });
  const sets = pricing.offers.map((offer) => offer.printing.set);
  for (const banned of ['CED', '30A', 'ANA', 'OVNT']) {
    assert.ok(!sets.includes(banned), `${banned} must not be offered`);
  }
  assert.ok(pricing.excluded.length > 0);
});

test('shipping applies in the static build too', async () => {
  const { pricing } = await api(scryfallFetch()).card({
    q: 'Lightning Bolt', shippingPerOrder: '1.29', shippingFreeOver: '5',
  });
  assert.equal(pricing.cheapest.shipping, 1.29);
  assert.equal(pricing.cheapest.landedPrice, 2.49);
});

test('deck lists price through the browser transport', async () => {
  const { totals, cards, missing } = await api(scryfallFetch()).deck({
    list: '4 Lightning Bolt\n2 Fire // Ice', shipping: false,
  });
  assert.equal(missing.length, 0);
  assert.equal(totals.cardCount, 6);
  assert.equal(cards.find((c) => c.name === 'Lightning Bolt').unitPrice, 1.2);
});

test('an empty deck list is rejected before any request goes out', async () => {
  const fetchImpl = scryfallFetch();
  await assert.rejects(() => api(fetchImpl).deck({ list: '   ' }), /Paste a deck list/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a missing card surfaces Scryfall’s own message', async () => {
  await assert.rejects(() => api(scryfallFetch()).card({ q: 'Zzzz Not A Card' }), /No card found/);
});

test('eBay reports itself unconfigured rather than leaking a secret into a public page', async () => {
  const result = await api(scryfallFetch()).listings({ name: 'Lightning Bolt' });
  assert.deepEqual(result, { configured: false, listings: [], error: null });
  const health = await api(scryfallFetch()).health();
  assert.equal(health.liveListings.ebay, false);
  assert.match(health.priceSource, /Scryfall/);
  assert.equal(health.mode, 'direct');
});

test('deals run against live data in the static build', async () => {
  const { theme, deals } = await api(scryfallFetch()).deals({ limit: 4 });
  assert.ok(theme.id);
  assert.ok(deals.length > 0);
  assert.ok(deals.every((deal) => deal.offer.price > 0 && deal.offer.url.startsWith('https://')));
});

test('the transport exposes the same surface as the server one', async () => {
  const direct = await import('../web/api-direct.js');
  const server = await import('../public/api.js');
  const surface = (m) => Object.keys(m).filter((k) => typeof m[k] === 'function').sort();
  assert.deepEqual(surface(direct).filter((k) => k !== 'createApi'), surface(server));
});
