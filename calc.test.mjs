// Tests für calc.js – Aufruf:  node calc.test.mjs
import assert from 'node:assert/strict';
import { fitCones, makeMapper, computeRun, runResult, summarizeSession, buildCsv, speedInSection } from './calc.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ---- Synthetisches Kameramodell (Lochkamera, senkrecht zur Bahn) ----
const W = 1920, f = 1500;          // Brennweite in Pixeln
const d = 10, off = 0.61;          // Abstand Kamera–Linie, Läufer in Bahnmitte
const Xcam = 12;                   // Kamera steht bei 12 m der Strecke
const pxLine = X => W / 2 + (f / d) * (X - Xcam);
const pxAth = X => W / 2 + (f / (d + off)) * (X - Xcam);
const cones = Array.from({ length: 21 }, (_, k) => ({ x: pxLine(k), y: 800 }));   // Hütchen 0..20 m

for (const dir of ['ltr', 'rtl']) {
  // Bei rtl laufen wir „spiegelverkehrt“: Bildkoordinate x' = W - x
  const flip = dir === 'rtl' ? (x => W - x) : (x => x);
  const pts = cones.map(c => ({ x: flip(c.x), y: c.y }));
  const fit = fitCones(pts, 1, dir);
  close(fit.rmsM, 0, 1e-9, 'Residuum ' + dir);
  const map = makeMapper(fit, { camDist: d, laneOffset: off, imgW: W, firstConeM: 0 });
  for (const X of [0, 3.7, 10, 19.2]) close(map.toM(flip(pxAth(X))), X, 1e-6, `Mapper ${dir} X=${X}`);
}

// ---- Sprint-Simulation: v = 9 m/s, Schrittlänge 2,25 m, GCT 100 ms bei 240 fps ----
const fps = 240, v = 9, L = 2.25;
const T = L / v;                    // 0,25 s Schrittzeit = 60 Bilder
const contacts = [];
for (let i = 0; i < 10; i++) {
  const X = 4 + i * L;
  const f0 = 100 + Math.round(i * T * fps);
  contacts.push({ foot: i % 2 ? 'R' : 'L', f: f0, l: f0 + 23, x: pxAth(X), y: 790 });  // 24 Bilder = 100 ms
}
const run = { id: 'r1', athleteId: 'a1', n: 1, contacts,
  calib: { points: cones, spacing: 1, direction: 'ltr', camDist: d, laneOffset: off, imgW: W, firstConeM: 0, fps } };
const res = computeRun(run, fps);
close(res.summary.gct, 100, 1e-9, 'GCT');
close(res.summary.ft, 150, 1e-9, 'Flugzeit');          // 250 - 100
close(res.summary.stepLen, L, 1e-6, 'Schrittlänge');
close(res.summary.freq, 4, 1e-9, 'Frequenz');
assert.ok(res.speed.v != null, 'Geschwindigkeit vorhanden');
close(res.speed.v, v, 0.05, 'Geschwindigkeit');
assert.ok(res.speed.span >= 6 && res.speed.span <= 8, 'Abschnitt 6–8 m');
assert.ok(res.speed.ok, 'Qualität ok');
console.log(`v = ${res.speed.v.toFixed(3)} m/s ± ${res.speed.dv.toFixed(3)} (Abschnitt ${res.speed.span.toFixed(2)} m, ${res.speed.steps} Schritte)`);

// ---- Fehlerfall: falscher Kamera-Abstand (10 m statt 12 m) → Schrittlänge verschiebt sich um ~ (Δ) ----
const wrong = computeRun({ ...run, calib: { ...run.calib, camDist: 12 } }, fps);
console.log(`Schrittlänge bei 2 m falschem Kameraabstand: ${wrong.summary.stepLen.toFixed(3)} m (wahr ${L})`);

// ---- Zu kurze Strecke → keine Geschwindigkeit ----
const short = computeRun({ ...run, contacts: contacts.slice(0, 3) }, fps);
assert.equal(short.speed.v, null);

// ---- Nur 2 Hütchen → Geschwindigkeit „unsicher“ ----
const two = computeRun({ ...run, calib: { ...run.calib, points: [cones[0], cones[1]] } }, fps);
assert.ok(two.speed.v != null && !two.speed.ok);

// ---- Hütchen ungenau (1 Hütchen um 6 cm verschoben) → Warnung ----
const bad = cones.map((c, i) => i === 5 ? { ...c, x: c.x + 9 } : c);
const badRes = computeRun({ ...run, calib: { ...run.calib, points: bad } }, fps);
assert.ok(badRes.warnings.some(w => w.startsWith('Kalibrierung')), 'Ausreißer-Warnung');
assert.equal(badRes.speed.ok, false);

// ---- Unvollständiger Kontakt wird nicht gewertet ----
const open = computeRun({ ...run, contacts: [...contacts, { foot: 'L', f: 5000, l: null, x: 100, y: 100 }] }, fps);
assert.equal(open.summary.nContacts, 10);
assert.ok(open.warnings.some(w => w.includes('ohne')));

// ---- Festabschnitt mit Interpolation ----
const sec = speedInSection(res.contacts, fps, 8, 15);
close(sec.v, v, 0.1, 'Abschnitt 8–15 m');
assert.equal(speedInSection(res.contacts, fps, 0, 15), null);

// ---- Session / CSV ----
const session = { id: 's', name: 'Test', date: '2026-11-19', settings: { captureFps: 240 },
  athletes: [{ id: 'a1', name: 'Dennis' }], runs: [run] };
const sum = summarizeSession(session);
assert.equal(sum[0].runs.length, 1);
close(sum[0].bestV, v, 0.05, 'bestV');
const csv = buildCsv(session);
assert.ok(csv.summary.includes('Dennis') && csv.contacts.split('\r\n').length === 11);
console.log('Alle Tests bestanden.');
