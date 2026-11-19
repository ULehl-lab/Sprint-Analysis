// SprintLab – Rechenkern (reine Funktionen, keine DOM-Abhängigkeit)
// Läuft im Browser (ES-Modul) und in Node (für die Tests).

/** Annahme für die Unsicherheit beim Antippen eines Fußpunkts (1 Sigma, in Metern). */
export const TAP_SIGMA_M = 0.03;

/**
 * Kleinste-Quadrate-Anpassung der Hütchen-Positionen.
 * Modell in der Ebene der kameraseitigen Bahnlinie:  x_px = a + s * X   (X in Metern ab erstem Hütchen)
 * @param {{x:number,y?:number}[]} points  angetippte Hütchen (Pixel im Videobild)
 * @param {number} spacing  Abstand zwischen zwei angetippten Hütchen in m
 * @param {'ltr'|'rtl'} direction  Laufrichtung im Bild (ltr = von links nach rechts)
 */
export function fitCones(points, spacing = 1, direction = 'ltr') {
  const xs = points.map(p => p.x).sort((p, q) => p - q);
  if (direction === 'rtl') xs.reverse();
  const n = xs.length;
  if (n < 2 || !(spacing > 0)) return null;
  let sx = 0, sX = 0, sxX = 0, sXX = 0;
  xs.forEach((x, k) => { const X = k * spacing; sx += x; sX += X; sxX += x * X; sXX += X * X; });
  const s = (n * sxX - sx * sX) / (n * sXX - sX * sX);
  const a = (sx - s * sX) / n;
  let ss = 0, maxR = 0;
  xs.forEach((x, k) => { const r = x - (a + s * k * spacing); ss += r * r; maxR = Math.max(maxR, Math.abs(r)); });
  const dof = n > 2 ? n - 2 : 1; // bei 2 Punkten ist die Anpassung exakt (keine Prüfung möglich)
  const rmsPx = n > 2 ? Math.sqrt(ss / dof) : 0;
  return { a, s, n, rmsPx, rmsM: rmsPx / Math.abs(s), maxM: maxR / Math.abs(s), checked: n > 2, xsSorted: xs };
}

/**
 * Liefert eine Funktion Pixel-x → Streckenposition in m (in Laufrichtung zunehmend).
 * Perspektivkorrektur: Die Füße laufen `laneOffset` m weiter von der Kamera entfernt als die
 * Linie mit den Hütchen, daher ist der Maßstab dort um camDist/(camDist+laneOffset) kleiner.
 * Annahme: Kamera steht ruhig, blickt senkrecht zur Bahn, Hauptpunkt = Bildmitte.
 */
export function makeMapper(fit, { camDist, laneOffset, imgW, firstConeM = 0 }) {
  const cx = imgW / 2;
  const Xc = (cx - fit.a) / fit.s;                       // Position (m), die genau in Bildmitte liegt
  const sAth = fit.s * camDist / (camDist + laneOffset); // Pixel pro Meter in der Läuferebene
  const toM = px => firstConeM + Xc + (px - cx) / sAth;
  const toPxAthlete = X => cx + sAth * (X - firstConeM - Xc);
  const toPxLine = X => fit.a + fit.s * (X - firstConeM);
  return { toM, toPxAthlete, toPxLine, sAth, sLine: fit.s, cx };
}

/** Kalibrierung eines Laufs auswerten. Gibt null zurück, wenn unvollständig. */
export function calibrationOf(calib) {
  if (!calib || !calib.points || calib.points.length < 2 || !calib.imgW) return null;
  const fit = fitCones(calib.points, calib.spacing || 1, calib.direction || 'ltr');
  if (!fit) return null;
  const mapper = makeMapper(fit, calib);
  return { fit, mapper };
}

const mean = a => a.length ? a.reduce((p, q) => p + q, 0) / a.length : null;

