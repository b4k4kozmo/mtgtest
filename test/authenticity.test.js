import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPrinting, looksLikeProxyListing, titleMentionsCard } from '../server/lib/authenticity.js';
import { makePrinting, boltPrintings } from './fixtures/cards.js';

test('a normal paper printing is accepted', () => {
  const verdict = classifyPrinting(makePrinting());
  assert.equal(verdict.ok, true);
});

test('digital-only printings are rejected', () => {
  const verdict = classifyPrinting(makePrinting({ digital: true, games: ['arena'] }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'digital');
});

test('printings never released on paper are rejected', () => {
  const verdict = classifyPrinting(makePrinting({ digital: false, games: ['mtgo'] }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'not_paper');
});

test('collector-only products are rejected by default', () => {
  for (const set of ['ced', 'cei', '30a', 'wc99']) {
    const verdict = classifyPrinting(makePrinting({ set, set_type: 'memorabilia' }));
    assert.equal(verdict.ok, false, `${set} should be rejected`);
    assert.equal(verdict.code, 'collectible');
  }
});

test('gold-bordered printings are rejected even with an ordinary set type', () => {
  const verdict = classifyPrinting(makePrinting({ set: 'pwcq', set_type: 'promo', border_color: 'gold' }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'collectible');
});

test('collector-only products can be opted back in', () => {
  const verdict = classifyPrinting(makePrinting({ set: '30a', set_type: 'memorabilia' }), { includeCollectibles: true });
  assert.equal(verdict.ok, true);
});

test('oversized and token layouts are rejected', () => {
  assert.equal(classifyPrinting(makePrinting({ oversized: true })).ok, false);
  assert.equal(classifyPrinting(makePrinting({ layout: 'token' })).ok, false);
  assert.equal(classifyPrinting(makePrinting({ layout: 'art_series' })).ok, false);
});

test('the fixture spread keeps exactly the five genuine printings', () => {
  const kept = boltPrintings.filter((card) => classifyPrinting(card).ok);
  assert.deepEqual(kept.map((c) => c.set).sort(), ['2xm', 'a25', 'clb', 'lea', 'm10']);
});

test('proxy vocabulary is caught in listing titles', () => {
  const proxies = [
    'Lightning Bolt Alpha PROXY high quality',
    'MTG Black Lotus Replica card',
    'Custom made Ragavan foil',
    'Force of Will - reproduction - not tournament legal',
    'Time Walk altered art hand painted',
    'Mox Sapphire CE gold border collectors',
  ];
  for (const title of proxies) assert.equal(looksLikeProxyListing(title), true, title);
});

test('ordinary listings are not flagged as proxies', () => {
  const genuine = [
    'MTG Lightning Bolt Magic 2010 M10 NM English',
    'Ragavan, Nimble Pilferer Modern Horizons 2 Mythic LP',
    'Fire // Ice Apocalypse Uncommon x1',
  ];
  for (const title of genuine) assert.equal(looksLikeProxyListing(title), false, title);
});

test('listings must actually mention the card searched for', () => {
  assert.equal(titleMentionsCard('MTG Lightning Bolt M10 NM', 'Lightning Bolt'), true);
  assert.equal(titleMentionsCard('Dragon Shield sleeves 100ct', 'Lightning Bolt'), false);
  // Split cards match on either half.
  assert.equal(titleMentionsCard('MTG Fire Apocalypse NM', 'Fire // Ice'), true);
  // Punctuation and case differences do not matter.
  assert.equal(titleMentionsCard("RAGAVAN NIMBLE PILFERER MH2", "Ragavan, Nimble Pilferer"), true);
});

test('oversized printings stay excluded even when collectibles are opted in', () => {
  const verdict = classifyPrinting(makePrinting({ oversized: true }), { includeCollectibles: true });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'oversized');
});
