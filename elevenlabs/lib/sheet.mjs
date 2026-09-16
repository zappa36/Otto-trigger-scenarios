/*
 * The sheets, without a browser. trigger-scenarios.js and
 * situations-starter.js are plain scripts that assign
 * window.TRIGGER_SHEET / window.SITUATIONS_SHEET, and route-*.js do the
 * same with window.DEMO_ROUTES; evaluating them against a stub window
 * hands the generator the very rows the dashboard loads, instead of a
 * second copy of the sheet to keep in step. The other source is a
 * designer's own rows in Supabase, read with the anon key exactly as
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

/* The twenty starter situations — what a driver reports after pressing
 * REPORT. The same shape the situations table carries, because the
 * dashboard loads this file into that table. */
export const loadSituationsSheet = (file = 'situations-starter.js') => loadBrowserGlobal(file, 'SITUATIONS_SHEET').situations;

export function loadRoute(file, id) {
  const routes = loadBrowserGlobal(file, 'DEMO_ROUTES');
  const route = id ? routes.find(r => r.id === id) : routes[0];
  if (!route) throw new Error(`${file} carries no route${id ? ' ' + id : ''}`);
  return route;
}

/* A designer's own rows. Same query, same two headers as
 * tune_triggers.py; the env pair (SUPABASE_URL / SUPABASE_ANON_KEY)
 * points at another project, the kit's own is the default. The status
 * rides on the error: a caller with a sheet to fall back on (the
 * situation generator, on a project whose schema.sql predates the
 * table) has to tell "no such table" from "the project is down". */
async function rowsFrom(path, url, key) {
  url = String(url || process.env.SUPABASE_URL || DEFAULT_URL).replace(/\/+$/, '');
  key = String(key || process.env.SUPABASE_ANON_KEY || DEFAULT_KEY);
  const r = await fetch(url + path, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
  if (!r.ok) {
    const e = new Error(`${r.status} ${r.statusText} from ${path}: ${(await r.text()).slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error(`unexpected reply from ${path}`);
  return rows;
}

export const loadSupabase = (url, key) => rowsFrom('/rest/v1/scenarios?select=*&order=num.asc.nullslast', url, key);

/* The situations the dashboard's SITUATIONS tab holds, in sheet order:
 * the active ones only, because a row switched off there must not cost
 * four simulated conversations here. */
export const loadSituationsSupabase = (url, key) =>
  rowsFrom('/rest/v1/situations?select=*&active=eq.true&order=num.asc.nullslast', url, key);
