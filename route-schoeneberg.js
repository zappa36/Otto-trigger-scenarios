'use strict';

/* ============================================================
 * One route, twenty doors — the Schöneberg demo route.
 *
 * A realistic parcel tour through Berlin-Schöneberg, cut to a demo's
 * length: 20 stops in driving order across 17 real addresses — a
 * ~7 km loop from Nollendorfplatz down through the Akazienkiez and
 * the Crellekiez, up Goltzstraße and out to Potsdamer Straße. A good
 * mix of what comes out of the van: 11 parcels, 5 fresh-food stops
 * (flowers, a café's kitchen door, a wine shop) and 4 bulky items
 * (a top-floor flat with no lift, a goods-in bay). 3 buildings hold
 * two stops — one front door, several deliveries — so the same
 * address appears back to back, exactly as a courier works it.
 * 13 stops carry pre-arrival notes on file: delivery info from
 * dispatch (by: 'dispatch', 7 notes) and what drivers reported on
 * earlier tours (by: 'driver', 8 notes). Otto reads both aloud on
 * approach, each in its own voice: "From dispatch: …" / "A driver
 * reported: …".
 *
 * The addresses and coordinates are real — geocoded once, building
 * by building, via OpenStreetMap Nominatim (© OpenStreetMap
 * contributors, ODbL). Every consignee, business and note is
 * invented: test data, not people.
 *
 * The dashboard loads it (⇪ LOAD on the ROUTES tab): every stop
 * becomes a destination row carrying its route id + stop number.
 * Keyless that lands in localStorage; live it is one bulk insert —
 * re-run supabase/schema.sql once first for the route/stop columns
 * and the routes table.
 * ============================================================ */

