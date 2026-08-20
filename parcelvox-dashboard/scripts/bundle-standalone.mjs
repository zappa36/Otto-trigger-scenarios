/**
 * Bundles the built app into one self-contained HTML file: CSS and JS inlined,
 * Berlin district geometry inlined as a global, no server and no CDN needed.
 *
 *   npm run build && node scripts/bundle-standalone.mjs
 *
 * Writes dist/parcelvox-dashboard.html. The output carries no <html>/<head>/
 * <body> wrapper so it can also be published straight to an Artifact page.
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

// The app's only inline <script> content; `</script>` inside a string literal
// would close the tag early, so escape it defensively.
const safe = (source) => source.replaceAll('</script', '<\\/script');

const html = `<title>ParcelVox Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
html, body { height: 100%; margin: 0; }
${css}
</style>

<div id="root"></div>

<script>
/* Berlin Bezirk boundaries, WGS84. Source: github.com/m-hoerz/berlin-shapes,
   derived from Berlin open data. Everything drawn on top is fictional. */
window.__PARCELVOX_BERLIN_GEO__ = ${safe(geo)};
</script>
<script type="module">
${safe(js)}
</script>
`;

const out = join(DIST, 'parcelvox-dashboard.html');
writeFileSync(out, html);
console.log(`${out} — ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
