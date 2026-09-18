/**
 * Deck list parser.
 *
 * Accepts the formats people actually paste: MTG Arena / MTGO exports,
 * Moxfield, Archidekt, Deckstats, EDHREC, TappedOut, MWS `SB:` lines, and bare
 * "4 Lightning Bolt". Unknown lines are reported rather than silently dropped,
 * so nothing disappears from someone's deck without them being told.
 */

const SECTION_ALIASES = new Map([
  ['deck', 'main'],
  ['decklist', 'main'],
  ['main', 'main'],
  ['maindeck', 'main'],
  ['main deck', 'main'],
  ['mainboard', 'main'],
  ['creatures', 'main'],
  ['spells', 'main'],
  ['lands', 'main'],
  ['sideboard', 'sideboard'],
  ['side board', 'sideboard'],
  ['side', 'sideboard'],
  ['commander', 'commander'],
  ['commanders', 'commander'],
  ['companion', 'companion'],
  ['maybeboard', 'maybeboard'],
  ['considering', 'maybeboard'],
  ['tokens', 'tokens'],
  ['token', 'tokens'],
]);

/** Lines that are pure section headers, e.g. "Sideboard" or "Deck:". */
const SECTION_HEADER = /^([A-Za-z][A-Za-z ]{1,20}?)\s*:?\s*$/;

/** "4 ", "4x ", "4 x ", "x4 " */
const QUANTITY = /^(?:x\s*(\d+)|(\d+)\s*x?)(?:\s+|(?=[^\d\s]))/i;

/** Trailing "(m10) 146", "(m10)146", "(m10)" */
const SET_AND_NUMBER = /\(([A-Za-z0-9_]{2,6})\)\s*([A-Za-z0-9★†-]+)?\s*$/;

/** Trailing "[M10]" or "[M10] 146" style set code. */
const BRACKET_SET = /\[([A-Za-z0-9_]{2,6})\]\s*([A-Za-z0-9\u2605\u2020-]+)?\s*$/;

/** Trailing "*F*", "*E*", "*CMDR*", "*etched*" markers. */
const STAR_MARKER = /\*([A-Za-z]+)\*\s*$/;

/** Trailing "#Commander", "#!Commander" tags (Archidekt / Deckstats). */
const HASH_TAG = /\s+#!?[A-Za-z][\w-]*\s*$/;

/** Trailing "[Maybeboard{noDeck}{noPrice}]" style tag blocks. */
const BRACKET_TAG = /\[([^\]]*[{}][^\]]*)\]\s*$/;

/** A card name has to contain at least one letter. */
const HAS_LETTER = /\p{L}/u;

const MAX_LINES = 5000;

/**
 * @param {string} text
 * @returns {{entries: object[], errors: object[], totalCards: number, sections: string[]}}
 */
export function parseDeckList(text) {
  const entries = [];
  const errors = [];
  if (typeof text !== 'string' || text.trim() === '') {
    return { entries, errors, totalCards: 0, sections: [] };
  }

  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES) {
    errors.push({ lineNumber: 0, line: '', message: `Deck list is too long (${lines.length} lines, limit ${MAX_LINES}).` });
    lines.length = MAX_LINES;
  }

  let section = 'main';

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    let line = rawLine.trim();
    if (line === '') return;

    // Comments. `//` only counts at the start of a line so that split-card
    // names like "Fire // Ice" survive intact.
    if (line.startsWith('//') || line.startsWith('#')) {
      const headerSection = matchSection(line.replace(/^(?:\/\/|#+)\s*/, ''));
      if (headerSection) section = headerSection;
      return;
    }

    // MWS-style "SB: 2 Card Name".
    const sbMatch = /^(SB|MB|CM):\s*/i.exec(line);
    if (sbMatch) {
      const marker = sbMatch[1].toUpperCase();
      section = marker === 'SB' ? 'sideboard' : marker === 'CM' ? 'commander' : 'main';
      line = line.slice(sbMatch[0].length).trim();
      if (line === '') return;
    } else {
      const headerSection = matchSection(line);
      if (headerSection) {
        section = headerSection;
        return;
      }
    }

    const parsed = parseEntryLine(line);
    if (!parsed) {
      errors.push({ lineNumber, line: rawLine, message: 'Could not read a card name from this line.' });
      return;
    }
    const { sectionOverride, ...entry } = parsed;
    entries.push({ ...entry, section: sectionOverride ?? section, lineNumber, line: rawLine.trim() });
  });

  const merged = mergeEntries(entries);
  return {
    entries: merged,
    errors,
    totalCards: merged.reduce((sum, entry) => sum + entry.quantity, 0),
    sections: [...new Set(merged.map((entry) => entry.section))],
  };
}

