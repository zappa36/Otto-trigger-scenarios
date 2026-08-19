'use strict';

/* ============================================================
 * One route, a hundred doors — the Schöneberg demo route.
 *
 * A realistic parcel tour through Berlin-Schöneberg: 100 stops in
 * driving order across 87 real addresses — a ~17 km loop
 * from Nollendorfplatz through the Akazienkiez, the Bülow quarter
 * and the Rote Insel, back into the Bayerisches Viertel.
 * 11 buildings hold more than one stop — one front door, several
 * parcels — so the same address appears back to back, exactly as a
 * courier works it. 40 stops carry pre-arrival notes on file:
 * delivery info from dispatch (by: 'dispatch', 22 notes) and what
 * drivers reported on earlier tours (by: 'driver', 20 notes).
 * Otto reads both aloud on approach, each in its own voice:
 * "From dispatch: …" / "A driver reported: …".
 *
 * The addresses and coordinates are real — geocoded once, building
 * by building, via OpenStreetMap Nominatim (© OpenStreetMap
 * contributors, ODbL). Every consignee, business and note is
 * invented: test data, not people.
 *
 * The dashboard loads it (the link in the ⎘ PASTE FROM EXCEL
 * sheet, or the empty-state chip): every stop becomes a destination
 * row carrying its route id + stop number. Keyless that lands in
 * localStorage; live it is one bulk insert — re-run
 * supabase/schema.sql once first for the route/stop columns.
 * ============================================================ */

