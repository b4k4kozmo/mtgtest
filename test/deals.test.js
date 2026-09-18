import test from 'node:test';
import assert from 'node:assert/strict';
import { findDeals, DEAL_THEMES } from '../server/lib/deals.js';
import { createFakeScryfall } from './helpers/fakeScryfall.js';

/** Deterministic "random" so theme and shuffle choices are reproducible. */
const fixedRandom = () => 0;

test('deals come back with a real price, a buy link and card art', async () => {
  const scryfall = createFakeScryfall();
  const { theme, deals } = await findDeals({ scryfall, currency: 'USD', random: fixedRandom });

  assert.ok(theme.id, 'a theme is named');
  assert.ok(deals.length > 0);
  for (const deal of deals) {
    assert.ok(deal.name);
    assert.ok(deal.offer.price > 0, 'every deal has a real price');
    assert.ok(deal.offer.url.startsWith('https://'), 'and somewhere to buy it');
    assert.ok(deal.images.normal, 'and an image of the card');
  }
});

test('deals never include a proxy-adjacent printing', async () => {
  const scryfall = createFakeScryfall();
  const { deals } = await findDeals({ scryfall, currency: 'USD', random: fixedRandom });
  const sets = deals.map((deal) => deal.offer.printing.set);
  for (const banned of ['CED', '30A', 'ANA', 'OVNT']) {
    assert.ok(!sets.includes(banned), `${banned} must not be offered as a deal`);
  }
});

test('the query asks Scryfall for cheap paper cards in the chosen market', async () => {
  const scryfall = createFakeScryfall();
  await findDeals({ scryfall, currency: 'USD', themeId: 'commander-staples' });
  assert.match(scryfall.lastSearch.query, /game:paper/);
  assert.match(scryfall.lastSearch.query, /-is:digital/);
  assert.match(scryfall.lastSearch.query, /usd>=/);

  await findDeals({ scryfall, currency: 'EUR', themeId: 'commander-staples' });
  assert.match(scryfall.lastSearch.query, /eur>=/);
  assert.ok(!scryfall.lastSearch.query.includes('usd'));
});

test('a named theme is honoured', async () => {
  const scryfall = createFakeScryfall();
  for (const known of DEAL_THEMES) {
    const { theme } = await findDeals({ scryfall, themeId: known.id });
    assert.equal(theme.id, known.id);
  }
});

test('an unknown theme falls back to a random one rather than erroring', async () => {
  const scryfall = createFakeScryfall();
  const { theme } = await findDeals({ scryfall, themeId: 'not-a-theme', random: fixedRandom });
  assert.equal(theme.id, DEAL_THEMES[0].id);
});

test('theme labels carry the price band in the right currency', async () => {
  const scryfall = createFakeScryfall();
  const usd = await findDeals({ scryfall, currency: 'USD', themeId: 'modern-staples' });
  const eur = await findDeals({ scryfall, currency: 'EUR', themeId: 'modern-staples' });
  assert.match(usd.theme.label, /\$8/);
  assert.match(eur.theme.label, /€8/);
});

test('savings are reported only when one printing really is much dearer', async () => {
  const scryfall = createFakeScryfall();
  const { deals } = await findDeals({ scryfall, currency: 'USD', random: fixedRandom });

  // Lightning Bolt non-foil runs $1.20 to $1,400, so the gap is worth naming.
  const bolt = deals.find((deal) => deal.name === 'Lightning Bolt');
  assert.equal(bolt.dearestPrice, 1400);
  assert.equal(bolt.savingsPercent, 99, 'floored, never rounded up to 100%');

  // Fire // Ice has one non-foil printing at $0.75 and a $6 foil. Comparing
  // those would claim an 88% saving that does not exist.
  const split = deals.find((deal) => deal.name === 'Fire // Ice');
  assert.equal(split.savingsPercent, null, 'a foil is not a cheaper version of the non-foil');
  assert.equal(split.dearestPrice, null);
});

test('shipping flows into the deal price when it is switched on', async () => {
  const scryfall = createFakeScryfall();
  const shipping = { enabled: true, perOrder: 1.29, freeOver: 5 };
  const { deals } = await findDeals({ scryfall, currency: 'USD', shipping, random: fixedRandom });
  const bolt = deals.find((deal) => deal.name === 'Lightning Bolt');
  assert.equal(bolt.offer.price, 1.2);
  assert.equal(bolt.offer.shipping, 1.29);
  assert.equal(bolt.offer.landedPrice, 2.49);
});

test('no search results means no strip, not a crash', async () => {
  const empty = { ...createFakeScryfall(), async searchCards() { return []; } };
  const { deals } = await findDeals({ scryfall: empty, random: fixedRandom });
  assert.deepEqual(deals, []);
});

test('the limit is respected', async () => {
  const scryfall = createFakeScryfall();
  const { deals } = await findDeals({ scryfall, limit: 2, random: fixedRandom });
  assert.ok(deals.length <= 2);
});
