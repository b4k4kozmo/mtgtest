/**
 * Transport: talks to this app's own HTTP API.
 *
 * `app.js` only ever calls these functions, so the same front end also runs as
 * a backend-free static site by swapping this module for one that calls
 * Scryfall directly (see `web/api-direct.js`).
 */

async function getJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

const query = (params) =>
  new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null),
  ).toString();

export const mode = 'server';

export async function health() {
  return getJson('/api/health');
}

export async function autocomplete(params) {
  return getJson(`/api/autocomplete?${query(params)}`);
}

export async function card(params) {
  return getJson(`/api/card?${query(params)}`);
}

export async function search(params) {
  return getJson(`/api/search?${query(params)}`);
}

export async function listings(params) {
  return getJson(`/api/listings?${query(params)}`);
}

export async function deals(params) {
  return getJson(`/api/deals?${query(params)}`);
}

export async function deck(body) {
  return getJson('/api/deck', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
