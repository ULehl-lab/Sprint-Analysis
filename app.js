// SprintLab – Sprint-Analyse aus 240-fps-Seitenaufnahmen (iPhone, läuft komplett im Browser)
import { runResult, summarizeSession, buildCsv, fmt, calibrationOf } from './calc.js';

const VERSION = '1.0';

// ───────────────────────── kleine Helfer ─────────────────────────
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') e[k] = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const num = v => { const x = parseFloat(String(v).replace(',', '.')); return Number.isFinite(x) ? x : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const once = (el, ev, ms = 1500) => new Promise(res => {
  let done = false;
  const f = () => { if (done) return; done = true; el.removeEventListener(ev, f); res(true); };
  el.addEventListener(ev, f);
  setTimeout(() => { if (!done) { done = true; el.removeEventListener(ev, f); res(false); } }, ms);
});
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
const today = () => new Date().toISOString().slice(0, 10);
const deDate = iso => iso ? iso.split('-').reverse().join('.') : '';

// ───────────────────────── Speicher ─────────────────────────
const KEY = 'sprintlab.v1';
const db = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || { sessions: [] }; } catch { return { sessions: [] }; } })();
let saveTimer = null;
function save(now = false) {
  clearTimeout(saveTimer);
  const go = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { toast('Speichern fehlgeschlagen: ' + e.message); } };
  if (now) go(); else saveTimer = setTimeout(go, 250);
}
const getSession = id => db.sessions.find(s => s.id === id);
const defaultSettings = () => ({ camDist: 10, laneOffset: 0.61, captureFps: 240, coneSpacing: 1, firstConeM: 0, direction: 'ltr', sectionA: null, sectionB: null });

function newCalib(session) {
  const l = session.lastCalib, s = session.settings;
  return {
    points: l ? l.points.map(p => ({ ...p })) : [], imgW: l ? l.imgW : 0, imgH: l ? l.imgH : 0,
    spacing: s.coneSpacing, firstConeM: s.firstConeM, direction: s.direction,
    camDist: s.camDist, laneOffset: s.laneOffset, fps: s.captureFps,
  };
}

async function shareFile(name, text, mime) {
  const file = new File([text], name, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = h('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(a); a.click(); a.remove();
}

function modal(title, body, buttons) {
  const close = () => ov.remove();
  const ov = h('div', { class: 'overlay', onclick: e => { if (e.target === ov) close(); } },
    h('div', { class: 'sheet' }, h('h2', {}, title), body,
      h('div', { class: 'actions' }, buttons.map(b => h('button', { class: 'btn ' + (b.cls || ''), onclick: () => { if (b.fn ? b.fn(close) !== false : true) close(); } }, b.label)))));
  document.body.append(ov);
  return close;
}
function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('span', { class: 'small muted' }, hint) : null);
}
const numInput = (v, extra) => h('input', { type: 'text', inputmode: 'decimal', value: v == null ? '' : String(v).replace('.', ','), ...(extra || {}) });

// ───────────────────────── Video mit Bild-genauem Zugriff ─────────────────────────
class FrameVideo {
  constructor() {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    v.preload = 'auto'; v.controls = false;
    Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
    document.body.append(v);
    this.v = v; this.dt = 1 / 240; this.t0 = 0; this.n = 1; this.cur = 0; this.notes = []; this.fileFps = 240;
  }
  get hasRvfc() { return 'requestVideoFrameCallback' in this.v; }

  async open(file, captureFps) {
    const v = this.v;
    this.url = URL.createObjectURL(file);
    v.src = this.url; v.load();
    const ok = await once(v, 'loadedmetadata', 10000);
    if (!ok || !v.videoWidth) throw new Error('Video konnte nicht gelesen werden (Format?).');
    if (v.readyState < 2) await once(v, 'loadeddata', 4000);
    await this.probe(captureFps);
    this.n = Math.max(1, Math.round((v.duration - this.t0) / this.dt));
    await this.seek(0);
  }

  /** Bildabstand der Datei messen (Zeitstempel der Einzelbilder beim langsamen Abspielen). */
  async probe(captureFps) {
    const v = this.v, times = [];
    if (!this.hasRvfc) {
      this.dt = 1 / captureFps; this.t0 = 0; this.fileFps = captureFps;
      this.notes.push('Dieser Browser kann die Bildzeitstempel nicht auslesen – Bildabstand 1/' + captureFps + ' s angenommen.');
      return;
    }
    v.currentTime = 0; await once(v, 'seeked', 800);
    v.playbackRate = 0.25;
    await new Promise(resolve => {
      let done = false;
      const fin = () => { if (done) return; done = true; try { v.pause(); } catch { /* */ } resolve(); };
      const cb = (_now, meta) => { times.push(meta.mediaTime); if (times.length >= 48 || v.ended) fin(); else v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
      v.play().catch(fin);
      setTimeout(fin, 6000);
    });
    v.playbackRate = 1;
    const deltas = [];
    for (let i = 1; i < times.length; i++) { const d = times[i] - times[i - 1]; if (d > 1e-5) deltas.push(d); }
    if (deltas.length < 3) {
      this.dt = 1 / captureFps; this.t0 = 0; this.fileFps = captureFps;
      this.notes.push('Bildabstand ließ sich nicht messen – ' + captureFps + ' Bilder/s angenommen.');
      return;
    }
    const dt = Math.min(...deltas);
    this.dt = dt; this.fileFps = 1 / dt;
    this.t0 = times[0] - Math.floor(times[0] / dt + 1e-6) * dt;
    const irregular = deltas.some(d => Math.abs(d / dt - Math.round(d / dt)) > 0.08);
    if (irregular) this.notes.push('Uneinheitliche Bildabstände am Videoanfang (Zeitlupen-Rampe oder Variable Framerate?). Bildzuordnung bitte prüfen.');
  }

  /** Auf Bild f springen (Bild-genau). Gibt das tatsächlich angezeigte Bild zurück. */
  async seek(f) {
    f = clamp(Math.round(f), 0, this.n - 1);
    const v = this.v;
    const target = this.t0 + (f + 0.5) * this.dt;
    const seeked = once(v, 'seeked', 600);
    let frameTime = null;
    const got = this.hasRvfc ? new Promise(res => v.requestVideoFrameCallback((_n, m) => { frameTime = m.mediaTime; res(); })) : Promise.resolve();
    v.currentTime = Math.min(target, Math.max(0, v.duration - 0.0001));
    await seeked;
    await Promise.race([got, sleep(90)]);
    let shown = f;
    if (frameTime != null) {
      const actual = Math.round((frameTime - this.t0) / this.dt);
      if (Math.abs(actual - f) >= 2) { shown = actual; this.mismatch = (this.mismatch || 0) + 1; }
    }
    this.cur = clamp(shown, 0, this.n - 1);
    return this.cur;
  }

  play(rate, onFrame) {
    const v = this.v;
    v.playbackRate = rate;
    const loop = (_n, meta) => {
      if (v.paused) return;
      this.cur = clamp(Math.round((meta.mediaTime - this.t0) / this.dt), 0, this.n - 1);
      onFrame(this.cur);
      if (v.ended) return;
      v.requestVideoFrameCallback(loop);
    };
    v.requestVideoFrameCallback(loop);
    return v.play();
  }
  pause() { try { this.v.pause(); } catch { /* */ } }
  destroy() { this.pause(); this.v.remove(); if (this.url) URL.revokeObjectURL(this.url); }
}

// ───────────────────────── Analyse-Ansicht ─────────────────────────
class Analysis {
  constructor(session, run, file) {
    this.s = session; this.run = run; this.fv = null; this.frame = 0; this.want = null; this.busy = false;
    this.vw = 1920; this.vh = 1080; this.view = { z: 1, cx: 960, cy: 540 };
    this.selected = null; this.playing = false; this.rate = 0.1;
    this.mode = run.calib.points.length >= 2 ? 'contacts' : 'calib';
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.res = null;
    this.build();
    this.recompute();
    this.renderPanel();
    this.layout();
    this.draw();
    this.onKey = e => this.key(e);
    window.addEventListener('keydown', this.onKey);
    this.onResize = () => { this.layout(); this.draw(); };
    window.addEventListener('resize', this.onResize);
    if (file) this.loadFile(file);
  }
  get fps() { return this.run.calib.fps || this.s.settings.captureFps || 240; }
  get athlete() { return this.s.athletes.find(a => a.id === this.run.athleteId); }