window.DEMO_ROUTE = {
  id: 'schoeneberg-01',
  name: 'Schöneberg 01',
  area: 'Berlin-Schöneberg',
  stops: [
    { stop: 1, title: 'Maaßenstraße 3', addr: 'Maaßenstraße 3, 10777 Berlin', lat: 52.4986, lng: 13.35443,
      consignee: 'J. Weber', floor: '2', entrance: 'front building, left stairwell', kind: 'parcel' },
    { stop: 2, title: 'Maaßenstraße 8', addr: 'Maaßenstraße 8, 10777 Berlin', lat: 52.49832, lng: 13.35387,
      consignee: 'E. Costa', floor: '2', entrance: 'front building', kind: 'parcel',
      notes: [
        { by: 'driver', text: 'Maaßenstraße is a shared-space street — no through traffic, walkers have priority; come in from the Nollendorfplatz end.' },
      ] },
    { stop: 3, title: 'Winterfeldtstraße 56', addr: 'Winterfeldtstraße 56, 10781 Berlin', lat: 52.49688, lng: 13.3518,
      consignee: 'Blumen Wittkamp', floor: 'ground floor', entrance: 'shop entrance on the street', kind: 'food',
      notes: [
        { by: 'dispatch', text: 'Fresh flowers — keep them upright, deliver first if you can.' },
      ] },
    { stop: 4, title: 'Winterfeldtstraße 56', addr: 'Winterfeldtstraße 56, 10781 Berlin', lat: 52.49688, lng: 13.3518,
      consignee: 'D. Almeida', floor: '3', entrance: 'front building, house door right of the flower shop', kind: 'parcel' },
    { stop: 5, title: 'Nollendorfstraße 17', addr: 'Nollendorfstraße 17, 10777 Berlin', lat: 52.49783, lng: 13.35144,
      consignee: 'Pension Winter', floor: '1', entrance: 'front building — the pension\'s own door, left of the archway', kind: 'parcel',
      notes: [
        { by: 'dispatch', text: 'Ring “Pension Winter” — they take every parcel for the house.' },
      ] },
    { stop: 6, title: 'Motzstraße 5', addr: 'Motzstraße 5, 10777 Berlin', lat: 52.4986, lng: 13.35163,
      consignee: 'S. Schmidt', floor: '4', entrance: 'side wing, left — first door in the courtyard', kind: 'bulky' },
    { stop: 7, title: 'Hohenstaufenstraße 60', addr: 'Hohenstaufenstraße 60, 10781 Berlin', lat: 52.49447, lng: 13.34918,
      consignee: 'A. Kaya', floor: '3', entrance: 'front building, right stairwell', kind: 'food' },
    { stop: 8, title: 'Martin-Luther-Straße 63', addr: 'Martin-Luther-Straße 63, 10779 Berlin', lat: 52.49071, lng: 13.34539,
      consignee: 'A. Petrosyan', floor: '4', entrance: 'front building, house door between the two shops', kind: 'parcel',
      notes: [
        { by: 'driver', text: 'Six lanes and no stopping — park on the side street and cross at the lights.' },
      ] },
    { stop: 9, title: 'Belziger Straße 52', addr: 'Belziger Straße 52, 10823 Berlin', lat: 52.48655, lng: 13.34839,
      consignee: 'Kita Sonnenwinkel', floor: 'ground floor', entrance: 'daycare door on the courtyard side — the office bell', kind: 'parcel',
      notes: [
        { by: 'dispatch', text: 'Ring the office bell, never the group rooms — nap time until 14:30.' },
      ] },
    { stop: 10, title: 'Belziger Straße 52', addr: 'Belziger Straße 52, 10823 Berlin', lat: 52.48655, lng: 13.34839,
      consignee: 'T. Vu', floor: '3', entrance: 'front building, house door left of the daycare gate', kind: 'food' },
    { stop: 11, title: 'Grunewaldstraße 81', addr: 'Grunewaldstraße 81, 10823 Berlin', lat: 52.48984, lng: 13.35449,
      consignee: 'Buchhandlung Windrose', floor: 'ground floor', entrance: 'Back door in the courtyard, not the shop', kind: 'parcel',
      notes: [
        { by: 'dispatch', text: 'Bookshop — deliveries at the back door, ring twice.' },
      ] },
    { stop: 12, title: 'Akazienstraße 27', addr: 'Akazienstraße 27, 10823 Berlin', lat: 52.48684, lng: 13.35494,
      consignee: 'Café Herzstück', floor: 'ground floor', entrance: 'Kitchen door in the courtyard', kind: 'food',
      notes: [
        { by: 'dispatch', text: 'Perishables — must be in before 10:30 or it goes back to the depot.' },
        { by: 'driver', text: 'Ask for Paul; the kitchen door in the courtyard is faster than the counter.' },
      ] },
    { stop: 13, title: 'Feurigstraße 54', addr: 'Feurigstraße 54, 10829 Berlin', lat: 52.48372, lng: 13.35501,
      consignee: 'T. Halvorsen', floor: '1', entrance: 'rear building — the bell is left of the gate', kind: 'parcel',
      notes: [
        { by: 'driver', text: 'The courtyard dog is loud but harmless — the rear-building bell is left of the gate.' },
      ] },
    { stop: 14, title: 'Kolonnenstraße 51', addr: 'Kolonnenstraße 51, 10829 Berlin', lat: 52.48574, lng: 13.36261,
      consignee: 'P. Grabowski', floor: '4', entrance: 'front building, left stairwell', kind: 'parcel',
      notes: [
        { by: 'driver', text: 'Bell says “Grabowski/Lehmann” — it is the upper button of the two.' },
      ] },
    { stop: 15, title: 'Crellestraße 22', addr: 'Crellestraße 22, 10827 Berlin', lat: 52.48823, lng: 13.36179,
      consignee: 'Weinhandlung Kober', floor: 'ground floor', entrance: 'shop entrance on the street', kind: 'food',
      notes: [
        { by: 'dispatch', text: 'Wine — ID check, recipient must be 18 or older.' },
      ] },
    { stop: 16, title: 'Hauptstraße 155', addr: 'Hauptstraße 155, 10827 Berlin', lat: 52.48923, lng: 13.35956,
      consignee: 'M. Duncan', floor: '1', entrance: 'front building — the handwritten bell at the bottom', kind: 'parcel',
      notes: [
        { by: 'driver', text: 'Bell panel is new and the names are not sorted by floor — Duncan is the handwritten one at the bottom.' },
      ] },
    { stop: 17, title: 'Hauptstraße 155', addr: 'Hauptstraße 155, 10827 Berlin', lat: 52.48923, lng: 13.35956,
      consignee: 'The Brandt family', floor: 'ground floor', entrance: 'front building, flat behind the house door on the right', kind: 'bulky' },
    { stop: 18, title: 'Elßholzstraße 15', addr: 'Elßholzstraße 15, 10781 Berlin', lat: 52.49174, lng: 13.35633,
      consignee: 'A. Krüger', floor: 'top floor', entrance: 'front building, no lift — top floor', kind: 'bulky' },
    { stop: 19, title: 'Goltzstraße 13', addr: 'Goltzstraße 13, 10781 Berlin', lat: 52.49249, lng: 13.35359,
      consignee: 'A. Kaminski', floor: '4', entrance: 'front building, no lift', kind: 'parcel',
      notes: [
        { by: 'driver', text: 'No elevator and the stair light is on a short timer — you climb the last floor in the dark.' },
      ] },
    { stop: 20, title: 'Potsdamer Straße 159', addr: 'Potsdamer Straße 159, 10783 Berlin', lat: 52.49499, lng: 13.36184,
      consignee: 'reCommerce GmbH — goods-in', floor: '2', entrance: 'Courtyard entrance — the GOODS-IN bell', kind: 'bulky',
      notes: [
        { by: 'dispatch', text: 'Deliveries through the courtyard entrance — ring GOODS-IN, not the front bell.' },
        { by: 'driver', text: 'Courtyard gate is locked after 15:00; before that you can drive right in.' },
      ] },
  ],
};
/* Every demo route registers here; the dashboard offers each one
 * (route-kollwitz.js adds the walking route the same way). */
window.DEMO_ROUTES = (window.DEMO_ROUTES || []).concat([window.DEMO_ROUTE]);
