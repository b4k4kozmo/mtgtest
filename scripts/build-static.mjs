/**
 * Build the backend-free static site into `dist/`.
 *
 * The output is the same app, reading live Scryfall data straight from the
 * visitor's browser: real cards, real prices, real card images, every printing.
 * Serve `dist/` from any static host — GitHub Pages, S3, `npx serve dist`.
 *
 * Nothing is bundled or minified on purpose: the browser loads the same ES
 * modules the server does, so what ships is what you can read in the repo.
 */
import { cp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

/** Server-only modules: they need secrets or a Node runtime. */
const SERVER_ONLY = new Set(['ebay.js']);

async function build() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(path.join(dist, 'lib'), { recursive: true });

  // The front end, unchanged.
  await cp(path.join(root, 'public', 'index.html'), path.join(dist, 'index.html'));
  await cp(path.join(root, 'public', 'styles.css'), path.join(dist, 'styles.css'));
  await cp(path.join(root, 'public', 'app.js'), path.join(dist, 'app.js'));

  // The shared logic modules.
  const libDir = path.join(root, 'server', 'lib');
  const copied = [];
  for (const name of await readdir(libDir)) {
    if (!name.endsWith('.js') || SERVER_ONLY.has(name)) continue;
    await cp(path.join(libDir, name), path.join(dist, 'lib', name));
    copied.push(name);
  }

  // The direct-to-Scryfall transport becomes this build's ./api.js.
  const transport = await readFile(path.join(root, 'web', 'api-direct.js'), 'utf8');
  await writeFile(path.join(dist, 'api.js'), transport.replaceAll('../server/lib/', './lib/'));

  // Absolute asset paths only work at a domain root; relative ones work anywhere,
  // including a GitHub Pages project subpath.
  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  await writeFile(
    path.join(dist, 'index.html'),
    html.replaceAll('href="/styles.css"', 'href="styles.css"').replaceAll('src="/app.js"', 'src="app.js"'),
  );

  // GitHub Pages otherwise refuses to serve paths it thinks are Jekyll internals.
  await writeFile(path.join(dist, '.nojekyll'), '');

  console.log(`Built dist/ — ${copied.length + 4} files.`);
  console.log('Serve it with:  npx serve dist    (or push dist/ to GitHub Pages)');
  console.log('Live Scryfall data, no backend. eBay listings need the Node server.');
}

build().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