  destroy() {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    if (this.fv) this.fv.destroy();
    save(true);
  }

  // ---------- Aufbau ----------
  build() {
    const holdBtn = (label, fn, cls = '') => {
      const b = h('button', { class: 'btn ' + cls }, label);
      let t1, t2; const stop = () => { clearTimeout(t1); clearInterval(t2); };
      b.addEventListener('pointerdown', e => { e.preventDefault(); fn(); t1 = setTimeout(() => { t2 = setInterval(fn, 80); }, 350); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, stop));
      b.addEventListener('contextmenu', e => e.preventDefault());
      return b;
    };
    this.canvas = h('canvas', { class: 'cv' });
    this.ctx = this.canvas.getContext('2d');
    this.hud = h('div', { class: 'hud' }, '–');
    this.hudR = h('div', { class: 'hud r' }, '');
    this.fileInput = h('input', { type: 'file', accept: 'video/*,.mov,.mp4,.m4v', style: 'display:none', onchange: e => { const f = e.target.files[0]; if (f) this.loadFile(f); e.target.value = ''; } });
    this.empty = h('div', { class: 'empty' },
      h('div', {}, 'Kein Video geladen'),
      h('button', { class: 'btn primary', onclick: () => this.fileInput.click() }, 'Video wählen'),
      this.run.contacts.length ? h('div', { class: 'small' }, 'Die gespeicherten Marken bleiben erhalten. Video nur nötig, um sie zu ändern.') : null);
    this.stage = h('div', { class: 'stage' }, this.canvas, this.hud, this.hudR, this.empty);
    this.slider = h('input', { type: 'range', min: 0, max: 0, value: 0, step: 1, oninput: e => this.goto(+e.target.value) });
    this.playBtn = h('button', { class: 'btn', onclick: () => this.togglePlay() }, '▶︎');
    this.rateBtn = h('button', { class: 'btn', onclick: () => this.cycleRate() }, '0,1×');
    const transport = h('div', { class: 'transport' }, this.slider,
      h('div', { class: 'row' },
        holdBtn('−10', () => this.step(-10)), holdBtn('◀︎', () => this.step(-1)), this.playBtn,
        holdBtn('▶︎', () => this.step(1)), holdBtn('+10', () => this.step(10))),
      h('div', { class: 'row', style: 'margin-top:6px' },
        h('button', { class: 'btn', onclick: () => this.zoomBy(0.7) }, '🔍−'),
        h('button', { class: 'btn', onclick: () => this.zoomBy(1.5) }, '🔍+'),
        h('button', { class: 'btn', onclick: () => { this.view.z = 1; this.view.cx = this.vw / 2; this.view.cy = this.vh / 2; this.draw(); } }, 'Reset'),
        this.rateBtn));
    this.banners = h('div', {});
    this.tabs = h('div', { class: 'tabs' }, [['calib', '1 Hütchen'], ['contacts', '2 Kontakte'], ['result', '3 Ergebnis']].map(([k, l]) =>
      h('button', { 'data-m': k, class: k === this.mode ? 'on' : '', onclick: () => this.setMode(k) }, l)));
    this.panel = h('div', {});
    this.saveInd = h('span', { class: 'save' }, '');
    this.root = h('div', { class: 'analysis' },
      h('header', { class: 'bar' },
        h('button', { class: 'icon', onclick: () => go('#/s/' + this.s.id) }, '‹'),
        h('div', { class: 'title' }, `${this.athlete ? this.athlete.name : '?'} · Lauf ${this.run.n}`), this.saveInd),
      h('div', { class: 'sticky' }, this.stage, transport),
      this.banners, this.tabs, this.panel, this.fileInput);
    this.bindGestures();
    new ResizeObserver(() => { this.layout(); this.draw(); }).observe(this.stage);
  }

  setMode(m) {
    this.mode = m;
    [...this.tabs.children].forEach(b => b.classList.toggle('on', b.dataset.m === m));
    this.renderPanel(); this.draw();
  }

  layout() {
    const cssW0 = this.stage.clientWidth || 360;
    let cssH = cssW0 * this.vh / this.vw, cssW = cssW0;
    const maxH = Math.max(160, window.innerHeight * 0.42);
    if (cssH > maxH) { cssH = maxH; cssW = cssH * this.vw / this.vh; }
    this.canvas.style.width = cssW + 'px'; this.canvas.style.height = cssH + 'px';
    const w = Math.round(cssW * this.dpr), hh = Math.round(cssH * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== hh) { this.canvas.width = w; this.canvas.height = hh; }
  }

