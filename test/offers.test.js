import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCardPricing, offersForPrinting, imagesFor, similarlyPriced, sortOffers } from '../server/lib/offers.js';
import { makePrinting, boltPrintings, dfcCard } from './fixtures/cards.js';

test('the cheapest offer ignores collector-only and digital printings', () => {
  const pricing = buildCardPricing(boltPrintings, { currency: 'USD' });
  // The $0.35 Collectors' Edition and $0.01 Arena printing must not win.
  assert.equal(pricing.cheapest.price, 1.2);
  assert.equal(pricing.cheapest.printing.set, 'CLB');
  assert.equal(pricing.cheapest.vendorId, 'tcgplayer');
  assert.equal(pricing.counts.printingsKept, 5);
  assert.equal(pricing.counts.printingsExcluded, 4);
});

test('opting collectibles back in admits them, but never oversized cards', () => {
  const pricing = buildCardPricing(boltPrintings, { currency: 'USD', includeCollectibles: true });
  assert.equal(pricing.cheapest.price, 0.35);
  assert.equal(pricing.cheapest.printing.set, 'CED');
  assert.ok(
    !pricing.offers.some((offer) => offer.printing.set === 'OVNT'),
    'an oversized printing must stay hidden whatever the toggle says',
  );
});

test('EUR pricing routes to Cardmarket', () => {
  const pricing = buildCardPricing(boltPrintings, { currency: 'EUR' });
  assert.equal(pricing.cheapest.vendorId, 'cardmarket');
  assert.equal(pricing.cheapest.currency, 'EUR');
  assert.equal(pricing.cheapest.price, 0.95);
});

test('offers are never invented for a finish the printing was not released in', () => {
  const nonfoilOnly = makePrinting({
    finishes: ['nonfoil'],
    prices: { usd: '3.00', usd_foil: '99.00', usd_etched: '50.00', eur: null, eur_foil: null, tix: null },
  });
  const offers = offersForPrinting(nonfoilOnly, { currency: 'USD' });
  assert.deepEqual(offers.map((o) => o.finish), ['nonfoil']);
});

test('offers require a real purchase link', () => {
  const noLink = makePrinting({ purchase_uris: {} });
  assert.deepEqual(offersForPrinting(noLink, { currency: 'USD' }), []);
});

test('zero, negative and malformed prices are dropped', () => {
  for (const usd of ['0.00', '-1', 'n/a', '', null]) {
    const card = makePrinting({ finishes: ['nonfoil'], prices: { usd } });
    assert.deepEqual(offersForPrinting(card, { currency: 'USD' }), [], `usd=${usd}`);
  }
});

test('a finish filter restricts the result', () => {
  const pricing = buildCardPricing(boltPrintings, { currency: 'USD', finish: 'foil' });
  assert.ok(pricing.offers.every((offer) => offer.finish === 'foil'));
  assert.equal(pricing.cheapest.price, 3.1);
});

test('offers sort by price, then by vendor priority, then by finish', () => {
  const sorted = sortOffers([
    { price: 5, vendorPriority: 1, finish: 'foil', printing: { releasedAt: '2020-01-01' } },
    { price: 5, vendorPriority: 1, finish: 'nonfoil', printing: { releasedAt: '2019-01-01' } },
    { price: 1, vendorPriority: 3, finish: 'nonfoil', printing: { releasedAt: '2021-01-01' } },
  ]);
  assert.deepEqual(sorted.map((o) => [o.price, o.finish]), [[1, 'nonfoil'], [5, 'nonfoil'], [5, 'foil']]);
});

test('similarly priced picks one entry per printing inside the price window', () => {
  const pricing = buildCardPricing(boltPrintings, { currency: 'USD' });
  const sets = pricing.similar.map((offer) => offer.printing.set);
  // Window is max(cheapest * 1.6, cheapest + 1) = 2.20, so M10 at $2.50 is out.
  assert.deepEqual(sets, ['CLB', '2XM', 'A25']);
  assert.equal(new Set(sets).size, sets.length, 'no printing appears twice');
  assert.ok(pricing.similar.every((offer) => offer.price <= 2.2));
});

test('cheap commons still surface alternatives via the absolute floor', () => {
  const sorted = sortOffers([
    { price: 0.05, vendorPriority: 1, finish: 'nonfoil', printing: { id: 'a', releasedAt: '2020-01-01' } },
    { price: 0.35, vendorPriority: 1, finish: 'nonfoil', printing: { id: 'b', releasedAt: '2020-01-01' } },
    { price: 0.9, vendorPriority: 1, finish: 'nonfoil', printing: { id: 'c', releasedAt: '2020-01-01' } },
    { price: 4.0, vendorPriority: 1, finish: 'nonfoil', printing: { id: 'd', releasedAt: '2020-01-01' } },
  ]);
  assert.deepEqual(similarlyPriced(sorted).map((o) => o.printing.id), ['a', 'b', 'c']);
});

test('images are read from card_faces when the layout has no top-level art', () => {
  const images = imagesFor(dfcCard);
  assert.equal(images.normal, 'https://cards.scryfall.io/normal/front/dfc.jpg');
  assert.equal(imagesFor({}).normal, null);
});

test('an unpriced card yields a null cheapest rather than throwing', () => {
  const pricing = buildCardPricing([makePrinting({ prices: {} })], { currency: 'USD' });
  assert.equal(pricing.cheapest, null);
  assert.deepEqual(pricing.similar, []);
});
