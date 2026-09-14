/*
 * The sheet, without a browser. trigger-scenarios.js is a plain script
 * that assigns window.TRIGGER_SHEET, and route-*.js do the same with
 * window.DEMO_ROUTES; evaluating them against a stub window hands the
 * generator the very rows the dashboard loads, instead of a second copy
 * of the sheet to keep in step. The other source is a designer's own
 * rows in Supabase, read with the anon key exactly as
 * scripts/tune_triggers.py reads them (the pilot policies let the anon
 * key read; RLS is the protection).
 */
import { readFileSync } from 'node:fs';

const REPO = new URL('../../', import.meta.url);

/* The kit's Supabase project lives in one place under lib/ — the pair
 * the loop's reader carries (the same one config.js and
 * scripts/tune_triggers.py carry); re-exported so the generator's
 * callers keep one import. */
import { DEFAULT_URL, DEFAULT_KEY } from './supabase.mjs';
export { DEFAULT_URL, DEFAULT_KEY };

/* Run a browser script from the repo root against an empty window and
 * return the global it set. The scripts touch nothing but `window`, so
 * this is all the browser they need. */
export function loadBrowserGlobal(file, name) {
  const src = readFileSync(new URL(file, REPO), 'utf8');
  const window = {};
  new Function('window', src)(window);
  if (!(name in window)) throw new Error(`${file} did not set window.${name}`);
  return window[name];
}

export const loadSheet = (file = 'trigger-scenarios.js') => loadBrowserGlobal(file, 'TRIGGER_SHEET').scenarios;

export function loadRoute(file, id) {
  const routes = loadBrowserGlobal(file, 'DEMO_ROUTES');
  const route = id ? routes.find(r => r.id === id) : routes[0];
  if (!route) throw new Error(`${file} carries no route${id ? ' ' + id : ''}`);
  return route;
}

/* A designer's own rows. Same query, same two headers as
 * tune_triggers.py; the env pair (SUPABASE_URL / SUPABASE_ANON_KEY)
 * points at another project, the kit's own is the default. */
export async function loadSupabase(url, key) {
  url = String(url || process.env.SUPABASE_URL || DEFAULT_URL).replace(/\/+$/, '');
  key = String(key || process.env.SUPABASE_ANON_KEY || DEFAULT_KEY);
  const path = '/rest/v1/scenarios?select=*&order=num.asc.nullslast';
  const r = await fetch(url + path, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} from ${path}: ${(await r.text()).slice(0, 200)}`);
  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error(`unexpected reply from ${path}`);
  return rows;
}
