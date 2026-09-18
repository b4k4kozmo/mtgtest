import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeckList, parseEntryLine, toScryfallIdentifiers } from '../server/lib/deckParser.js';

const entry = (line) => parseEntryLine(line);

test('quantity formats', () => {
  assert.equal(entry('4 Lightning Bolt').quantity, 4);
  assert.equal(entry('4x Lightning Bolt').quantity, 4);
  assert.equal(entry('4 x Lightning Bolt').quantity, 4);
  assert.equal(entry('x3 Forest').quantity, 3);
  assert.equal(entry('Lightning Bolt').quantity, 1);
});

test('set and collector number in parentheses', () => {
  const parsed = entry('4 Snapcaster Mage (MM3) 42');
  assert.equal(parsed.name, 'Snapcaster Mage');
  assert.equal(parsed.set, 'mm3');
  assert.equal(parsed.collectorNumber, '42');
});

test('set and collector number in brackets', () => {
  const parsed = entry('3 Thoughtseize [MM3] 108');
  assert.equal(parsed.name, 'Thoughtseize');
  assert.equal(parsed.set, 'mm3');
  assert.equal(parsed.collectorNumber, '108');
});

test('foil and etched markers', () => {
  assert.equal(entry('1 Atraxa, Praetors’ Voice (2XM) 190 *F*').finish, 'foil');
  assert.equal(entry('1 Urza, Lord High Artificer (MH1) 75 *E*').finish, 'etched');
  assert.equal(entry('1 Ragavan, Nimble Pilferer (MH2) 138').finish, 'any');
});

test('split card names survive', () => {
  const parsed = entry('2 Fire // Ice (APC) 128');
  assert.equal(parsed.name, 'Fire // Ice');
  assert.equal(parsed.set, 'apc');
});

test('card names containing parentheses are not mistaken for set codes', () => {
  assert.equal(entry('1 B.F.M. (Big Furry Monster)').name, 'B.F.M. (Big Furry Monster)');
  assert.equal(entry("1 Erase (Not the Urza's Legacy One)").set, null);
});

test('trailing tags are stripped', () => {
  assert.equal(entry("1 Atraxa, Praetors’ Voice #Commander").name, 'Atraxa, Praetors’ Voice');
  assert.equal(entry('1 Sol Ring #!Commander').name, 'Sol Ring');
});

test('Archidekt bracket tags set the section', () => {
  const parsed = entry('2 Snapcaster Mage (MM3) 42 [Maybeboard{noDeck}{noPrice}]');
  assert.equal(parsed.sectionOverride, 'maybeboard');
  assert.equal(parsed.name, 'Snapcaster Mage');
});

test('lines without a card name are rejected', () => {
  assert.equal(entry('!!!!'), null);
  assert.equal(entry('   '), null);
  assert.equal(entry('42'), null);
});

test('sections are tracked across a full list', () => {
  const result = parseDeckList([
    '// Burn',
    'Deck',
    '4 Lightning Bolt',
    '',
    'Sideboard',
    '2 Pyroblast',
    'SB: 1 Smash to Smithereens',
    'Commander',
    '1 Krenko, Mob Boss',
  ].join('\n'));

  const sections = Object.fromEntries(result.entries.map((e) => [e.name, e.section]));
  assert.equal(sections['Lightning Bolt'], 'main');
  assert.equal(sections['Pyroblast'], 'sideboard');
  assert.equal(sections['Smash to Smithereens'], 'sideboard');
  assert.equal(sections['Krenko, Mob Boss'], 'commander');
  assert.equal(result.totalCards, 8);
});

test('duplicate lines merge, but different printings stay separate', () => {
  const result = parseDeckList(['2 Lightning Bolt', '2 Lightning Bolt', '1 Lightning Bolt (M10) 146'].join('\n'));
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].quantity, 4);
  assert.equal(result.entries[1].quantity, 1);
});

test('unreadable lines are reported rather than dropped silently', () => {
  const result = parseDeckList(['4 Lightning Bolt', '???'].join('\n'));
  assert.equal(result.entries.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].lineNumber, 2);
});

test('an MTG Arena export parses end to end', () => {
  const arena = [
    'Deck',
    '4 Ragavan, Nimble Pilferer (MH2) 138',
    '20 Mountain (UNF) 235',
    '',
    'Sideboard',
    '2 Blood Moon (2XM) 117',
  ].join('\n');
  const result = parseDeckList(arena);
  assert.equal(result.totalCards, 26);
  assert.deepEqual(result.sections, ['main', 'sideboard']);
  assert.deepEqual(toScryfallIdentifiers(result.entries), [
    { set: 'mh2', collector_number: '138' },
    { set: 'unf', collector_number: '235' },
    { set: '2xm', collector_number: '117' },
  ]);
});

test('entries without a printing fall back to a name identifier', () => {
  const result = parseDeckList('4 Lightning Bolt');
  assert.deepEqual(toScryfallIdentifiers(result.entries), [{ name: 'Lightning Bolt' }]);
});

test('empty input is handled', () => {
  const result = parseDeckList('');
  assert.deepEqual(result.entries, []);
  assert.equal(result.totalCards, 0);
});

test('absurd quantities are clamped', () => {
  assert.equal(entry('99999 Forest').quantity, 999);
});