/**
 * Auswertung eines Laufs.
 * Ein Kontakt = { foot:'L'|'R', f: erstes Bild mit Bodenkontakt, l: letztes Bild mit Bodenkontakt, x, y: Fußpunkt (Pixel) }
 *  Bodenkontaktzeit  = (l - f + 1) / fps
 *  Flugzeit (danach) = (f_next - l - 1) / fps
 *  Schrittzeit       = (f_next - f) / fps  (= Kontakt + Flug)
 *  Schrittlänge      = |X_next - X|   (Fußpunkte beim ersten Bodenkontakt)
 */
export function computeRun(run, fps = 240) {
  const warnings = [];
  const cal = calibrationOf(run.calib);
  const done = (run.contacts || []).filter(c => c.l != null && c.l >= c.f).sort((p, q) => p.f - q.f);
  const open = (run.contacts || []).length - done.length;
  if (open > 0) warnings.push(`${open} Kontakt(e) ohne „letztes Kontakt-Bild“ werden nicht gewertet.`);

  const contacts = done.map((c, i) => ({
    i, foot: c.foot, f: c.f, l: c.l,
    gct: (c.l - c.f + 1) / fps * 1000,
    X: cal && c.x != null ? cal.mapper.toM(c.x) : null,
    ft: null, stepTime: null, stepLen: null, freq: null,
  }));
  for (let i = 0; i < contacts.length - 1; i++) {
    const a = contacts[i], b = contacts[i + 1];
    a.ft = (b.f - a.l - 1) / fps * 1000;
    a.stepTime = (b.f - a.f) / fps * 1000;
    a.freq = a.stepTime > 0 ? 1000 / a.stepTime : null;
    if (a.X != null && b.X != null) a.stepLen = Math.abs(b.X - a.X);
    if (a.ft < 0) warnings.push(`Kontakt ${i + 2} beginnt vor dem Ende von Kontakt ${i + 1}.`);
    if (a.X != null && b.X != null && i > 0 && Math.sign(b.X - a.X) !== Math.sign(contacts[1].X - contacts[0].X))
      warnings.push(`Fußpunkt ${i + 2} liegt „hinter“ Fußpunkt ${i + 1} – Laufrichtung/Hütchen prüfen.`);
  }
  contacts.forEach(c => {
    if (c.gct < 50 || c.gct > 300) warnings.push(`Kontakt ${c.i + 1}: Bodenkontaktzeit ${Math.round(c.gct)} ms ist unplausibel.`);
    if (c.ft != null && c.ft > 250) warnings.push(`Kontakt ${c.i + 1}: Flugzeit ${Math.round(c.ft)} ms ist ungewöhnlich lang.`);
    if (c.stepLen != null && (c.stepLen < 0.4 || c.stepLen > 3.2)) warnings.push(`Schritt ${c.i + 1}: Länge ${c.stepLen.toFixed(2)} m ist unplausibel.`);
  });
  if (cal && cal.fit.checked && (cal.fit.rmsM > 0.03 || cal.fit.maxM > 0.05))
    warnings.push(`Kalibrierung: Hütchen weichen bis zu ${(cal.fit.maxM * 100).toFixed(1)} cm vom gleichen Abstand ab – falsch angetippt oder Kamera nicht senkrecht/ruhig? Schrittlängen ggf. ungenau.`);

  const steps = contacts.filter(c => c.stepTime != null && c.ft >= 0);
  const withLen = steps.filter(c => c.stepLen != null);
  const summary = {
    nContacts: contacts.length,
    gct: mean(contacts.map(c => c.gct)),
    gctL: mean(contacts.filter(c => c.foot === 'L').map(c => c.gct)),
    gctR: mean(contacts.filter(c => c.foot === 'R').map(c => c.gct)),
    ft: mean(steps.map(c => c.ft)),
    stepLen: mean(withLen.map(c => c.stepLen)),
    stepTime: mean(steps.map(c => c.stepTime)),
    freq: mean(steps.map(c => c.freq)),
  };

  const speed = speedFromContacts(contacts, fps, cal);
  return { contacts, summary, speed, warnings, calibrated: !!cal, cal };
}

