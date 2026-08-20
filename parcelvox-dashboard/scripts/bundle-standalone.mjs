/**
 * Bundles the built app into one self-contained HTML file: CSS and JS inlined,
 * Berlin district geometry inlined as a global, no server and no CDN needed.
 *
 *   npm run build && node scripts/bundle-standalone.mjs
 *
 * Two shapes come out, because the two destinations disagree about wrappers:
 *
 *   dist/parcelvox-dashboard.html           complete document, <!doctype> and
 *                                           all. This is the one you deploy —
 *                                           copy it to the repo root and Vercel
 *                                           serves it (outputDirectory ".").
 *                                           Without the doctype a browser drops
 *                                           into quirks mode and the layout goes.
 *
 *   dist/parcelvox-dashboard.artifact.html  body fragment, no <html>/<head>/
 *                                           <body>. Claude Artifacts supplies
 *                                           those itself, so a complete document
 *                                           would end up nested inside another.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const ASSETS = join(DIST, 'assets');

const assets = readdirSync(ASSETS);
const cssFile = assets.find((f) => f.endsWith('.css'));
const jsFile = assets.find((f) => f.endsWith('.js'));
if (!cssFile || !jsFile) throw new Error('Run `npm run build` first.');

const css = readFileSync(join(ASSETS, cssFile), 'utf8');
const js = readFileSync(join(ASSETS, jsFile), 'utf8');
const geo = readFileSync('public/data/berliner-bezirke.geojson', 'utf8');

// `</script` inside an inline script closes the tag early, whatever it is
// nested in. Escape it defensively in both the geometry and the bundle.
const safe = (source) => source.replaceAll('</script', '<\\/script');

/** The ParcelVox pin, inline so the page pulls in no files of its own. */
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2312A06B'/%3E%3Cg transform='translate(6 6)' fill='none' stroke='%23fff' stroke-linejoin='round'%3E%3Cpath d='M10 17.5s-5.5-4.6-5.5-8.7A5.5 5.5 0 0 1 15.5 8.8C15.5 12.9 10 17.5 10 17.5Z' stroke-width='1.7'/%3E%3Cpath d='M8 8.8h.01M10 8.8h.01M12 8.8h.01' stroke-width='2.1' stroke-linecap='round'/%3E%3C/g%3E%3C/svg%3E";

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">`;

const STYLE = `<style>
html, body { height: 100%; margin: 0; }
${css}
</style>`;

const SCRIPTS = `<script>
/* Berlin Bezirk boundaries, WGS84. Source: github.com/m-hoerz/berlin-shapes,
   derived from Berlin open data. Everything drawn on top is fictional. */
window.__PARCELVOX_BERLIN_GEO__ = ${safe(geo)};
</script>
<script type="module">
${safe(js)}
</script>`;

/**
 * The deployed page also loads config.js from its own origin — the same
 * deploy-time-injected Supabase values the phone and the trigger dashboard
 * read, which is how the map and the pre-arrival notes connect to the real
 * app (src/otto/depot.ts). Locally the placeholders leave it keyless and the
 * connection falls back to the shared localStorage instead. The artifact
 * fragment stays fully self-contained: no config.js exists there, so it runs
 * in sample mode by design.
 */
const CONFIG = '<script src="config.js"></script>';

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ParcelVox · Dispatcher dashboard</title>
<link rel="icon" href="${FAVICON}">
${FONTS}
${STYLE}
</head>
<body>
<div id="root"></div>
${CONFIG}
${SCRIPTS}
</body>
</html>
`;

const fragment = `<title>ParcelVox Dashboard</title>
${FONTS}
${STYLE}

<div id="root"></div>

${SCRIPTS}
`;

for (const [name, contents] of [
  ['parcelvox-dashboard.html', page],
  ['parcelvox-dashboard.artifact.html', fragment],
]) {
  const out = join(DIST, name);
  writeFileSync(out, contents);
  console.log(`${out} — ${(Buffer.byteLength(contents) / 1024).toFixed(0)} KB`);
}