  // ---------- Video laden / Bildsteuerung ----------
  async loadFile(file) {
    if (this.fv) { this.fv.destroy(); this.fv = null; }
    this.empty.style.display = 'flex';
    this.empty.replaceChildren(h('div', {}, 'Video wird geladen …'));
    try {
      const fv = new FrameVideo();
      await fv.open(file, this.fps);
      this.fv = fv;
    } catch (e) {
      this.empty.replaceChildren(h('div', {}, '⚠️ ' + e.message), h('button', { class: 'btn primary', onclick: () => this.fileInput.click() }, 'Anderes Video wählen'));
      return;
    }
    this.empty.style.display = 'none';
    this.vw = this.fv.v.videoWidth; this.vh = this.fv.v.videoHeight;
    this.view = { z: 1, cx: this.vw / 2, cy: this.vh / 2 };
    const cal = this.run.calib;
    if (cal.imgW && cal.imgW !== this.vw && cal.points.length) {
      cal.points = [];
      toast('Andere Videoauflösung als bei der Kalibrierung – Hütchen bitte neu antippen.');
    }
    cal.imgW = this.vw; cal.imgH = this.vh;
    this.run.fileName = file.name;
    this.slider.max = this.fv.n - 1;
    this.layout();
    this.showVideoNotes();
    await this.goto(0, true);
    this.changed();
    this.renderPanel();
  }

  showVideoNotes() {
    const fv = this.fv, nodes = [];
    const ratio = fv.fileFps / this.fps;
    nodes.push(h('div', { class: 'banner info' },
      `Video: ${fv.v.videoWidth}×${fv.v.videoHeight}, ${fv.n} Bilder, Zeitbasis der Datei ${fmt(fv.fileFps, 1)} B/s. Die Zeiten werden aus der Bildzahl und ${this.fps} B/s Aufnahmerate berechnet (ein Bild = ${fmt(1000 / this.fps, 2)} ms).`));
    if (Math.abs(ratio - 1) > 0.05)
      nodes.push(h('div', { class: 'banner' }, `Die Datei läuft mit ${fmt(fv.fileFps, 0)} B/s, die Aufnahmerate ist mit ${this.fps} B/s eingestellt. Das passt zu einer als Zeitlupe gespeicherten 240-fps-Aufnahme. War es keine 240-fps-Aufnahme, sind alle Zeiten falsch – Aufnahmerate dann unter „Hütchen“ ändern.`));
    fv.notes.forEach(n => nodes.push(h('div', { class: 'banner' }, n)));
    this.banners.replaceChildren(...nodes);
  }