/**
 * Geschwindigkeit über einen 6–8 m langen Abschnitt, gemessen zwischen zwei Fußaufsätzen:
 *   v = (X_j - X_i) / ((f_j - f_i) / fps)
 * Es wird der schnellste Abschnitt gewählt. Rückgabe enthält eine geschätzte Unsicherheit.
 * `ok` ist nur true bei sauberer Kalibrierung (≥3 Hütchen, ≤3 cm Abweichung) und ≥3 Schritten im Abschnitt.
 */
export function speedFromContacts(contacts, fps, cal, minSpan = 6, maxSpan = 8) {
  const pts = contacts.filter(c => c.X != null);
  if (pts.length < 2) return { v: null, reason: cal ? 'Zu wenige Kontakte mit Position.' : 'Keine Kalibrierung (Hütchen antippen).' };
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const span = pts[j].X - pts[i].X;
      if (span < minSpan) continue;
      if (span > maxSpan) break;
      const dt = (pts[j].f - pts[i].f) / fps;
      if (dt <= 0) continue;
      const v = span / dt;
      if (!best || v > best.v) best = { v, span, dt, i: pts[i].i, j: pts[j].i, steps: j - i, X0: pts[i].X, X1: pts[j].X };
      break; // kürzester gültiger Abschnitt ab i genügt
    }
  }
  if (!best) {
    const total = Math.abs(pts[pts.length - 1].X - pts[0].X);
    return { v: null, reason: `Markierte Strecke nur ${total.toFixed(1)} m – für 6–8 m werden Kontakte über mindestens 6 m benötigt.` };
  }
  const sigmaX = Math.hypot(TAP_SIGMA_M, cal && cal.fit.checked ? cal.fit.rmsM : 0);
  const relX = Math.SQRT2 * sigmaX / best.span;
  const relT = (1 / fps) / best.dt;
  best.rel = Math.hypot(relX, relT);
  best.dv = best.v * best.rel;
  best.ok = !!(cal && cal.fit.checked && cal.fit.rmsM <= 0.03 && cal.fit.maxM <= 0.05 && best.steps >= 3);
  best.reason = best.ok ? null : (!cal.fit.checked
    ? 'Nur 2 Hütchen kalibriert – Genauigkeit nicht prüfbar.'
    : (cal.fit.rmsM > 0.03 || cal.fit.maxM > 0.05) ? 'Kalibrierung ungenau.' : 'Weniger als 3 Schritte im Abschnitt.');
  return best;
}

/**
 * Geschwindigkeit für einen festen Abschnitt [A, B] (m): Zeit, zu der die Fußaufsatzpunkte A bzw. B
 * erreichen, wird zwischen benachbarten Kontakten linear interpoliert. Nur möglich, wenn die Kontakte A und B umschließen.
 */
export function speedInSection(contacts, fps, A, B) {
  const pts = contacts.filter(c => c.X != null);
  if (pts.length < 2 || !(B > A)) return null;
  for (let i = 1; i < pts.length; i++) if (!(pts[i].X > pts[i - 1].X)) return null; // muss streng monoton sein
  const tAt = X => {
    for (let i = 0; i < pts.length - 1; i++) {
      if (X >= pts[i].X && X <= pts[i + 1].X) {
        const r = (X - pts[i].X) / (pts[i + 1].X - pts[i].X);
        return (pts[i].f + r * (pts[i + 1].f - pts[i].f)) / fps;
      }
    }
    return null;
  };
  const t0 = tAt(A), t1 = tAt(B);
  if (t0 == null || t1 == null || t1 <= t0) return null;
  return { v: (B - A) / (t1 - t0), A, B, dt: t1 - t0 };
}

