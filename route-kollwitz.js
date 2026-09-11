'use strict';
/* ============================================================
 * One block, twelve doors — the Kollwitzkiez walking route.
 *
 * A short parcel tour on foot around Kollwitzplatz in Berlin-
 * Prenzlauer Berg: 12 stops in walking order across 11 real
 * addresses, a ~1.6 km loop from the south end of Kollwitzstraße
 * clockwise round the square and back. One building holds two
 * stops — one front door, two parcels — so the same address
 * appears back to back, exactly as a courier works it. 8 stops
 * carry pre-arrival notes on file: delivery info from dispatch
 * (by: 'dispatch') and what drivers reported on earlier tours
 * (by: 'driver'). Otto reads both aloud on approach.
 *
 * Built for the dispatcher-dashboard work: a tour a tester can
 * walk in twenty minutes, so tours, stops, completion times and
 * debriefs come from real walks instead of being invented. The
 * Schöneberg route (route-schoeneberg.js) stays the driving demo.
 *
 * The addresses and coordinates are real — geocoded once, building
 * by building, via OpenStreetMap Nominatim (© OpenStreetMap
 * contributors, ODbL). Every consignee, business and note is
 * invented: test data, not people.
 *
 * The dashboard loads it (the link in the ⎘ PASTE FROM EXCEL
 * sheet, or the empty-state chip): every stop becomes a destination
 * row carrying its route id + stop number. Keyless that lands in
 * localStorage; live it is one bulk insert.
 * ============================================================ */
window.DEMO_ROUTES = (window.DEMO_ROUTES || []).concat([{
  id: 'kollwitz-01',
  name: 'Kollwitzkiez 01',
  area: 'Berlin-Prenzlauer Berg',
  walking: true,
  stops: [
    { stop: 1, title: 'Kollwitzstraße 48', addr: 'Kollwitzstraße 48, 10405 Berlin', lat: 52.53441, lng: 13.41622,
      consignee: 'F. Brandt', floor: '3',
      notes: [
        { by: 'dispatch', text: 'The bell panel is inside the gateway, not on the street — Brandt is the top button.' },
      ] },
    { stop: 2, title: 'Kolmarer Straße 3', addr: 'Kolmarer Straße 3, 10405 Berlin', lat: 52.53292, lng: 13.41844,
      consignee: 'Café Kolmar', floor: 'EG',
      notes: [
        { by: 'dispatch', text: 'Hand it over at the counter — they sign for the whole house.' },
      ] },
    { stop: 3, title: 'Knaackstraße 22', addr: 'Knaackstraße 22, 10405 Berlin', lat: 52.53485, lng: 13.41874,
      consignee: 'L. Okafor', floor: '2' },
    { stop: 4, title: 'Rykestraße 13', addr: 'Rykestraße 13, 10405 Berlin', lat: 52.5365, lng: 13.42095,
      consignee: 'Praxis Dr. Ehlers', floor: '1',
      notes: [
        { by: 'driver', text: 'The front door is locked before 09:00 — the practice opens the courtyard door on the right.' },
      ] },
    { stop: 5, title: 'Sredzkistraße 44', addr: 'Sredzkistraße 44, 10435 Berlin', lat: 52.53814, lng: 13.41902,
      consignee: 'J. Petrova', floor: '4',
      notes: [
        { by: 'dispatch', text: 'Customer is hard of hearing — ring twice and give it a minute.' },
      ] },
    { stop: 6, title: 'Husemannstraße 14', addr: 'Husemannstraße 14, 10435 Berlin', lat: 52.5379, lng: 13.41772,
      consignee: 'M. Aydın', floor: '2' },
    { stop: 7, title: 'Sredzkistraße 20', addr: 'Sredzkistraße 20, 10435 Berlin', lat: 52.53833, lng: 13.41553,
      consignee: 'Buchhandlung Sredzki', floor: 'EG',
      notes: [
        { by: 'driver', text: 'No stopping on Sredzkistraße in the morning — the loading bay on Husemannstraße is 40 m away.' },
      ] },
    { stop: 8, title: 'Kollwitzstraße 71', addr: 'Kollwitzstraße 71, 10435 Berlin', lat: 52.53736, lng: 13.41817,
      consignee: 'R. Fischer', floor: '5',
      notes: [
        { by: 'dispatch', text: 'No lift — 5th floor. If nobody answers, neighbour Kern on the 4th takes it.' },
      ] },
    { stop: 9, title: 'Husemannstraße 1', addr: 'Husemannstraße 1, 10435 Berlin', lat: 52.53694, lng: 13.41701,
      consignee: 'S. Haddad', floor: '1' },
    { stop: 10, title: 'Wörther Straße 38', addr: 'Wörther Straße 38, 10435 Berlin', lat: 52.53674, lng: 13.41639,
      consignee: 'A. Novak', floor: '3',
      notes: [
        { by: 'driver', text: 'The intercom is dead — knock on the ground-floor window on the left, they buzz you in.' },
      ] },
    { stop: 11, title: 'Kollwitzstraße 64', addr: 'Kollwitzstraße 64, 10435 Berlin', lat: 52.53598, lng: 13.41797,
      consignee: 'E. Conti', floor: '2',
      notes: [
        { by: 'dispatch', text: 'The courtyard door is temporarily closed — use the side entrance, there is a sign.' },
      ] },
    { stop: 12, title: 'Kollwitzstraße 64', addr: 'Kollwitzstraße 64, 10435 Berlin', lat: 52.53598, lng: 13.41797,
      consignee: 'Studio Nordlicht', floor: 'EG' },
  ],
}]);