  async goto(f, force = false) {
    if (!this.fv) return;
    this.want = clamp(Math.round(f), 0, this.fv.n - 1);
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.want !== null) {
        const w = this.want; this.want = null;
        if (!force && w === this.frame) continue;
        this.frame = await this.fv.seek(w);
        this.afterFrame();
        force = false;
      }
    } finally { this.busy = false; }
  }
  step(d) {
    if (!this.fv) return;
    if (this.playing) this.togglePlay();
    const base = this.want !== null ? this.want : this.frame;
    this.goto(base + d);
  }
  afterFrame() {
    this.slider.value = this.frame;
    this.draw();
  }
  cycleRate() {
    const rates = [0.05, 0.1, 0.25];
    this.rate = rates[(rates.indexOf(this.rate) + 1) % rates.length];
    this.rateBtn.textContent = String(this.rate).replace('.', ',') + '×';
    if (this.playing) this.fv.v.playbackRate = this.rate;
  }
  async togglePlay() {
    if (!this.fv) return;
    if (this.playing) {
      this.playing = false; this.fv.pause(); this.playBtn.textContent = '▶︎';
      await sleep(30); this.goto(this.fv.cur, true); return;
    }
    this.playing = true; this.playBtn.textContent = '⏸';
    try {
      await this.fv.play(this.rate, f => { this.frame = f; this.afterFrame(); });
    } catch { this.playing = false; this.playBtn.textContent = '▶︎'; }
  }
  key(e) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName) && document.activeElement.type !== 'range') return;
    const d = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowRight') { this.step(d); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { this.step(-d); e.preventDefault(); }
    else if (e.key === ' ') { this.togglePlay(); e.preventDefault(); }
  }

  // ---------- Zoom / Gesten ----------
  rect() {
    const { vw, vh } = this, z = this.view.z, w = vw / z, hh = vh / z;
    const x = clamp(this.view.cx - w / 2, 0, vw - w), y = clamp(this.view.cy - hh / 2, 0, vh - hh);
    this.view.cx = x + w / 2; this.view.cy = y + hh / 2;
    return { x, y, w, h: hh };
  }
  zoomBy(f) {
    this.view.z = clamp(this.view.z * f, 1, 16);
    this.draw();
  }
  bindGestures() {
    const c = this.canvas, P = new Map();
    let g = null;
    const rel = (cx, cy) => { const b = c.getBoundingClientRect(); return [(cx - b.left) / b.width, (cy - b.top) / b.height]; };
    const setAnchor = (anchor, rx, ry, z) => {
      const w = this.vw / z, hh = this.vh / z;
      this.view.z = z; this.view.cx = anchor.x - rx * w + w / 2; this.view.cy = anchor.y - ry * hh + hh / 2;
    };
    const pointAt = (rx, ry) => { const r = this.rect(); return { x: r.x + rx * r.w, y: r.y + ry * r.h }; };
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      P.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (P.size === 1) {
        const [rx, ry] = rel(e.clientX, e.clientY);
        g = { x0: e.clientX, y0: e.clientY, moved: false, multi: false, anchor: pointAt(rx, ry) };
      } else if (g) {
        g.multi = true;
        const [a, b] = [...P.values()];
        g.d0 = Math.hypot(a.x - b.x, a.y - b.y) || 1; g.z0 = this.view.z;
        const [rx, ry] = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
        g.anchor2 = pointAt(rx, ry);
      }
    });
    c.addEventListener('pointermove', e => {
      if (!g || !P.has(e.pointerId)) return;
      P.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (P.size >= 2 && g.anchor2) {
        const [a, b] = [...P.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const [rx, ry] = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
        setAnchor(g.anchor2, rx, ry, clamp(g.z0 * d / g.d0, 1, 16));
        this.draw();
      } else if (P.size === 1 && !g.multi) {
        if (!g.moved && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > 8) g.moved = true;
        if (g.moved && this.view.z > 1) {
          const [rx, ry] = rel(e.clientX, e.clientY);
          setAnchor(g.anchor, rx, ry, this.view.z);
          this.draw();
        }
      }
    });
    const up = e => {
      if (!P.has(e.pointerId)) return;
      P.delete(e.pointerId);
      if (P.size === 0 && g) {
        if (!g.moved && !g.multi && e.type === 'pointerup') {
          const [rx, ry] = rel(e.clientX, e.clientY);
          const p = pointAt(rx, ry);
          this.tap(p.x, p.y);
        }
        g = null;
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => { e.preventDefault(); const [rx, ry] = rel(e.clientX, e.clientY); const a = pointAt(rx, ry); setAnchor(a, rx, ry, clamp(this.view.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 1, 16)); this.draw(); }, { passive: false });
  }

  // ---------- Antippen ----------
  tap(x, y) {
    if (!this.fv) { toast('Erst ein Video wählen.'); return; }
    if (this.mode === 'calib') this.tapCone(x, y);
    else if (this.mode === 'contacts') this.tapContact(x, y);
    else toast('Zum Markieren oben „Kontakte“ wählen.');
  }
  tapCone(x, y) {
    const cal = this.run.calib;
    const r = this.rect(), rad = 18 * this.dpr * (r.w / this.canvas.width);   // Trefferradius ≈ 18 px am Bildschirm
    const hit = cal.points.findIndex(p => Math.hypot(p.x - x, p.y - y) < rad);
    if (hit >= 0) cal.points.splice(hit, 1);
    else cal.points.push({ x, y });
    this.calibChanged();
  }
  tapContact(x, y) {
    const f = this.frame, cs = this.run.contacts;
    let c = cs.find(k => k.f === f);
    if (c) { c.x = x; c.y = y; }
    else {
      const prev = [...cs].filter(k => k.f < f).sort((p, q) => q.f - p.f)[0];
      const foot = prev ? (prev.foot === 'L' ? 'R' : 'L') : (this.firstFoot || 'L');
      c = { foot, f, l: null, x, y };
      cs.push(c); cs.sort((p, q) => p.f - q.f);
    }
    this.selected = c;
    this.changed(); this.renderPanel(); this.draw();
  }

  // ---------- Änderungen ----------
  calibChanged() {
    const cal = this.run.calib, s = this.s;
    s.lastCalib = { points: cal.points.map(p => ({ ...p })), imgW: cal.imgW, imgH: cal.imgH };
    Object.assign(s.settings, { camDist: cal.camDist, laneOffset: cal.laneOffset, coneSpacing: cal.spacing, firstConeM: cal.firstConeM, direction: cal.direction, captureFps: cal.fps });
    this.changed(); this.renderPanel(); this.draw();
  }
  changed() {
    this.recompute();
    this.saveInd.textContent = 'gespeichert';
    save();
  }
  recompute() { this.res = runResult(this.run, this.s); }

  // ---------- Zeichnen ----------
  draw() {
    const c = this.canvas, ctx = this.ctx, W = c.width, H = c.height, dpr = this.dpr;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (!this.fv) {
      this.hud.textContent = this.run.contacts.length ? 'Nur Ergebnisse (kein Video)' : '–'; this.hudR.textContent = '';
      return;
    }
    const r = this.rect();
    try { ctx.drawImage(this.fv.v, r.x, r.y, r.w, r.h, 0, 0, W, H); } catch { /* Frame noch nicht bereit */ }
    const sx = W / r.w, sy = H / r.h;
    const T = (x, y) => [(x - r.x) * sx, (y - r.y) * sy];
    const cal = this.run.calib, ci = calibrationOf(cal);
    ctx.lineWidth = 1.5 * dpr; ctx.font = `${11 * dpr}px -apple-system, sans-serif`;

    // Hütchen
    if (cal.points.length) {
      const sorted = [...cal.points].sort((p, q) => p.x - q.x);
      if (cal.direction === 'rtl') sorted.reverse();
      sorted.forEach((p, k) => {
        const [px, py] = T(p.x, p.y);
        ctx.strokeStyle = '#ffd34d'; ctx.beginPath(); ctx.arc(px, py, 7 * dpr, 0, 7); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px - 11 * dpr, py); ctx.lineTo(px + 11 * dpr, py); ctx.moveTo(px, py - 11 * dpr); ctx.lineTo(px, py + 11 * dpr); ctx.stroke();
        if (this.mode === 'calib') { ctx.fillStyle = '#ffd34d'; ctx.fillText(fmt(cal.firstConeM + k * cal.spacing, 0) + ' m', px + 9 * dpr, py - 9 * dpr); }
      });
      // Maßstab in der Läuferebene (nur im Kalibrier-Modus)
      if (ci && this.mode === 'calib') {
        const ys = cal.points.map(p => p.y).sort((p, q) => p - q), my = ys[Math.floor(ys.length / 2)];
        const a = ci.mapper.toM(r.x), b = ci.mapper.toM(r.x + r.w);
        const lo = Math.ceil(Math.min(a, b)), hi = Math.floor(Math.max(a, b));
        ctx.strokeStyle = 'rgba(80,220,255,.9)'; ctx.fillStyle = 'rgba(80,220,255,.95)';
        for (let X = lo; X <= hi && X - lo < 80; X++) {
          const [px, py] = T(ci.mapper.toPxAthlete(X), my);
          ctx.beginPath(); ctx.moveTo(px, py - 8 * dpr); ctx.lineTo(px, py + 8 * dpr); ctx.stroke();
          if (this.view.z >= 2 || X % 5 === 0) ctx.fillText(String(X), px + 2 * dpr, py + 20 * dpr);
        }
      }
    }
    // Kontakte
    this.run.contacts.forEach((k, i) => {
      const [px, py] = T(k.x, k.y);
      const col = k.foot === 'L' ? '#3ea6ff' : '#ffb020';
      const active = this.frame >= k.f && this.frame <= (k.l == null ? k.f : k.l);
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.globalAlpha = active ? 1 : 0.55;
      ctx.beginPath(); ctx.arc(px, py, (active ? 6 : 3.5) * dpr, 0, 7);
      if (active) ctx.fill(); else ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px - 10 * dpr, py); ctx.lineTo(px + 10 * dpr, py); ctx.moveTo(px, py - 10 * dpr); ctx.lineTo(px, py + 10 * dpr); ctx.stroke();
      ctx.fillText(String(i + 1), px + 8 * dpr, py - 8 * dpr);
      ctx.globalAlpha = 1;
      if (k === this.selected) { ctx.strokeStyle = '#fff'; ctx.setLineDash([4 * dpr, 3 * dpr]); ctx.beginPath(); ctx.arc(px, py, 12 * dpr, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
    });
    this.hud.textContent = `Bild ${this.frame + 1}/${this.fv.n} · ${fmt(this.frame / this.fps, 3)} s`;
    this.hudR.textContent = this.view.z > 1 ? `×${this.view.z.toFixed(1).replace('.', ',')}` : '';
  }

  // ---------- Panels ----------
  renderPanel() {
    if (this.mode === 'calib') this.panel.replaceChildren(this.panelCalib());
    else if (this.mode === 'contacts') this.panel.replaceChildren(this.panelContacts());
    else this.panel.replaceChildren(this.panelResult());
  }

  panelCalib() {
    const cal = this.run.calib, ci = calibrationOf(cal), self = this;
    const bind = (key, parse = num) => e => { const v = parse(e.target.value); if (v != null && v > 0 || (key === 'firstConeM' && v != null)) { cal[key] = v; self.calibChanged(); } else self.renderPanel(); };
    const status = ci
      ? h('div', { class: 'help' },
        h('b', {}, `${ci.fit.n} Hütchen`), ` · Maßstab Hütchenlinie ${fmt(Math.abs(ci.mapper.sLine), 0)} px/m · Läuferebene ${fmt(Math.abs(ci.mapper.sAth), 0)} px/m · `,
        ci.fit.checked
          ? h('span', { class: ci.fit.maxM > 0.05 ? 'chip bad' : ci.fit.maxM > 0.03 ? 'chip warn' : 'chip ok' }, `größte Abweichung ${fmt(ci.fit.maxM * 100, 1)} cm`)
          : h('span', { class: 'chip warn' }, 'mit 2 Hütchen nicht prüfbar – besser ≥ 3'))
      : h('div', { class: 'help' }, 'Mindestens 2 Hütchen antippen (besser 4 oder mehr, auch weit auseinander).');
    return h('div', {},
      h('div', { class: 'card' },
        h('h3', {}, 'Hütchen antippen'),
        h('div', { class: 'help' }, 'Auf den ', h('b', {}, 'Boden-Fußpunkt'), ' jedes Hütchens der kameraseitigen Bahnlinie tippen (am besten stark vergrößern). Nochmal auf ein Hütchen tippen entfernt es. Die Reihenfolge ist egal.'),
        status,
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn sm', onclick: () => { cal.points.pop(); self.calibChanged(); } }, 'Letztes entfernen'),
          h('button', { class: 'btn sm danger', onclick: () => { cal.points = []; self.calibChanged(); } }, 'Alle löschen'))),
      h('div', { class: 'card' },
        h('h3', {}, 'Aufbau'),
        h('div', { class: 'grid2' },
          field('Kamera → Bahnlinie (m)', numInput(cal.camDist, { onchange: bind('camDist') }), 'Abstand zur kameraseitigen Linie der Läuferbahn'),
          field('Linie → Läufer (m)', numInput(cal.laneOffset, { onchange: bind('laneOffset') }), '0,61 = Mitte einer 1,22-m-Bahn'),
          field('Abstand der angetippten Hütchen (m)', numInput(cal.spacing, { onchange: bind('spacing') })),
          field('Position erstes Hütchen (m)', numInput(cal.firstConeM, { onchange: bind('firstConeM') }), 'z. B. 0 = Start, 10 = bei 10 m'),
          field('Laufrichtung im Bild', h('select', { onchange: e => { cal.direction = e.target.value; self.calibChanged(); } },
            h('option', { value: 'ltr', selected: cal.direction === 'ltr' }, '→ links nach rechts'),
            h('option', { value: 'rtl', selected: cal.direction === 'rtl' }, '← rechts nach links'))),
          field('Aufnahmerate (Bilder/s)', numInput(cal.fps, { onchange: bind('fps') })))));
  }

  panelContacts() {
    const self = this, cs = this.run.contacts, sel = this.selected;
    const r = this.res, byRef = new Map(); r.contacts.forEach(k => byRef.set(`${k.f}`, k));
    const needCal = !r.calibrated;
    const rows = cs.map((k, i) => {
      const calc = byRef.get(`${k.f}`);
      return h('div', { class: 'contact' + (k === sel ? ' sel' : ''), onclick: () => { self.selected = k; self.renderPanel(); if (self.playing) self.togglePlay(); self.goto(k.f); } },
        h('span', { class: 'no' }, i + 1), h('span', { class: 'dot ' + k.foot }),
        h('span', {}, `Bild ${k.f + 1}${k.l != null ? ' – ' + (k.l + 1) : ' – ?'}`),
        k.l == null ? h('span', { class: 'chip warn' }, 'Ende fehlt') : h('span', { class: 'chip' }, h('b', {}, calc ? Math.round(calc.gct) : '–'), ' ms'));
    });
    const act = (label, fn, cls = '') => h('button', { class: 'btn sm ' + cls, disabled: !sel, onclick: fn }, label);
    return h('div', {},
      needCal ? h('div', { class: 'banner' }, 'Noch nicht kalibriert – Zeiten funktionieren, aber Schrittlänge und Geschwindigkeit brauchen die Hütchen (Reiter 1).') : null,
      h('div', { class: 'card' },
        h('h3', {}, 'Bodenkontakte markieren'),
        h('div', { class: 'help' },
          h('b', {}, '1.'), ' Zum ', h('b', {}, 'ersten Bild mit Bodenkontakt'), ' springen und den Fußpunkt (Ballen/Spikespitze am Boden) antippen.', h('br', {}),
          h('b', {}, '2.'), ' Zum ', h('b', {}, 'letzten Bild mit Bodenkontakt'), ' springen und „Ende = aktuelles Bild“ drücken.', h('br', {}),
          h('b', {}, '3.'), ' Weiter zum nächsten Kontakt. Der Fuß wechselt automatisch.'),
        h('div', { class: 'row wrap' },
          act('Ende = aktuelles Bild', () => {
            if (this.frame < sel.f) { toast('Ende muss nach dem Start liegen.'); return; }
            sel.l = this.frame; this.changed(); this.renderPanel(); this.draw();
          }, 'primary'),
          act('Start = aktuelles Bild', () => {
            if (sel.l != null && this.frame > sel.l) { toast('Start muss vor dem Ende liegen.'); return; }
            if (cs.some(k => k !== sel && k.f === this.frame)) { toast('Hier gibt es schon einen Kontakt.'); return; }
            sel.f = this.frame; cs.sort((p, q) => p.f - q.f); this.changed(); this.renderPanel(); this.draw();
          }),
          act('Fuß L↔R', () => { sel.foot = sel.foot === 'L' ? 'R' : 'L'; this.changed(); this.renderPanel(); this.draw(); }),
          act('Löschen', () => { cs.splice(cs.indexOf(sel), 1); this.selected = null; this.changed(); this.renderPanel(); this.draw(); }, 'danger'))),
      cs.length ? h('div', { class: 'card' }, h('div', { class: 'help' }, 'Kontakte (antippen = hinspringen)'), rows)
        : h('div', { class: 'empty-note' }, 'Noch keine Kontakte markiert.'),
      cs.length ? h('div', { class: 'pad row' },
        h('button', { class: 'btn grow', onclick: () => this.setMode('result') }, 'Ergebnis ansehen')) : null);
  }

  panelResult() {
    const r = this.res, sp = r.speed, s = r.summary, self = this;
    const kpi = (label, val, unit, extra) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, label), h('div', {}, h('span', { class: 'v' }, val), h('span', { class: 'u' }, unit)), extra || null);
    const speedBox = sp && sp.v != null
      ? kpi('Geschwindigkeit (6–8 m)', fmt(sp.v, 2), 'm/s',
        h('div', { class: 'small ' + (sp.ok ? '' : 'muted') }, `± ${fmt(sp.dv, 2)} m/s · ${fmt(sp.span, 1)} m (${fmt(sp.X0, 1)}–${fmt(sp.X1, 1)} m) in ${fmt(sp.dt * 1000, 0)} ms`,
          h('br', {}), sp.ok ? h('span', { class: 'chip ok' }, '✓ belastbar') : h('span', { class: 'chip warn' }, '⚠ ' + sp.reason)))
      : kpi('Geschwindigkeit (6–8 m)', '–', '', h('div', { class: 'small muted' }, sp ? sp.reason : ''));
    return h('div', {},
      r.warnings.length ? h('div', { class: 'banner' }, r.warnings.map(w => h('div', {}, '• ' + w))) : null,
      h('div', { class: 'card' },
        h('div', { class: 'kpis' },
          speedBox,
          kpi('Ø Bodenkontakt', s.gct == null ? '–' : fmt(s.gct, 0), 'ms', s.gctL != null && s.gctR != null ? h('div', { class: 'small muted' }, `L ${fmt(s.gctL, 0)} · R ${fmt(s.gctR, 0)} ms`) : null),
          kpi('Ø Flugzeit', s.ft == null ? '–' : fmt(s.ft, 0), 'ms'),
          kpi('Ø Schrittlänge', s.stepLen == null ? '–' : fmt(s.stepLen, 2), 'm'),
          kpi('Ø Schrittfrequenz', s.freq == null ? '–' : fmt(s.freq, 2), 'Hz'),
          r.section ? kpi(`v ${fmt(r.section.A, 0)}–${fmt(r.section.B, 0)} m`, fmt(r.section.v, 2), 'm/s') : null)),
      h('div', { class: 'card' },
        h('table', { class: 't' },
          h('thead', {}, h('tr', {}, ['#', 'Kontakt ms', 'Flug ms', 'Schritt m', 'Hz'].map(t => h('th', {}, t)))),
          h('tbody', {}, r.contacts.map(k => h('tr', {},
            h('td', {}, h('span', { class: 'dot ' + k.foot, style: 'width:10px;height:10px;margin-right:6px' }), k.i + 1),
            h('td', {}, fmt(k.gct, 0)), h('td', {}, fmt(k.ft, 0)), h('td', {}, fmt(k.stepLen, 2)), h('td', {}, fmt(k.freq, 2))))))),
      h('div', { class: 'card' },
        field('Notiz zum Lauf', h('textarea', { onchange: e => { self.run.note = e.target.value; self.changed(); } }, this.run.note || ''))),
      h('div', { class: 'pad row' },
        h('button', { class: 'btn danger', onclick: () => { if (confirm('Diesen Lauf löschen?')) { self.s.runs = self.s.runs.filter(x => x !== self.run); save(true); go('#/s/' + self.s.id); } } }, 'Lauf löschen'),
        h('button', { class: 'btn primary grow', onclick: () => go('#/s/' + self.s.id) }, 'Fertig')));
  }
}