function matchSection(line) {
  const match = SECTION_HEADER.exec(line.trim());
  if (!match) return null;
  return SECTION_ALIASES.get(match[1].trim().toLowerCase()) ?? null;
}

/**
 * Parse one card line into `{quantity, name, set, collectorNumber, finish}`.
 * Exported for tests.
 */
export function parseEntryLine(input) {
  let line = String(input).trim();
  if (line === '') return null;

  let quantity = 1;
  const quantityMatch = QUANTITY.exec(line);
  if (quantityMatch) {
    quantity = Number.parseInt(quantityMatch[1] ?? quantityMatch[2], 10);
    line = line.slice(quantityMatch[0].length).trim();
  }
  if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;
  quantity = Math.min(quantity, 999);

  let finish = 'any';
  let set = null;
  let collectorNumber = null;
  let sectionOverride = null;

  // Strip trailing decorations, innermost-last, until nothing more matches.
  for (let guard = 0; guard < 6; guard += 1) {
    const before = line;

    const star = STAR_MARKER.exec(line);
    if (star) {
      const marker = star[1].toLowerCase();
      if (marker === 'f' || marker === 'foil') finish = 'foil';
      else if (marker === 'e' || marker === 'etched') finish = 'etched';
      line = line.slice(0, star.index).trim();
    }

    const bracketTag = BRACKET_TAG.exec(line);
    if (bracketTag) {
      // Archidekt writes "[Maybeboard{noDeck}{noPrice}]" -- the leading word is
      // the section the card belongs to.
      const label = bracketTag[1].split(/[{[]/)[0].trim().toLowerCase();
      sectionOverride = SECTION_ALIASES.get(label) ?? sectionOverride;
      line = line.slice(0, bracketTag.index).trim();
    }

    const hashTag = HASH_TAG.exec(line);
    if (hashTag) line = line.slice(0, hashTag.index).trim();

    const parenSet = SET_AND_NUMBER.exec(line);
    if (parenSet) {
      set = parenSet[1].toLowerCase();
      if (parenSet[2]) collectorNumber = parenSet[2];
      line = line.slice(0, parenSet.index).trim();
    }

    const bracketSet = BRACKET_SET.exec(line);
    if (bracketSet) {
      set = bracketSet[1].toLowerCase();
      if (bracketSet[2]) collectorNumber = bracketSet[2];
      line = line.slice(0, bracketSet.index).trim();
    }

    if (line === before) break;
  }

  // A bare collector number can trail the name once the set was in brackets.
  if (set && !collectorNumber) {
    const trailingNumber = /\s+([0-9]{1,4}[a-z★†]?)$/i.exec(line);
    if (trailingNumber) {
      collectorNumber = trailingNumber[1];
      line = line.slice(0, trailingNumber.index).trim();
    }
  }

  const name = line.replace(/\s+/g, ' ').trim();
  if (name === '' || !HAS_LETTER.test(name)) return null;

  return { quantity, name, set, collectorNumber, finish, sectionOverride };
}

/** Collapse duplicate lines ("2 Bolt" + "2 Bolt") into one entry. */
export function mergeEntries(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = [entry.section, entry.name.toLowerCase(), entry.set ?? '', entry.collectorNumber ?? '', entry.finish].join('|');
    const existing = byKey.get(key);
    if (existing) existing.quantity += entry.quantity;
    else byKey.set(key, { ...entry });
  }
  return [...byKey.values()];
}

/** Scryfall `/cards/collection` identifiers for a set of parsed entries. */
export function toScryfallIdentifiers(entries) {
  return entries.map((entry) => {
    if (entry.set && entry.collectorNumber) {
      return { set: entry.set, collector_number: String(entry.collectorNumber).toLowerCase() };
    }
    return { name: entry.name };
  });
}