window.DEMO_ROUTE = {
  id: 'schoeneberg-01',
  name: 'Schöneberg 01',
  area: 'Berlin-Schöneberg',
  stops: [
    { stop: 1, title: 'Maaßenstraße 3', addr: 'Maaßenstraße 3, 10777 Berlin', lat: 52.4986, lng: 13.35443,
      consignee: 'J. Weber', floor: '2' },
    { stop: 2, title: 'Maaßenstraße 8', addr: 'Maaßenstraße 8, 10777 Berlin', lat: 52.49832, lng: 13.35387,
      consignee: 'E. Costa', floor: '2',
      notes: [
        { by: 'driver', text: 'Maaßenstraße is a Begegnungszone — no through traffic; come in from the Nollendorfplatz end.' },
      ] },
    { stop: 3, title: 'Winterfeldtstraße 44', addr: 'Winterfeldtstraße 44, 10781 Berlin', lat: 52.49712, lng: 13.35365,
      consignee: 'O. Lindner', floor: '4',
      notes: [
        { by: 'driver', text: 'The 44 is set back in the courtyard — the street-front bell belongs to the shop.' },
      ] },
    { stop: 4, title: 'Winterfeldtstraße 56', addr: 'Winterfeldtstraße 56, 10781 Berlin', lat: 52.49688, lng: 13.3518,
      consignee: 'Blumen Wittkamp', floor: 'EG',
      notes: [
        { by: 'dispatch', text: 'Fresh flowers — keep them upright, deliver first if you can.' },
      ] },
    { stop: 5, title: 'Winterfeldtstraße 56', addr: 'Winterfeldtstraße 56, 10781 Berlin', lat: 52.49688, lng: 13.3518,
      consignee: 'D. Almeida', floor: '3' },
    { stop: 6, title: 'Nollendorfstraße 25', addr: 'Nollendorfstraße 25, 10777 Berlin', lat: 52.49753, lng: 13.35103,
      consignee: 'K. Müller' },
    { stop: 7, title: 'Nollendorfstraße 17', addr: 'Nollendorfstraße 17, 10777 Berlin', lat: 52.49783, lng: 13.35144,
      consignee: 'Pension Winter', floor: '1',
      notes: [
        { by: 'dispatch', text: 'Ring “Pension Winter” — they take every parcel for the house.' },
      ] },
    { stop: 8, title: 'Motzstraße 5', addr: 'Motzstraße 5, 10777 Berlin', lat: 52.4986, lng: 13.35163,
      consignee: 'S. Schmidt', floor: '4' },
    { stop: 9, title: 'Eisenacher Straße 11', addr: 'Eisenacher Straße 11, 10777 Berlin', lat: 52.49744, lng: 13.34938,
      consignee: 'R. Krause', floor: '1' },
    { stop: 10, title: 'Eisenacher Straße 103', addr: 'Eisenacher Straße 103, 10781 Berlin', lat: 52.49506, lng: 13.34991,
      consignee: 'E. Yılmaz' },
    { stop: 11, title: 'Hohenstaufenstraße 60', addr: 'Hohenstaufenstraße 60, 10781 Berlin', lat: 52.49447, lng: 13.34918,
      consignee: 'A. Kaya', floor: '3' },
    { stop: 12, title: 'Barbarossastraße 59', addr: 'Barbarossastraße 59, 10781 Berlin', lat: 52.49196, lng: 13.34998,
      consignee: 'T. Nguyen', floor: 'EG' },
    { stop: 13, title: 'Martin-Luther-Straße 63', addr: 'Martin-Luther-Straße 63, 10779 Berlin', lat: 52.49071, lng: 13.34539,
      consignee: 'A. Petrosyan', floor: '4',
      notes: [
        { by: 'driver', text: 'Six lanes and no stopping — park on the side street and cross at the lights.' },
      ] },
    { stop: 14, title: 'Münchener Straße 21', addr: 'Münchener Straße 21, 10779 Berlin', lat: 52.48967, lng: 13.34192,
      consignee: 'P. Kowalski' },
    { stop: 15, title: 'Salzburger Straße 17', addr: 'Salzburger Straße 17, 10825 Berlin', lat: 52.48712, lng: 13.34174,
      consignee: 'I. Petrova', floor: '5' },
    { stop: 16, title: 'Salzburger Straße 8', addr: 'Salzburger Straße 8, 10825 Berlin', lat: 52.48704, lng: 13.34241,
      consignee: 'I. Bergström', floor: '5',
      notes: [
        { by: 'dispatch', text: 'Concierge in the lobby signs for all residents until 18:00.' },
      ] },
    { stop: 17, title: 'Wartburgstraße 16', addr: 'Wartburgstraße 16, 10825 Berlin', lat: 52.48688, lng: 13.34357,
      consignee: 'F. Fischer', floor: '2' },
    { stop: 18, title: 'Belziger Straße 69', addr: 'Belziger Straße 69, 10823 Berlin', lat: 52.48481, lng: 13.34653,
      consignee: 'H. Wagner' },
    { stop: 19, title: 'Belziger Straße 52', addr: 'Belziger Straße 52, 10823 Berlin', lat: 52.48655, lng: 13.34839,
      consignee: 'Kita Sonnenwinkel', floor: 'EG',
      notes: [
        { by: 'dispatch', text: 'Ring the office bell, never the group rooms — nap time until 14:30.' },
      ] },
    { stop: 20, title: 'Belziger Straße 52', addr: 'Belziger Straße 52, 10823 Berlin', lat: 52.48655, lng: 13.34839,
      consignee: 'T. Vu', floor: '3' },
    { stop: 21, title: 'Eisenacher Straße 70', addr: 'Eisenacher Straße 70, 10823 Berlin', lat: 52.48642, lng: 13.35097,
      consignee: 'R. Fontane', floor: '2',
      notes: [
        { by: 'driver', text: 'Scaffolding hides the front door — the entrance is through the scaffold tunnel, mind your head.' },
      ] },
    { stop: 22, title: 'Apostel-Paulus-Straße 32', addr: 'Apostel-Paulus-Straße 32, 10823 Berlin', lat: 52.48826, lng: 13.35012,
      consignee: 'K. Šimić', floor: '4',
      notes: [
        { by: 'driver', text: 'Wedding at the church most Saturdays — the whole street is parked up by 13:00.' },
      ] },
    { stop: 23, title: 'Apostel-Paulus-Straße 5', addr: 'Apostel-Paulus-Straße 5, 10823 Berlin', lat: 52.48844, lng: 13.34973,
      consignee: 'M. Becker', floor: '1' },
    { stop: 24, title: 'Eisenacher Straße 44', addr: 'Eisenacher Straße 44, 10823 Berlin', lat: 52.48881, lng: 13.34899,
      consignee: 'L. Hoffmann', floor: '3' },
    { stop: 25, title: 'Akazienstraße 15', addr: 'Akazienstraße 15, 10823 Berlin', lat: 52.48907, lng: 13.35359,
      consignee: 'C. Schulz' },
    { stop: 26, title: 'Grunewaldstraße 81', addr: 'Grunewaldstraße 81, 10823 Berlin', lat: 52.48984, lng: 13.35449,
      consignee: 'Buchhandlung Windrose', floor: 'EG',
      notes: [
        { by: 'dispatch', text: 'Bookshop — deliveries at the back door, ring twice.' },
      ] },
    { stop: 27, title: 'Vorbergstraße 9', addr: 'Vorbergstraße 9, 10823 Berlin', lat: 52.48939, lng: 13.35468,
      consignee: 'D. Koch', floor: '4' },
    { stop: 28, title: 'Belziger Straße 21', addr: 'Belziger Straße 21, 10823 Berlin', lat: 52.48715, lng: 13.35414,
      consignee: 'G. Richter', floor: '2' },
    { stop: 29, title: 'Akazienstraße 27', addr: 'Akazienstraße 27, 10823 Berlin', lat: 52.48684, lng: 13.35494,
      consignee: 'Café Herzstück', floor: 'EG',
      notes: [
        { by: 'dispatch', text: 'Perishables — must be in before 10:30 or it goes back to the depot.' },
        { by: 'driver', text: 'Ask for Paul; the kitchen door in the courtyard is faster than the counter.' },
      ] },
    { stop: 30, title: 'Akazienstraße 27', addr: 'Akazienstraße 27, 10823 Berlin', lat: 52.48684, lng: 13.35494,
      consignee: 'J. Lindqvist', floor: '2' },
    { stop: 31, title: 'Akazienstraße 3', addr: 'Akazienstraße 3, 10823 Berlin', lat: 52.48664, lng: 13.35565,
      consignee: 'M. Berisha', floor: '3',
      notes: [
        { by: 'dispatch', text: 'No answer → leave in the Späti next door — agreed with the customer.' },
      ] },
    { stop: 32, title: 'Feurigstraße 19', addr: 'Feurigstraße 19, 10827 Berlin', lat: 52.48428, lng: 13.35544,
      consignee: 'N. Klein' },
    { stop: 33, title: 'Feurigstraße 54', addr: 'Feurigstraße 54, 10829 Berlin', lat: 52.48372, lng: 13.35501,
      consignee: 'T. Halvorsen', floor: 'Hinterhaus 1',
      notes: [
        { by: 'driver', text: 'The courtyard dog is loud but harmless — the Hinterhaus bell is left of the gate.' },
      ] },
    { stop: 34, title: 'Cheruskerstraße 5', addr: 'Cheruskerstraße 5, 10829 Berlin', lat: 52.48448, lng: 13.35956,
      consignee: 'O. Wolf', floor: '4' },
    { stop: 35, title: 'Leberstraße 21', addr: 'Leberstraße 21, 10829 Berlin', lat: 52.48438, lng: 13.36166,
      consignee: 'B. Neumann', floor: '1' },
    { stop: 36, title: 'Kolonnenstraße 51', addr: 'Kolonnenstraße 51, 10829 Berlin', lat: 52.48574, lng: 13.36261,
      consignee: 'H. Yildiz', floor: '2' },
    { stop: 37, title: 'Kolonnenstraße 51', addr: 'Kolonnenstraße 51, 10829 Berlin', lat: 52.48574, lng: 13.36261,
      consignee: 'P. Grabowski', floor: '4',
      notes: [
        { by: 'driver', text: 'Bell says “Grabowski/Lehmann” — it is the upper button of the two.' },
      ] },
    { stop: 38, title: 'Czeminskistraße 3', addr: 'Czeminskistraße 3, 10829 Berlin', lat: 52.4872, lng: 13.36295,
      consignee: 'U. Schwarz' },
    { stop: 39, title: 'Crellestraße 22', addr: 'Crellestraße 22, 10827 Berlin', lat: 52.48823, lng: 13.36179,
      consignee: 'B. Steinbach', floor: '3',
      notes: [
        { by: 'dispatch', text: 'Customer is hard of hearing — ring long, then phone.' },
      ] },
    { stop: 40, title: 'Crellestraße 22', addr: 'Crellestraße 22, 10827 Berlin', lat: 52.48823, lng: 13.36179,
      consignee: 'Weinhandlung Kober', floor: 'EG',
      notes: [
        { by: 'dispatch', text: 'Wine — ID check, recipient must be 18 or older.' },
      ] },
    { stop: 41, title: 'Erdmannstraße 6', addr: 'Erdmannstraße 6, 10827 Berlin', lat: 52.48909, lng: 13.36157,
      consignee: 'V. Braun', floor: '3' },
    { stop: 42, title: 'Crellestraße 41', addr: 'Crellestraße 41, 10827 Berlin', lat: 52.48775, lng: 13.3598,
      consignee: 'Rahmenwerkstatt Crelle', floor: 'EG',
      notes: [
        { by: 'driver', text: 'Right under the railway embankment — nobody hears a bell when a train passes; knock on the workshop window.' },
      ] },
    { stop: 43, title: 'Hauptstraße 155', addr: 'Hauptstraße 155, 10827 Berlin', lat: 52.48923, lng: 13.35956,
      consignee: 'M. Duncan', floor: '1',
      notes: [
        { by: 'driver', text: 'Bell panel is new and the names are not sorted by floor — Duncan is the handwritten one at the bottom.' },
      ] },
    { stop: 44, title: 'Hauptstraße 155', addr: 'Hauptstraße 155, 10827 Berlin', lat: 52.48923, lng: 13.35956,
      consignee: 'S. Öztürk', floor: '3',
      notes: [
        { by: 'dispatch', text: 'Customer works nights — never ring before 11:00; leave with M. Duncan on 1 instead.' },
      ] },
    { stop: 45, title: 'Hauptstraße 155', addr: 'Hauptstraße 155, 10827 Berlin', lat: 52.48923, lng: 13.35956,
      consignee: 'Familie Brandt', floor: 'EG' },
    { stop: 46, title: 'Vorbergstraße 3', addr: 'Vorbergstraße 3, 10823 Berlin', lat: 52.48894, lng: 13.35732,
      consignee: 'W. Zimmermann', floor: 'EG' },
    { stop: 47, title: 'Elßholzstraße 15', addr: 'Elßholzstraße 15, 10781 Berlin', lat: 52.49174, lng: 13.35633,
      consignee: 'A. Krüger' },
    { stop: 48, title: 'Goltzstraße 13', addr: 'Goltzstraße 13, 10781 Berlin', lat: 52.49249, lng: 13.35359,
      consignee: 'A. Kaminski', floor: '4',
      notes: [
        { by: 'driver', text: 'No elevator and the stair light is on a short timer — you climb the last floor in the dark.' },
      ] },
    { stop: 49, title: 'Goltzstraße 13', addr: 'Goltzstraße 13, 10781 Berlin', lat: 52.49249, lng: 13.35359,
      consignee: 'R. Behrendt', floor: '1' },
    { stop: 50, title: 'Frankenstraße 3', addr: 'Frankenstraße 3, 10781 Berlin', lat: 52.49353, lng: 13.35256,
      consignee: 'J. Hartmann', floor: '5' },
    { stop: 51, title: 'Goltzstraße 32', addr: 'Goltzstraße 32, 10781 Berlin', lat: 52.49448, lng: 13.35375,
      consignee: 'S. Marquardt', floor: '3',
      notes: [
        { by: 'driver', text: 'Market on Winterfeldtplatz Wednesday and Saturday mornings — the square is closed to vans, park on Pallasstraße.' },
      ] },
    { stop: 52, title: 'Pallasstraße 12', addr: 'Pallasstraße 12, 10781 Berlin', lat: 52.4946, lng: 13.35725,
      consignee: 'S. Lange', floor: '2' },
    { stop: 53, title: 'Winterfeldtstraße 25', addr: 'Winterfeldtstraße 25, 10781 Berlin', lat: 52.49657, lng: 13.35701,
      consignee: 'M. Schmitt' },
    { stop: 54, title: 'Zietenstraße 6', addr: 'Zietenstraße 6, 10783 Berlin', lat: 52.49952, lng: 13.35716,
      consignee: 'K. Werner', floor: '1' },
    { stop: 55, title: 'Frobenstraße 27', addr: 'Frobenstraße 27, 10783 Berlin', lat: 52.49955, lng: 13.36059,
      consignee: 'Glasstudio Hertel', floor: 'EG',
      notes: [
        { by: 'dispatch', text: 'Fragile — glass. No parcel box; hand over only.' },
      ] },
    { stop: 56, title: 'Bülowstraße 90', addr: 'Bülowstraße 90, 10783 Berlin', lat: 52.49844, lng: 13.3603,
      consignee: 'E. Lehmann', floor: '3' },
    { stop: 57, title: 'Frobenstraße 15', addr: 'Frobenstraße 15, 10783 Berlin', lat: 52.49721, lng: 13.36015,
      consignee: 'R. Öztürk' },
    { stop: 58, title: 'Potsdamer Straße 143', addr: 'Potsdamer Straße 143, 10783 Berlin', lat: 52.49642, lng: 13.3617,
      consignee: 'T. Demir', floor: '4' },
    { stop: 59, title: 'Potsdamer Straße 159', addr: 'Potsdamer Straße 159, 10783 Berlin', lat: 52.49499, lng: 13.36184,
      consignee: 'reCommerce GmbH — Warenannahme', floor: '2',
      notes: [
        { by: 'dispatch', text: 'Deliveries through the courtyard entrance — ring GOODS-IN, not the front bell.' },
        { by: 'driver', text: 'Courtyard gate is locked after 15:00; before that you can drive right in.' },
      ] },
    { stop: 60, title: 'Potsdamer Straße 159', addr: 'Potsdamer Straße 159, 10783 Berlin', lat: 52.49499, lng: 13.36184,
      consignee: 'Steuerbüro Krause & Kollegen', floor: '4',
      notes: [
        { by: 'dispatch', text: 'Reception on 4 signs for the whole office.' },
      ] },
    { stop: 61, title: 'Potsdamer Straße 159', addr: 'Potsdamer Straße 159, 10783 Berlin', lat: 52.49499, lng: 13.36184,
      consignee: 'Physiotherapie Balance', floor: '1' },
    { stop: 62, title: 'Potsdamer Straße 172', addr: 'Potsdamer Straße 172, 10783 Berlin', lat: 52.49462, lng: 13.36079,
      consignee: 'G. Rossi', floor: '2' },
    { stop: 63, title: 'Potsdamer Straße 180', addr: 'Potsdamer Straße 180, 10783 Berlin', lat: 52.49389, lng: 13.36076,
      consignee: 'N. Haddad' },
    { stop: 64, title: 'Goebenstraße 6', addr: 'Goebenstraße 6, 10783 Berlin', lat: 52.49374, lng: 13.36352,
      consignee: 'L. Lindström', floor: '4' },
    { stop: 65, title: 'Goebenstraße 24', addr: 'Goebenstraße 24, 10783 Berlin', lat: 52.49426, lng: 13.36348,
      consignee: 'P. Janssen', floor: '1' },
    { stop: 66, title: 'Steinmetzstraße 21', addr: 'Steinmetzstraße 21, 10783 Berlin', lat: 52.4952, lng: 13.36287,
      consignee: 'J. Awad', floor: '3',
      notes: [
        { by: 'driver', text: 'House door stands open mornings — go straight up to 3, the bell has been dead since May.' },
      ] },
    { stop: 67, title: 'Alvenslebenstraße 5', addr: 'Alvenslebenstraße 5, 10783 Berlin', lat: 52.49558, lng: 13.36262,
      consignee: 'D. Novák' },
    { stop: 68, title: 'Bülowstraße 71', addr: 'Bülowstraße 71, 10783 Berlin', lat: 52.49735, lng: 13.36635,
      consignee: 'Atelier Marek', floor: 'Hinterhaus 2',
      notes: [
        { by: 'driver', text: 'Front bell does nothing — walk through to the second courtyard, staircase B.' },
      ] },
    { stop: 69, title: 'Bülowstraße 71', addr: 'Bülowstraße 71, 10783 Berlin', lat: 52.49735, lng: 13.36635,
      consignee: 'C. Fontaine', floor: '5',
      notes: [
        { by: 'dispatch', text: '24 kg parcel — two-person lift; the caretaker in the EG has the freight elevator key.' },
      ] },
    { stop: 70, title: 'Alvenslebenstraße 12', addr: 'Alvenslebenstraße 12, 10783 Berlin', lat: 52.49523, lng: 13.36549,
      consignee: 'F. Horvat', floor: '3' },
    { stop: 71, title: 'Kulmer Straße 20', addr: 'Kulmer Straße 20, 10783 Berlin', lat: 52.49215, lng: 13.3647,
      consignee: 'V. Ratkowski', floor: '2',
      notes: [
        { by: 'driver', text: 'Yorckstraße end is fenced off for the bridge works — come in from Goebenstraße.' },
      ] },
    { stop: 72, title: 'Katzlerstraße 5', addr: 'Katzlerstraße 5, 10829 Berlin', lat: 52.49208, lng: 13.36889,
      consignee: 'C. Dubois', floor: 'EG' },
    { stop: 73, title: 'Großgörschenstraße 27', addr: 'Großgörschenstraße 27, 10829 Berlin', lat: 52.49126, lng: 13.36821,
      consignee: 'M. Fischer', floor: '2' },
    { stop: 74, title: 'Großgörschenstraße 27', addr: 'Großgörschenstraße 27, 10829 Berlin', lat: 52.49126, lng: 13.36821,
      consignee: 'L. Fischer', floor: '2',
      notes: [
        { by: 'dispatch', text: 'Two parcels, two Fischers, one flat — brother and sister, either may sign.' },
      ] },
    { stop: 75, title: 'Bautzener Straße 22', addr: 'Bautzener Straße 22, 10829 Berlin', lat: 52.49028, lng: 13.37104,
      consignee: 'M. Okafor' },
    { stop: 76, title: 'Naumannstraße 33', addr: 'Naumannstraße 33, 10829 Berlin', lat: 52.48273, lng: 13.3652,
      consignee: 'Tischlerei Grund & Sohn', floor: 'EG',
      notes: [
        { by: 'dispatch', text: 'Carpentry workshop — yard gate open 07:00–16:00, honk once at the gate.' },
      ] },
    { stop: 77, title: 'Gustav-Müller-Straße 12', addr: 'Gustav-Müller-Straße 12, 10829 Berlin', lat: 52.48255, lng: 13.36236,
      consignee: 'A. Silva', floor: '5' },
    { stop: 78, title: 'Gotenstraße 71', addr: 'Gotenstraße 71, 10829 Berlin', lat: 52.48301, lng: 13.36044,
      consignee: 'Fahrradkurier Kollektiv Süd', floor: 'EG',
      notes: [
        { by: 'dispatch', text: 'Garage delivery — down the ramp, gate code 2580#, leave it by the cage.' },
      ] },
    { stop: 79, title: 'Gotenstraße 12', addr: 'Gotenstraße 12, 10829 Berlin', lat: 52.48253, lng: 13.36013,
      consignee: 'H. Jansen', floor: '2' },
    { stop: 80, title: 'Leuthener Straße 12', addr: 'Leuthener Straße 12, 10829 Berlin', lat: 52.48147, lng: 13.36215,
      consignee: 'I. Kovács' },
    { stop: 81, title: 'Leberstraße 65', addr: 'Leberstraße 65, 10829 Berlin', lat: 52.48086, lng: 13.36159,
      consignee: 'H. Mancini', floor: '2',
      notes: [
        { by: 'driver', text: 'Tight one-way — if the bin lorry is in, back out early or you sit there ten minutes.' },
      ] },
    { stop: 82, title: 'Cheruskerstraße 18', addr: 'Cheruskerstraße 18, 10829 Berlin', lat: 52.48097, lng: 13.35916,
      consignee: 'P. Vandenberg', floor: '3',
      notes: [
        { by: 'driver', text: 'The park side has no house entrances — go around via Gotenstraße.' },
      ] },
    { stop: 83, title: 'Ebersstraße 76', addr: 'Ebersstraße 76, 10827 Berlin', lat: 52.48043, lng: 13.35282,
      consignee: 'B. Sørensen', floor: '1' },
    { stop: 84, title: 'Hauptstraße 122', addr: 'Hauptstraße 122, 10827 Berlin', lat: 52.48272, lng: 13.35082,
      consignee: 'E. Marino', floor: '3' },
    { stop: 85, title: 'Hauptstraße 40', addr: 'Hauptstraße 40, 10827 Berlin', lat: 52.4839, lng: 13.35101,
      consignee: 'W. Okonkwo', floor: '3',
      notes: [
        { by: 'driver', text: 'Bus lane camera — do not stop on Hauptstraße itself; pull into the side street and walk back.' },
      ] },
    { stop: 86, title: 'Dominicusstraße 18', addr: 'Dominicusstraße 18, 10823 Berlin', lat: 52.48217, lng: 13.34694,
      consignee: 'Ingenieurbüro Voss & Partner', floor: '3',
      notes: [
        { by: 'dispatch', text: 'Office building — reception on 1 takes everything.' },
      ] },
    { stop: 87, title: 'Freiherr-vom-Stein-Straße 11', addr: 'Freiherr-vom-Stein-Straße 11, 10825 Berlin', lat: 52.48274, lng: 13.33776,
      consignee: 'S. Popescu' },
    { stop: 88, title: 'Meraner Straße 16', addr: 'Meraner Straße 16, 10825 Berlin', lat: 52.48656, lng: 13.33865,
      consignee: 'V. Ivanova', floor: '4' },
    { stop: 89, title: 'Innsbrucker Straße 4', addr: 'Innsbrucker Straße 4, 10825 Berlin', lat: 52.48731, lng: 13.34017,
      consignee: 'Praxis Dr. Sarholz', floor: '1',
      notes: [
        { by: 'dispatch', text: 'Practice is closed 13:00–15:00 — outside that, reception takes everything.' },
      ] },
    { stop: 90, title: 'Innsbrucker Straße 4', addr: 'Innsbrucker Straße 4, 10825 Berlin', lat: 52.48731, lng: 13.34017,
      consignee: 'K. Neumann', floor: '4' },
    { stop: 91, title: 'Meraner Straße 5', addr: 'Meraner Straße 5, 10825 Berlin', lat: 52.48758, lng: 13.3395,
      consignee: 'F. Duval', floor: '2',
      notes: [
        { by: 'dispatch', text: 'Do NOT leave with neighbours — customer request on file.' },
      ] },
    { stop: 92, title: 'Grunewaldstraße 55', addr: 'Grunewaldstraße 55, 10825 Berlin', lat: 52.48819, lng: 13.3384,
      consignee: 'J. Fernández', floor: '2' },
    { stop: 93, title: 'Haberlandstraße 8', addr: 'Haberlandstraße 8, 10779 Berlin', lat: 52.49095, lng: 13.33769,
      consignee: 'K. da Silva' },
    { stop: 94, title: 'Landshuter Straße 12', addr: 'Landshuter Straße 12, 10779 Berlin', lat: 52.49161, lng: 13.3389,
      consignee: 'T. Andersen', floor: '4' },
    { stop: 95, title: 'Barbarossastraße 24', addr: 'Barbarossastraße 24, 10779 Berlin', lat: 52.49252, lng: 13.34231,
      consignee: 'N. Salah', floor: '1',
      notes: [
        { by: 'dispatch', text: 'Cash on delivery 23,90 € — exact change appreciated.' },
      ] },
    { stop: 96, title: 'Schwäbische Straße 27', addr: 'Schwäbische Straße 27, 10781 Berlin', lat: 52.49366, lng: 13.34738,
      consignee: 'R. Nowak', floor: '1' },
    { stop: 97, title: 'Luitpoldstraße 34', addr: 'Luitpoldstraße 34, 10777 Berlin', lat: 52.49483, lng: 13.34565,
      consignee: 'M. Yıldırım' },
    { stop: 98, title: 'Viktoria-Luise-Platz 7', addr: 'Viktoria-Luise-Platz 7, 10777 Berlin', lat: 52.4959, lng: 13.34078,
      consignee: 'Dr. L. Weidemann', floor: '3',
      notes: [
        { by: 'driver', text: 'School run on Motzstraße 07:45–08:15 — the loading bay on the platz side is free then.' },
      ] },
    { stop: 99, title: 'Motzstraße 60', addr: 'Motzstraße 60, 10777 Berlin', lat: 52.4952, lng: 13.3397,
      consignee: 'A. Schneider', floor: '3' },
    { stop: 100, title: 'Hohenstaufenstraße 37', addr: 'Hohenstaufenstraße 37, 10779 Berlin', lat: 52.49447, lng: 13.33948,
      consignee: 'G. Adamczyk', floor: '2',
      notes: [
        { by: 'dispatch', text: 'Customer is on crutches — please bring it up to 2, she buzzes you in.' },
      ] },
  ],
};