// ───────────────────────── Ansichten ─────────────────────────
const app = document.getElementById('app');
let current = null;                // aktive Analysis
const pendingFiles = new Map();    // runId → File
const ui = { tab: 'runs' };

function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function route() {
  if (current) { current.destroy(); current = null; }
  const m = location.hash.match(/^#\/(s|r)\/([^/]+)(?:\/([^/]+))?/);
  if (!m) return viewHome();
  if (m[1] === 's') return viewSession(m[2]);
  const s = getSession(m[2]); const run = s && s.runs.find(r => r.id === m[3]);
  if (!run) return viewHome();
  const file = pendingFiles.get(run.id); pendingFiles.delete(run.id);
  current = new Analysis(s, run, file);
  app.replaceChildren(current.root);
  window.scrollTo(0, 0);
}

function viewHome() {
  const importInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || !Array.isArray(data.sessions)) throw new Error('Keine SprintLab-Sicherung.');
      let added = 0;
      for (const s of data.sessions) { const i = db.sessions.findIndex(x => x.id === s.id); if (i >= 0) db.sessions[i] = s; else db.sessions.push(s); added++; }
      save(true); toast(`${added} Session(s) geladen.`); viewHome();
    } catch (err) { toast('Laden fehlgeschlagen: ' + err.message); }
  } });
  const list = [...db.sessions].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  app.replaceChildren(
    h('header', { class: 'bar' }, h('div', { class: 'title' }, 'SprintLab'), h('span', { class: 'muted small' }, 'v' + VERSION)),
    h('div', { class: 'pad' }, h('button', { class: 'btn primary', style: 'width:100%', onclick: newSessionDialog }, '＋ Neue Session')),
    list.length ? h('div', { class: 'list' }, list.map(s => h('button', { class: 'item', onclick: () => go('#/s/' + s.id) },
      h('div', { class: 'main' }, h('div', { class: 't' }, s.name), h('div', { class: 'small muted' }, `${deDate(s.date)} · ${s.athletes.length} Athleten · ${s.runs.length} Läufe`)),
      h('span', { class: 'chev' }, '›'))))
      : h('div', { class: 'empty-note' }, 'Noch keine Session. Lege eine an, füge Athleten hinzu und lade pro Lauf ein 240-fps-Video.'),
    h('div', { class: 'section-h' }, 'Daten'),
    h('div', { class: 'card' },
      h('div', { class: 'help' }, 'Alle Daten liegen nur auf diesem Gerät (Safari/Home-Bildschirm-App). Sichere sie ab und zu – Videos werden nicht gespeichert, nur Marken und Ergebnisse.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn sm', onclick: () => shareFile(`sprintlab-backup-${today()}.json`, JSON.stringify(db), 'application/json') }, 'Backup sichern'),
        h('button', { class: 'btn sm', onclick: () => importInput.click() }, 'Backup laden'))),
    importInput);
}

