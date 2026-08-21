# Map data

`berliner-bezirke.geojson` — boundaries of Berlin's twelve Bezirke in WGS84.

- Source: [m-hoerz/berlin-shapes](https://github.com/m-hoerz/berlin-shapes) (`berliner-bezirke.geojson`)
- Derived from Berlin open data (Geoportal Berlin / Amt für Statistik Berlin-Brandenburg)
- Vendored verbatim, with whitespace stripped, so the app has no runtime dependency on a CDN

`europe-countries.geojson` — country boundaries around Europe in WGS84, the backdrop behind the
Bezirke once the camera leaves Berlin.

- Source: [Natural Earth](https://www.naturalearthdata.com/) 1:110m Admin 0 – Countries
  (public domain), via
  [nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
- Reduced here: clipped to a European window, far-flung territories dropped, properties reduced
  to the country name, coordinates rounded to three decimals

Everything drawn on top of these boundaries in the sample data — the Nordhaven depot, the eight
routes, and their stops — is fictional demo content and does not correspond to any real address
or operation. In live mode the stops come from the app's own shared store.
