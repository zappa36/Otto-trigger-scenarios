// ============================================================
// Server-side geocoding — Supabase Edge Function.
//
// The browser Maps key is (correctly) referrer-locked, and Google's
// Geocoding web service refuses referrer-locked keys — while the
// OpenStreetMap fallback has poor coverage outside Europe. This
// function geocodes with a SECOND, server-side Google key that never
// reaches the browser.
//
// Setup once:
//   1. Google Cloud console -> Credentials -> Create credentials ->
//      API key. Under "API restrictions" tick ONLY "Geocoding API".
//      Leave application restrictions off (it lives server-side).
//   2. Supabase -> Edge Functions -> Secrets -> add GMAPS_SERVER_KEY.
//   3. Add your site to ALLOWED_ORIGINS (comma-separated).
//
// POST { q: "No. 77, Huaide St, Beitou..." } -> { results: [{label, lat, lng, area}] }
// POST { lat: 25.11, lng: 121.50 }           -> { street, area }
//
// Optional secrets:
//   ALLOWED_ORIGINS   comma-separated; defaults to localhost only
//   GEOCODE_REGION    ccTLD bias for forward lookups, e.g. "de", "tw"
// ============================================================

const env = (k: string, fallback: string) => (Deno.env.get(k) || '').trim() || fallback;

const ALLOW_ORIGINS = env('ALLOWED_ORIGINS', 'http://localhost:8000')
  .split(',').map(s => s.trim()).filter(Boolean);
const REGION = env('GEOCODE_REGION', '');

const corsHeaders = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin && ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0],
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
});

// Address components are ordered by specificity across results, so the first
// match wins — scanning every result is what makes this work when the most
// precise hit is missing a field the coarser ones carry.
// deno-lint-ignore no-explicit-any
const comp = (results: any[], type: string) => {
  for (const res of results) {
    const c = (res.address_components || []).find((x: { types: string[] }) => x.types.includes(type));
    if (c) return c.long_name;
  }
  return null;
};

// deno-lint-ignore no-explicit-any
const areaOf = (results: any[]) =>
  comp(results, 'neighborhood') || comp(results, 'sublocality_level_1') ||
  comp(results, 'sublocality') || comp(results, 'locality');

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), { status, headers });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return fail(405, 'POST only');

  // The anon key is public by design, so it cannot be what stands between
  // the internet and a metered Google account. The origin check is.
  if (!origin || !ALLOW_ORIGINS.includes(origin)) return fail(403, 'origin not allowed');

  const key = Deno.env.get('GMAPS_SERVER_KEY');
  if (!key) return fail(500, 'GMAPS_SERVER_KEY secret is not set');

  try {
    const body = await req.json();

    if (body.q) { // forward: address text -> candidates
      const q = String(body.q).slice(0, 200);
      const region = REGION ? `&region=${encodeURIComponent(REGION)}` : '';
      const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}${region}&key=${key}`);
      if (!r.ok) return fail(502, 'geocoder unreachable');
      const d = await r.json();
      if (d.status !== 'OK') return new Response(JSON.stringify({ results: [], status: d.status }), { headers });
      // deno-lint-ignore no-explicit-any
      const results = (d.results || []).slice(0, 4).map((res: any) => ({
        label: res.formatted_address,
        lat: res.geometry.location.lat,
        lng: res.geometry.location.lng,
        area: areaOf([res]),
      }));
      return new Response(JSON.stringify({ results }), { headers });
    }

    const lat = Number(body.lat), lng = Number(body.lng);
    if (isFinite(lat) && isFinite(lng)) { // reverse: position -> street + area
      const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`);
      if (!r.ok) return fail(502, 'geocoder unreachable');
      const d = await r.json();
      if (d.status !== 'OK' || !d.results || !d.results.length) {
        return new Response(JSON.stringify({ street: null, area: null }), { headers });
      }
      const road = comp(d.results, 'route');
      const num = comp(d.results, 'street_number');
      return new Response(JSON.stringify({
        street: road ? (num ? `${road} ${num}` : road) : null,
        area: areaOf(d.results),
      }), { headers });
    }

    return fail(400, 'send { q } or { lat, lng }');
  } catch (e) {
    return fail(500, `unexpected: ${String(e).slice(0, 200)}`);
  }
});