function newSessionDialog() {
  const d = new Date();
  const name = h('input', { class: 'inp', value: `Training ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.` });
  const date = h('input', { class: 'inp', type: 'date', value: today() });
  modal('Neue Session', h('div', {}, field('Name', name), field('Datum', date)), [
    { label: 'Abbrechen' },
    { label: 'Anlegen', cls: 'primary', fn: () => {
      const s = { id: uid(), name: name.value.trim() || 'Session', date: date.value || today(), settings: defaultSettings(), athletes: [], runs: [], lastCalib: null };
      db.sessions.push(s); save(true); go('#/s/' + s.id);
    } }]);
}

function viewSession(id) {
  const s = getSession(id);
  if (!s) return viewHome();
  const runLine = ({ run, res }) => {
    const sp = res.speed, sm = res.summary;
    return h('button', { class: 'item', onclick: () => go(`#/r/${s.id}/${run.id}`) },
      h('div', { class: 'main' },
        h('div', { class: 't' }, `Lauf ${run.n}`, run.note ? h('span', { class: 'muted small' }, ' · ' + run.note.slice(0, 30)) : null),
        h('div', { class: 'chips' },
          sp && sp.v != null ? h('span', { class: 'chip ' + (sp.ok ? 'ok' : 'warn') }, h('b', {}, fmt(sp.v, 2)), ' m/s' + (sp.ok ? '' : ' ⚠')) : null,
          sm.gct != null ? h('span', { class: 'chip' }, 'Kontakt ', h('b', {}, fmt(sm.gct, 0)), ' ms') : null,
          sm.ft != null ? h('span', { class: 'chip' }, 'Flug ', h('b', {}, fmt(sm.ft, 0)), ' ms') : null,
          sm.stepLen != null ? h('span', { class: 'chip' }, h('b', {}, fmt(sm.stepLen, 2)), ' m') : null,
          !sm.nContacts ? h('span', { class: 'chip warn' }, 'noch nicht ausgewertet') : null)),
      h('span', { class: 'chev' }, '›'));
  };
  const content = ui.tab === 'overview' ? overviewNode(s) : runsNode(s, runLine);
  app.replaceChildren(
    h('header', { class: 'bar' },
      h('button', { class: 'icon', onclick: () => go('#/') }, '‹'),
      h('div', { class: 'title' }, s.name),
      h('button', { class: 'icon', onclick: () => settingsDialog(s) }, '⚙︎')),
    h('div', { class: 'small muted', style: 'margin:-4px 14px 6px' }, deDate(s.date)),
    h('div', { class: 'tabs' }, [['runs', 'Läufe'], ['overview', 'Übersicht']].map(([k, l]) =>
      h('button', { class: ui.tab === k ? 'on' : '', onclick: () => { ui.tab = k; viewSession(id); } }, l))),
    content);
}