/** Ergebnis eines Laufs im Rahmen einer Session (fps aus Lauf-Kalibrierung, sonst Session-Einstellung). */
export function runResult(run, session) {
  const fps = (run.calib && run.calib.fps) || session.settings.captureFps || 240;
  const r = computeRun(run, fps);
  const s = session.settings;
  r.section = (s.sectionA != null && s.sectionB != null && r.calibrated)
    ? speedInSection(r.contacts, fps, s.sectionA, s.sectionB) : null;
  r.fps = fps;
  return r;
}

/** Session-Übersicht: pro Athlet alle Läufe mit Kennzahlen. */
export function summarizeSession(session) {
  const out = session.athletes.map(ath => {
    const runs = session.runs.filter(r => r.athleteId === ath.id)
      .sort((p, q) => (p.n || 0) - (q.n || 0))
      .map(run => ({ run, res: runResult(run, session) }));
    const speeds = runs.map(x => x.res.speed && x.res.speed.v).filter(v => v != null);
    return {
      athlete: ath, runs,
      bestV: speeds.length ? Math.max(...speeds) : null,
      meanGct: mean(runs.map(x => x.res.summary.gct).filter(v => v != null)),
      meanFt: mean(runs.map(x => x.res.summary.ft).filter(v => v != null)),
      meanLen: mean(runs.map(x => x.res.summary.stepLen).filter(v => v != null)),
      meanFreq: mean(runs.map(x => x.res.summary.freq).filter(v => v != null)),
    };
  });
  return out;
}

// ---------- Formatierung / Export ----------
export function fmt(x, d = 2) {
  return x == null || Number.isNaN(x) ? '–' : x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
}

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvNum = (x, d) => (x == null ? '' : x.toFixed(d).replace('.', ','));

/** CSV (Semikolon, Dezimalkomma, UTF-8-BOM → öffnet sich direkt in deutschem Excel/Numbers). */
export function buildCsv(session) {
  const sum = [['Session', 'Datum', 'Athlet', 'Lauf', 'Kontakte', 'v 6-8m [m/s]', '± [m/s]', 'v Qualität', 'Abschnitt von [m]', 'Abschnitt bis [m]',
    'Ø Bodenkontakt [ms]', 'Ø Flugzeit [ms]', 'Ø Schrittlänge [m]', 'Ø Schrittfrequenz [Hz]', 'v Messabschnitt [m/s]', 'Notiz']];
  const det = [['Session', 'Athlet', 'Lauf', 'Kontakt', 'Fuß', 'Erstes Bild', 'Letztes Bild', 'Bodenkontakt [ms]', 'Flugzeit danach [ms]',
    'Schrittzeit [ms]', 'Schrittlänge danach [m]', 'Position [m]']];
  for (const a of summarizeSession(session)) {
    for (const { run, res } of a.runs) {
      const sp = res.speed || {};
      sum.push([session.name, session.date, a.athlete.name, run.n, res.summary.nContacts,
        csvNum(sp.v, 2), csvNum(sp.dv, 2), sp.v == null ? '' : (sp.ok ? 'ok' : 'unsicher'),
        csvNum(sp.X0, 2), csvNum(sp.X1, 2),
        csvNum(res.summary.gct, 0), csvNum(res.summary.ft, 0), csvNum(res.summary.stepLen, 2), csvNum(res.summary.freq, 2),
        csvNum(res.section && res.section.v, 2), run.note || '']);
      res.contacts.forEach(c => det.push([session.name, a.athlete.name, run.n, c.i + 1, c.foot, c.f, c.l,
        csvNum(c.gct, 1), csvNum(c.ft, 1), csvNum(c.stepTime, 1), csvNum(c.stepLen, 3), csvNum(c.X, 3)]));
    }
  }
  const toCsv = rows => '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');
  return { summary: toCsv(sum), contacts: toCsv(det) };
}
