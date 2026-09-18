import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createFakeScryfall, createFakeEbay } from './helpers/fakeScryfall.js';

let server;
let base;
let scryfall;

before(async () => {
  scryfall = createFakeScryfall();
  const app = createApp({
    scryfall,
    ebay: createFakeEbay({
      configured: true,
      listings: [{
        id: 'v1|1|1',
        title: 'MTG Lightning Bolt M10 NM English',
        price: 2.1, shipping: 0.99, totalPrice: 3.09, currency: 'USD',
        condition: 'Used', imageUrl: 'https://i.ebayimg.com/x.jpg',
        url: 'https://www.ebay.com/itm/1',
        seller: { name: 'cardshop', feedbackPercent: 99.8, feedbackScore: 4200 },
        location: 'US', vendorId: 'ebay', vendorName: 'eBay',
      }],
    }),
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const get = async (path) => {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
};

const post = async (path, payload) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
};

test('GET /api/health reports the price source and vendor list', async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.match(body.priceSource, /Scryfall/);
  assert.ok(body.vendors.some((v) => v.id === 'tcgplayer'));
  // Vendors are ordered most-reputable first.
  assert.equal(body.vendors[0].id, 'tcgplayer');
});

test('GET /api/card returns the cheapest genuine printing with an image', async () => {
  const { status, body } = await get('/api/card?q=Lightning%20Bolt');
  assert.equal(status, 200);
  assert.equal(body.card.name, 'Lightning Bolt');
  assert.ok(body.card.images.normal.startsWith('https://cards.scryfall.io/'));
  assert.equal(body.pricing.cheapest.price, 1.2);
  assert.equal(body.pricing.cheapest.vendorName, 'TCGplayer');
  assert.ok(body.pricing.cheapest.url.startsWith('https://www.tcgplayer.com/'));
  assert.ok(body.pricing.similar.length > 1, 'similar printings back the gallery');
  assert.ok(body.pricing.similar.every((offer) => offer.printing.images.normal));
});

test('GET /api/card never returns a proxy-adjacent printing', async () => {
  const { body } = await get('/api/card?q=Lightning%20Bolt');
  const sets = body.pricing.offers.map((offer) => offer.printing.set);
  for (const banned of ['CED', '30A', 'ANA', 'OVNT']) {
    assert.ok(!sets.includes(banned), `${banned} must not be offered`);
  }
  assert.ok(body.pricing.excluded.length > 0, 'and the user is told what was hidden');
  assert.ok(body.pricing.excluded.every((item) => item.reason));
});

test('GET /api/card honours the currency switch', async () => {
  const { body } = await get('/api/card?q=Lightning%20Bolt&currency=EUR');
  assert.equal(body.pricing.currency, 'EUR');
  assert.equal(body.pricing.cheapest.vendorName, 'Cardmarket');
});

test('GET /api/card falls back to USD for an unsupported currency', async () => {
  const { body } = await get('/api/card?q=Lightning%20Bolt&currency=XYZ');
  assert.equal(body.pricing.currency, 'USD');
});

test('GET /api/card always offers reputable store links, proxy-filtered', async () => {
  const { body } = await get('/api/card?q=Lightning%20Bolt');
  const ids = body.links.map((link) => link.vendorId);
  assert.deepEqual(ids, ['ebay', 'cardkingdom', 'starcitygames', 'coolstuffinc']);
  const ebay = body.links.find((link) => link.vendorId === 'ebay');
  assert.match(decodeURIComponent(ebay.url), /-\(proxy,proxies,custom/);
});

test('GET /api/card 404s cleanly for an unknown card', async () => {
  const { status, body } = await get('/api/card?q=Definitely%20Not%20A%20Card%20Zzz');
  assert.equal(status, 404);
  assert.ok(body.error);
});

test('GET /api/listings returns screened live listings', async () => {
  const { body } = await get('/api/listings?name=Lightning%20Bolt');
  assert.equal(body.configured, true);
  assert.equal(body.listings[0].totalPrice, 3.09);
  assert.ok(body.listings[0].imageUrl);
});

test('GET /api/listings rejects an empty name', async () => {
  const { status } = await get('/api/listings?name=');
  assert.equal(status, 400);
});

test('POST /api/deck prices a mixed-format deck list', async () => {
  const list = [
    'Deck',
    '4 Lightning Bolt',
    '2 Fire // Ice (APC) 128',
    "1 Agadeem's Awakening",
    '',
    'Sideboard',
    '2 Lightning Bolt (M10) 146',
  ].join('\n');

  const { status, body } = await post('/api/deck', { list });
  assert.equal(status, 200);
  assert.equal(body.totals.cardCount, 9);
  assert.equal(body.missing.length, 0);

  const bolt = body.cards.find((c) => c.name === 'Lightning Bolt' && c.section === 'main');
  assert.equal(bolt.quantity, 4);
  assert.equal(bolt.unitPrice, 1.2, 'the cheapest genuine printing wins');
  assert.equal(bolt.lineTotal, 4.8);
  assert.ok(bolt.images.small, 'every deck row has a card image');

  // 4 x 1.20 + 2 x 0.75 + 1 x 14.99 + 2 x 1.20 = 23.69
  assert.equal(body.totals.total, 23.69);
  assert.deepEqual(body.totals.bySection.map((s) => s.section).sort(), ['main', 'sideboard']);
});

test('POST /api/deck resolves a split card by either half', async () => {
  const { body } = await post('/api/deck', { list: '1 Fire\n1 Ice' });
  assert.equal(body.missing.length, 0);
  assert.ok(body.cards.every((card) => card.name === 'Fire // Ice'));
});

test('POST /api/deck reports unknown cards instead of dropping them', async () => {
  const { body } = await post('/api/deck', { list: '4 Lightning Bolt\n2 Blightning Zolt' });
  assert.equal(body.cards.length, 1);
  assert.equal(body.missing.length, 1);
  assert.match(body.missing[0].name, /Blightning Zolt/);
  assert.equal(body.missing[0].quantity, 2);
});

test('POST /api/deck surfaces unreadable lines', async () => {
  const { body } = await post('/api/deck', { list: '4 Lightning Bolt\n%%%%' });
  assert.equal(body.parse.errors.length, 1);
  assert.equal(body.parse.errors[0].lineNumber, 2);
});

test('POST /api/deck batches lookups instead of calling per card', async () => {
  const before = { ...scryfall.calls };
  const list = Array.from({ length: 20 }, (_, i) => `1 Lightning Bolt (M10) ${146 + (i % 1)}`).join('\n');
  await post('/api/deck', { list });
  assert.equal(scryfall.calls.collection - before.collection, 1);
  assert.equal(scryfall.calls.cheapestPrintingsByOracleIds - before.cheapestPrintingsByOracleIds, 1);
});

test('POST /api/deck rejects an empty body', async () => {
  const { status, body } = await post('/api/deck', { list: '   ' });
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('POST /api/deck falls back when the requested finish has no price anywhere', async () => {
  // No Lightning Bolt printing has an etched price, so "*E*" cannot be honoured.
  const { body } = await post('/api/deck', { list: '1 Lightning Bolt *E*' });
  const card = body.cards[0];
  assert.equal(card.requested.finish, 'etched');
  assert.equal(card.finishRelaxed, true, 'the fallback is flagged, not hidden');
  assert.equal(card.priced, true);
});

test('POST /api/deck honours a foil request when some printing has a foil price', async () => {
  const { body } = await post('/api/deck', { list: '1 Lightning Bolt *F*' });
  const card = body.cards[0];
  assert.equal(card.finishRelaxed, false);
  assert.equal(card.cheapest.finish, 'foil');
  assert.equal(card.unitPrice, 3.1, 'cheapest foil across every genuine printing');
});

test('typographic apostrophes in card names still resolve', async () => {
  const { body } = await post('/api/deck', { list: "2 Agadeem's Awakening\n1 Agadeem\u2019s Awakening" });
  assert.equal(body.missing.length, 0, 'a straight apostrophe must match Scryfall\u2019s curly one');
  assert.equal(body.totals.cardCount, 3);
});

test('unknown API endpoints return JSON, not the SPA shell', async () => {
  const { status, body } = await get('/api/nope');
  assert.equal(status, 404);
  assert.equal(body.error, 'Unknown endpoint.');
});

test('the SPA shell is served for unknown page routes', async () => {
  const response = await fetch(`${base}/deck/whatever`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /MTG Price Finder/);
});

test('security headers are set', async () => {
  const response = await fetch(`${base}/`);
  assert.match(response.headers.get('content-security-policy'), /img-src[^;]*cards\.scryfall\.io/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('malformed JSON gets a JSON error, not an HTML page', async () => {
  const response = await fetch(`${base}/api/deck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.match((await response.json()).error, /valid JSON/);
});

test('an oversized body is rejected with JSON', async () => {
  const response = await fetch(`${base}/api/deck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ list: '4 Lightning Bolt\n'.repeat(60000) }),
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /too large/);
});

test('deck pricing falls back to the full print run when the cheap page is empty', async () => {
  const stub = createFakeScryfall();
  let fullLookups = 0;
  const app = createApp({
    scryfall: {
      ...stub,
      async cheapestPrintingsByOracleIds(ids) {
        // Simulate every printing on the cheap page being filtered as non-genuine.
        return new Map([...new Set(ids)].map((id) => [id, []]));
      },
      async printingsByOracleId(id) {
        fullLookups += 1;
        return stub.printingsByOracleId(id);
      },
    },
    ebay: createFakeEbay(),
  });
  const local = app.listen(0);
  await new Promise((resolve) => local.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${local.address().port}/api/deck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list: '4 Lightning Bolt' }),
    });
    const body = await response.json();
    assert.equal(fullLookups, 1, 'the thorough lookup ran');
    assert.equal(body.cards[0].unitPrice, 1.2, 'and the card still got priced');
  } finally {
    local.close();
  }
});

/* ── Shipping ───────────────────────────────────────────────────────────── */

test('GET /api/card includes shipping in the price by default', async () => {
  const { body } = await get('/api/card?q=Lightning%20Bolt&shippingPerOrder=1.29&shippingFreeOver=5');
  const cheapest = body.pricing.cheapest;
  assert.equal(cheapest.price, 1.2, 'the card price is untouched');
  assert.equal(cheapest.shipping, 1.29);
  assert.equal(cheapest.landedPrice, 2.49);
  assert.equal(cheapest.shippingIsEstimate, true, 'and it is labelled an estimate');
});

test('GET /api/card can turn shipping off', async () => {
  const { body } = await get('/api/card?q=Lightning%20Bolt&shipping=false');
  assert.equal(body.pricing.shipping, null);
  assert.equal(body.pricing.cheapest.landedPrice, 1.2);
  assert.equal(body.pricing.cheapest.shippingIsEstimate, false);
});

test('a free-shipping threshold reorders results by what you actually pay', async () => {
  // With free shipping over $2, the $1.85 A25 printing costs $1.85 delivered
  // while the $1.20 CLB printing costs $1.20 + $5.00 = $6.20.
  const { body } = await get('/api/card?q=Lightning%20Bolt&shippingPerOrder=5&shippingFreeOver=1.5');
  const cheapest = body.pricing.cheapest;
  assert.equal(cheapest.printing.set, 'A25');
  assert.equal(cheapest.price, 1.85);
  assert.equal(cheapest.shipping, 0);
  assert.equal(cheapest.shippingFree, true);
  assert.equal(cheapest.landedPrice, 1.85);
});

test('POST /api/deck charges shipping per order, not per card', async () => {
  const list = '1 Fire // Ice'; // $0.75, under any sane threshold
  const one = await post('/api/deck', { list, shippingPerOrder: 1.29, shippingFreeOver: 5, orders: 1 });
  assert.equal(one.body.totals.cardsSubtotal, 0.75);
  assert.equal(one.body.totals.shipping.estimate, 1.29);
  assert.equal(one.body.totals.total, 2.04);

  const three = await post('/api/deck', { list, shippingPerOrder: 1.29, shippingFreeOver: 5, orders: 3 });
  assert.equal(three.body.totals.shipping.estimate, 3.87, 'three sellers, three shipping fees');
  assert.equal(three.body.totals.total, 4.62);
});

test('POST /api/deck waives shipping when the order clears the threshold', async () => {
  const { body } = await post('/api/deck', { list: '4 Lightning Bolt', shippingPerOrder: 1.29, shippingFreeOver: 5 });
  assert.equal(body.totals.cardsSubtotal, 4.8);
  assert.equal(body.totals.shipping.estimate, 1.29, '$4.80 is under the $5 threshold');

  const bigger = await post('/api/deck', { list: '8 Lightning Bolt', shippingPerOrder: 1.29, shippingFreeOver: 5 });
  assert.equal(bigger.body.totals.shipping.estimate, 0, '$9.60 clears it');
  assert.equal(bigger.body.totals.total, bigger.body.totals.cardsSubtotal);
});

test('POST /api/deck can turn shipping off', async () => {
  const { body } = await post('/api/deck', { list: '1 Fire // Ice', shipping: false });
  assert.equal(body.totals.shipping, null);
  assert.equal(body.totals.total, body.totals.cardsSubtotal);
});

test('GET /api/health advertises the shipping defaults it applies', async () => {
  const { body } = await get('/api/health');
  assert.ok(body.shipping.USD.perOrder > 0);
  assert.ok('freeOver' in body.shipping.USD);
  assert.match(body.shipping.note, /estimate/i);
});

/* ── Good deals ─────────────────────────────────────────────────────────── */

test('GET /api/deals returns priced, buyable deals with art', async () => {
  const { status, body } = await get('/api/deals?limit=5');
  assert.equal(status, 200);
  assert.ok(body.theme.label);
  assert.ok(body.deals.length > 0 && body.deals.length <= 5);
  for (const deal of body.deals) {
    assert.ok(deal.offer.price > 0);
    assert.ok(deal.offer.url.startsWith('https://'));
    assert.ok(deal.images.normal, 'a deal without a picture is not much of a shop window');
  }
});

test('GET /api/deals honours currency and a named theme', async () => {
  const { body } = await get('/api/deals?currency=EUR&theme=pauper-power&limit=4');
  assert.equal(body.theme.id, 'pauper-power');
  assert.equal(body.currency, 'EUR');
  assert.ok(body.deals.every((deal) => deal.offer.currency === 'EUR'));
});

test('GET /api/deals applies the shipping settings', async () => {
  const { body } = await get('/api/deals?limit=5&shippingPerOrder=2&shippingFreeOver=100');
  assert.ok(body.deals.every((deal) => deal.offer.shipping === 2));
  assert.ok(body.deals.every((deal) => deal.offer.landedPrice === Number((deal.offer.price + 2).toFixed(2))));
});

test('GET /api/health lists the deal themes', async () => {
  const { body } = await get('/api/health');
  assert.ok(body.dealThemes.length >= 3);
  assert.ok(body.dealThemes.every((theme) => theme.id && theme.label));
});