function runsNode(s, runLine) {
  const nameIn = h('input', { class: 'inp grow', placeholder: 'Athlet hinzufügen …', enterkeyhint: 'done',
    onkeydown: e => { if (e.key === 'Enter') add(); } });
  const add = () => {
    const n = nameIn.value.trim(); if (!n) return;
    s.athletes.push({ id: uid(), name: n }); save(true); viewSession(s.id);
  };
  const sums = summarizeSession(s);
  const wrap = h('div', {});
  wrap.append(
    h('div', { class: 'card' },
      h('div', { class: 'row' }, nameIn, h('button', { class: 'btn', onclick: add }, '＋')),
      s.athletes.length ? h('div', { class: 'chips', style: 'margin-top:8px' }, s.athletes.map(a => h('span', { class: 'chip' }, a.name,
        s.runs.some(r => r.athleteId === a.id) ? null : h('span', { style: 'margin-left:8px;cursor:pointer', onclick: () => { s.athletes = s.athletes.filter(x => x !== a); save(true); viewSession(s.id); } }, '✕')))) : null),
    h('div', { class: 'pad' }, h('button', { class: 'btn primary', style: 'width:100%', disabled: !s.athletes.length, onclick: () => newRunDialog(s) }, '＋ Neuer Lauf (Video wählen)')));
  if (!s.athletes.length) wrap.append(h('div', { class: 'empty-note' }, 'Füge zuerst die Athleten hinzu.'));
  for (const a of sums) {
    if (!a.runs.length) continue;
    wrap.append(h('div', { class: 'section-h' }, a.athlete.name), h('div', { class: 'list' }, a.runs.map(runLine)));
  }
  return wrap;
}

function newRunDialog(s) {
  const sel = h('select', { class: 'inp' }, s.athletes.map(a => h('option', { value: a.id }, a.name)));
  const last = s.runs.length ? s.runs[s.runs.length - 1].athleteId : null; if (last) sel.value = last;
  const file = h('input', { type: 'file', accept: 'video/*,.mov,.mp4,.m4v', style: 'display:none', onchange: e => {
    const f = e.target.files[0]; if (!f) return;
    const athleteId = sel.value;
    const n = Math.max(0, ...s.runs.filter(r => r.athleteId === athleteId).map(r => r.n || 0)) + 1;
    const run = { id: uid(), athleteId, n, createdAt: new Date().toISOString(), fileName: f.name, calib: newCalib(s), contacts: [], note: '' };
    s.runs.push(run); save(true); pendingFiles.set(run.id, f);
    document.querySelector('.overlay')?.remove();
    go(`#/r/${s.id}/${run.id}`);
  } });
  modal('Neuer Lauf', h('div', {}, field('Athlet', sel),
    h('div', { class: 'help' }, 'Tipp: Für Originalqualität das 240-fps-Video zuerst in der Dateien-App ablegen und dort „Durchsuchen“ wählen. Aus der Fotomediathek kann iOS das Video umrechnen.'),
    h('button', { class: 'btn primary', style: 'width:100%', onclick: () => file.click() }, 'Video wählen …'), file), [{ label: 'Abbrechen' }]);
}

function overviewNode(s) {
  const sums = summarizeSession(s).filter(a => a.runs.length);
  const wrap = h('div', {});
  const nRuns = s.runs.length;
  if (!nRuns) return h('div', { class: 'empty-note' }, 'Noch keine Läufe in dieser Session.');
  const ranked = sums.filter(a => a.bestV != null).sort((p, q) => q.bestV - p.bestV);
  const vmax = ranked.length ? ranked[0].bestV : 1;
  wrap.append(h('div', { class: 'card' },
    h('h3', {}, 'Session-Übersicht'),
    h('div', { class: 'small muted' }, `${deDate(s.date)} · ${sums.length} Athleten · ${nRuns} Läufe`),
    ranked.length ? h('div', { style: 'margin-top:10px' }, h('div', { class: 'help' }, 'Schnellster Lauf je Athlet (6–8 m Abschnitt)'),
      ranked.map(a => h('div', { class: 'bar-row' }, h('div', { class: 'name' }, a.athlete.name),
        h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${(a.bestV / vmax * 100).toFixed(0)}%` })),
        h('div', { class: 'val' }, fmt(a.bestV, 2) + ' m/s')))) : h('div', { class: 'help' }, 'Noch keine Geschwindigkeiten (Hütchen kalibrieren und ≥ 6 m markieren).')));
  for (const a of sums) {
    wrap.append(h('div', { class: 'card' },
      h('h3', {}, a.athlete.name),
      h('table', { class: 't' },
        h('thead', {}, h('tr', {}, ['Lauf', 'v m/s', 'Kontakt ms', 'Flug ms', 'Schritt m', 'Hz'].map(t => h('th', {}, t)))),
        h('tbody', {},
          a.runs.map(({ run, res }) => h('tr', {},
            h('td', {}, run.n),
            h('td', {}, res.speed && res.speed.v != null ? fmt(res.speed.v, 2) + (res.speed.ok ? '' : ' ⚠') : '–'),
            h('td', {}, fmt(res.summary.gct, 0)), h('td', {}, fmt(res.summary.ft, 0)), h('td', {}, fmt(res.summary.stepLen, 2)), h('td', {}, fmt(res.summary.freq, 2)))),
          a.runs.length > 1 ? h('tr', { class: 'sum' }, h('td', {}, 'Ø'), h('td', {}, a.bestV != null ? 'max ' + fmt(a.bestV, 2) : '–'),
            h('td', {}, fmt(a.meanGct, 0)), h('td', {}, fmt(a.meanFt, 0)), h('td', {}, fmt(a.meanLen, 2)), h('td', {}, fmt(a.meanFreq, 2))) : null)),
      h('div', { class: 'small muted', style: 'margin-top:6px' }, '⚠ = Geschwindigkeit unsicher (Kalibrierung/zu wenige Schritte). Ø Kontakt/Flug/Schritt über alle Läufe.')));
  }
  wrap.append(h('div', { class: 'card' },
    h('h3', {}, 'Export'),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn sm', onclick: () => shareFile(`${s.name}-laeufe.csv`.replace(/[^\w.-]+/g, '_'), buildCsv(s).summary, 'text/csv') }, 'CSV Läufe'),
      h('button', { class: 'btn sm', onclick: () => shareFile(`${s.name}-kontakte.csv`.replace(/[^\w.-]+/g, '_'), buildCsv(s).contacts, 'text/csv') }, 'CSV alle Kontakte'),
      h('button', { class: 'btn sm', onclick: () => window.print() }, 'Drucken / PDF'))));
  return wrap;
}

function settingsDialog(s) {
  const st = s.settings;
  const name = h('input', { class: 'inp', value: s.name });
  const date = h('input', { class: 'inp', type: 'date', value: s.date });
  const f = {
    camDist: numInput(st.camDist), laneOffset: numInput(st.laneOffset), captureFps: numInput(st.captureFps),
    coneSpacing: numInput(st.coneSpacing), firstConeM: numInput(st.firstConeM),
    sectionA: numInput(st.sectionA), sectionB: numInput(st.sectionB),
  };
  const dir = h('select', { class: 'inp' }, h('option', { value: 'ltr', selected: st.direction === 'ltr' }, 'links → rechts'), h('option', { value: 'rtl', selected: st.direction === 'rtl' }, 'rechts → links'));
  modal('Session-Einstellungen', h('div', {},
    field('Name', name), field('Datum', date),
    h('div', { class: 'help' }, 'Standardwerte für neue Läufe. Pro Lauf lassen sie sich im Reiter „Hütchen“ ändern.'),
    h('div', { class: 'grid2' },
      field('Kamera → Bahnlinie (m)', f.camDist), field('Linie → Läufer (m)', f.laneOffset),
      field('Aufnahmerate (B/s)', f.captureFps), field('Hütchenabstand (m)', f.coneSpacing),
      field('1. Hütchen bei (m)', f.firstConeM), field('Laufrichtung', dir),
      field('Messabschnitt von (m)', f.sectionA, 'optional'), field('Messabschnitt bis (m)', f.sectionB, 'optional'))), [
    { label: 'Session löschen', cls: 'danger', fn: () => { if (!confirm('Session mit allen Läufen löschen?')) return false; db.sessions = db.sessions.filter(x => x !== s); save(true); go('#/'); } },
    { label: 'Speichern', cls: 'primary', fn: () => {
      s.name = name.value.trim() || s.name; s.date = date.value || s.date;
      for (const k of ['camDist', 'laneOffset', 'captureFps', 'coneSpacing']) { const v = num(f[k].value); if (v != null && v > 0) st[k] = v; }
      const fc = num(f.firstConeM.value); if (fc != null) st.firstConeM = fc;
      st.direction = dir.value;
      const a = num(f.sectionA.value), b = num(f.sectionB.value);
      st.sectionA = a != null && b != null && b > a ? a : null; st.sectionB = a != null && b != null && b > a ? b : null;
      save(true); viewSession(s.id);
    } }]);
}

window.sprintlab = { get analysis() { return current; }, db };   // Hook für automatisierte Tests
window.addEventListener('hashchange', route);
route();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => { });
