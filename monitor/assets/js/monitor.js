// UI logic for the MPico Extended monitor. Constants N_ZONES / N_ELECTRODES come from
// transport.js (same script scope); short aliases keep the loops readable.
const N_Z = N_ZONES;         // 34 zones
const N_E = N_ELECTRODES;    // 36 electrodes
const SENSORS = 3;           // 3 x MPR121
const PER_SENSOR = N_E / SENSORS;   // 12 electrodes each
const UNMAPPED = 255;        // map[e] === 255: electrode not connected

const SVG_NS = 'http://www.w3.org/2000/svg';
const CX = 210;
const CY = 210;

// localStorage can throw (blocked cookies, private mode): a guard here keeps
// the whole tool alive at the cost of non-persistent preferences/profiles.
function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

// One-shot migration of the storage keys renamed along with the project
// (maipico-* -> mpico-*), so saved profiles and preferences survive the rename.
// Runs before any key is read; old entries are dropped, so later loads are free.
function migrateStorageKeys() {
  const renamed = [
    ['maipico-sidebar-collapsed', 'mpico-sidebar-collapsed'],
    ['maipico-profiles', 'mpico-profiles'],
    ['maipico-calib-sound', 'mpico-calib-sound'],
  ];
  for (const [oldKey, newKey] of renamed) {
    const value = storageGet(oldKey);
    if (value === null || storageGet(newKey) !== null) continue;
    if (storageSet(newKey, value)) {
      // A failing removeItem only leaves a stale duplicate behind: the copy is
      // already safe, and storage being blocked is handled by the guards above.
      try { localStorage.removeItem(oldKey); } catch { /* storage unavailable */ }
    }
  }
}
migrateStorageKeys();

// Restore the sidebar collapsed state before first paint, so a collapsed rail
// does not flash to full width on load. This script runs at end of body, so the
// class lands before the browser paints.
const SIDEBAR_COLLAPSED_KEY = 'mpico-sidebar-collapsed';
if (storageGet(SIDEBAR_COLLAPSED_KEY) === '1') {
  document.body.classList.add('sidebar-collapsed');
}

// Card bars auto-scale to the deltas actually seen. Real-world deltas (through
// wires, ITO and glass) are far smaller than direct-on-sensor tests, so a fixed
// 1023 scale would barely move. barScale eases toward the recent peak, with a
// floor so small deltas and low thresholds stay readable. Updated each frame.
const BAR_FLOOR = 120;
let barScale = BAR_FLOOR;
const SPARK_LEN = 240;       // trace ring-buffer length, ~10 s at 25 Hz

// CLI prompt for the console colouring.
const PROMPT_RE = /^(mpico>\s?)(.*)$/;

// Zone geometry, assigned from the global in zones-geometry.js at start().
let geometry = {};

/** Logical zone order: A1-8, B1-8, C1-2, D1-8, E1-8. Built, not fetched, so
 *  the page also works opened straight from disk. */
function zoneNames() {
  const rows = [];
  for (const family of ['A', 'B']) {
    for (let i = 1; i <= 8; i += 1) rows.push(`${family}${i}`);
  }
  rows.push('C1', 'C2');
  for (const family of ['D', 'E']) {
    for (let i = 1; i <= 8; i += 1) rows.push(`${family}${i}`);
  }
  return rows;
}

let zones = [];

// --- Shared state, filled by transport.js ----------------------------------

const state = {
  filtered: new Array(N_E).fill(0),
  deltas: new Array(N_E).fill(0),
  zonesActive: new Array(N_Z).fill(false),
  config: null,
  console: [],
  rate: 0,
  connected: false,
  source: '',
  error: '',
};

let transport = null;
let config = null;
let editing = null;      // field being typed into, left untouched by refreshes

// electrode index feeding each zone, derived from config.map on every refresh.
let zoneToElectrode = new Array(N_Z).fill(-1);

// Every monitor-side action (commands sent, user-facing notices) is journaled,
// so an exported session also tells what was done right before an observation
// (profile applied, threshold changed, calibration step...). Bounded ring.
const ACTION_LOG_MAX = 2000;
const actionLog = [];

function logAction(kind, text) {
  actionLog.push({ t: performance.now(), at: new Date().toISOString(), kind, text });
  if (actionLog.length > ACTION_LOG_MAX) actionLog.shift();
}

function send(command) {
  logAction('cmd', command);
  transport?.send(command);
}

// --- Elements --------------------------------------------------------------

const els = {
  link: document.getElementById('link'),
  rate: document.getElementById('rate'),
  connect: document.getElementById('connect'),
  disconnect: document.getElementById('disconnect'),
  saveBanner: document.getElementById('save-banner'),
  sidebarSave: document.getElementById('sidebar-save'),
  active: document.getElementById('active'),
  liveDisc: document.getElementById('live-disc'),
  spark: document.getElementById('spark'),
  sparkLabel: document.getElementById('spark-label'),
  liveThr: document.getElementById('live-thr'),
  liveThrInput: document.getElementById('live-thr-input'),
  liveThrSave: document.getElementById('live-thr-save'),
  liveThrReset: document.getElementById('live-thr-reset'),
  sparkAll: document.getElementById('spark-all'),
  sparkAllLegend: document.getElementById('spark-all-legend'),
  viewZone: document.getElementById('view-zone'),
  viewElectrode: document.getElementById('view-electrode'),
  rebase: document.getElementById('rebase'),
  zoneView: document.getElementById('zone-view'),
  zoneCards: document.getElementById('zone-cards'),
  electrodeView: document.getElementById('electrode-view'),
  electrodeCards: document.getElementById('electrode-cards'),
  processing: document.getElementById('processing'),
  boardLeds: document.getElementById('board-leds'),
  boardHid: document.getElementById('board-hid'),
  boardAime: document.getElementById('board-aime'),
  boardTweak: document.getElementById('board-tweak'),
  thrDisc: document.getElementById('thr-disc'),
  thresholdAll: document.getElementById('threshold-all'),
  thresholdAllValue: document.getElementById('threshold-all-value'),
  thresholdAllOut: document.getElementById('threshold-all-out'),
  thresholdRows: document.getElementById('threshold-rows'),
  mapDisc: document.getElementById('map-disc'),
  calibrate: document.getElementById('calibrate'),
  calibrateStatus: document.getElementById('calibrate-status'),
  calibrateZone: document.getElementById('calibrate-zone'),
  calibrateProgress: document.getElementById('calibrate-progress'),
  calibrateHold: document.getElementById('calibrate-hold'),
  calibrateSkip: document.getElementById('calibrate-skip'),
  calibrateStop: document.getElementById('calibrate-stop'),
  mappingRows: document.getElementById('mapping-rows'),
  console: document.getElementById('console'),
  consoleForm: document.getElementById('console-form'),
  command: document.getElementById('command'),
  consoleClear: document.getElementById('console-clear'),
  toast: document.getElementById('toast'),
  thrDialog: document.getElementById('thr-dialog'),
  thrTitle: document.getElementById('thr-dialog-title'),
  thrReading: document.getElementById('thr-dialog-reading'),
  thrField: document.getElementById('thr-dialog-field'),
  thrSlider: document.getElementById('thr-dialog-slider'),
  thrSave: document.getElementById('thr-dialog-save'),
  thrClose: document.getElementById('thr-dialog-close'),
  dialog: document.getElementById('zone-dialog'),
  dialogTitle: document.getElementById('zone-dialog-title'),
  dialogStatus: document.getElementById('zone-dialog-status'),
  dialogListen: document.getElementById('zone-listen'),
  dialogHold: document.getElementById('zone-hold'),
  dialogManual: document.getElementById('zone-manual'),
  dialogClose: document.getElementById('zone-close'),
  optDialog: document.getElementById('opt-dialog'),
  optTitle: document.getElementById('opt-title'),
  optBody: document.getElementById('opt-body'),
  profileSaveForm: document.getElementById('profile-save-form'),
  profileName: document.getElementById('profile-name'),
  profileImport: document.getElementById('profile-import'),
  profileImportInput: document.getElementById('profile-import-input'),
  profileList: document.getElementById('profile-list'),
  profileApply: document.getElementById('profile-apply'),
  profileApplyBar: document.getElementById('profile-apply-bar'),
  profileApplyProgress: document.getElementById('profile-apply-progress'),
  profileDialog: document.getElementById('profile-dialog'),
  profileDialogTitle: document.getElementById('profile-dialog-title'),
  profileDialogDate: document.getElementById('profile-dialog-date'),
  profileDialogBody: document.getElementById('profile-dialog-body'),
  profileDialogClose: document.getElementById('profile-dialog-close'),
  logRows: document.getElementById('log-rows'),
  logReset: document.getElementById('log-reset'),
  logStatsCsv: document.getElementById('log-stats-csv'),
  logStatsJson: document.getElementById('log-stats-json'),
  logRecToggle: document.getElementById('log-rec-toggle'),
  logRecord: document.getElementById('log-record'),
  logRecState: document.getElementById('log-rec-state'),
  logRecCount: document.getElementById('log-rec-count'),
  logRecDuration: document.getElementById('log-rec-duration'),
  logSessionCsv: document.getElementById('log-session-csv'),
  logSessionJson: document.getElementById('log-session-json'),
  autosaveStatus: document.getElementById('autosave-status'),
  autosaveChoose: document.getElementById('autosave-choose'),
  autosaveDisable: document.getElementById('autosave-disable'),
  trigRows: document.getElementById('trig-rows'),
  trigClear: document.getElementById('trig-clear'),
};

// Single "connect the board" gate that stands in for every board-driven tab
// until a configuration is received. Information stays reachable throughout.
const connectGate = document.getElementById('connect-gate');

// Reflect the connection state across the whole shell: lock every tab but
// Information, and swap the active board-driven section for the shared gate.
// The connection signal is the same one the old notices used: config !== null.
let lastGateState = null;   // avoid three querySelectorAll per frame

function updateConnectGate(force) {
  const connected = config !== null;
  // The nav clicks call this with force=true: the active section changed even
  // though the connection state did not.
  if (!force && connected === lastGateState) return;
  lastGateState = connected;
  document.body.classList.toggle('not-connected', !connected);
  document.querySelectorAll('.nav button').forEach((button) => {
    if (button.dataset.section === 'info') return;
    button.classList.toggle('locked', !connected);
  });
  const activeButton = document.querySelector('.nav button.active');
  const activeSection = activeButton ? activeButton.dataset.section : 'info';
  const showGate = !connected && activeSection !== 'info';
  connectGate.hidden = !showGate;
  document.querySelectorAll('.section').forEach((section) => {
    section.classList.toggle('gated',
      showGate && section.dataset.section === activeSection);
  });
}

// --- Small helpers ---------------------------------------------------------

let toastTimer = null;

function notify(message, tone = 'ok') {
  logAction(tone === 'warn' ? 'warn' : 'note', message);
  els.toast.textContent = message;
  els.toast.className = `toast toast-${tone}`;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Number input that sends on change, and never fights a value being typed. */
function editableNumber(value, min, max, onCommit) {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = value;
  input.min = min;
  input.max = max;
  input.addEventListener('focus', () => { editing = input; });
  input.addEventListener('blur', () => { editing = null; });
  input.addEventListener('change', () => {
    // Note: `editing` is NOT cleared here - the field still has focus after an
    // Enter, and a config refresh would overwrite whatever is typed next. The
    // blur listener releases the guard when focus actually leaves.
    onCommit(input.value);
  });
  return input;
}


/* Area centroid of a polygon: keeps each zone label near the visual middle
   rather than pulled toward whichever edge carries more outline points. */
function centroid(points) {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    x += (x0 + x1) * cross;
    y += (y0 + y1) * cross;
  }
  if (Math.abs(twiceArea) < 1e-6) {
    const sx = points.reduce((acc, p) => acc + p[0], 0);
    const sy = points.reduce((acc, p) => acc + p[1], 0);
    return [sx / points.length, sy / points.length];
  }
  return [x / (3 * twiceArea), y / (3 * twiceArea)];
}

function buildDisc(target, registry, onPick) {
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', CX);
  ring.setAttribute('cy', CY);
  ring.setAttribute('r', 201);
  ring.setAttribute('class', 'ring');
  target.appendChild(ring);

  zones.forEach((zone) => {
    const points = geometry[zone];
    if (!points) return;

    const pad = document.createElementNS(SVG_NS, 'polygon');
    pad.setAttribute('points', points.map((p) => p.join(',')).join(' '));
    pad.setAttribute('class', onPick ? 'pad clickable' : 'pad');

    const [lx, ly] = centroid(points);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', lx);
    label.setAttribute('y', ly);
    label.setAttribute('class', 'label');
    label.textContent = zone;

    if (onPick) {
      pad.addEventListener('click', () => onPick(zone));
      label.addEventListener('click', () => onPick(zone));
    }
    target.append(pad, label);
    registry.set(zone, pad);
  });
}

// A finger's electrode delta reconstructs its baseline: the firmware reports
// delta = baseline - filtered (never below 0), so baseline = filtered + delta.
const baselineOf = (e) => state.filtered[e] + state.deltas[e];

// electrode e -> "sensor:channel"
const sensorChannel = (e) => `${Math.floor(e / PER_SENSOR)}:${e % PER_SENSOR}`;

// --- Live cards ------------------------------------------------------------

const zoneCells = [];       // one ref set per zone, index = zone position
const electrodeCells = [];  // one ref set per electrode, index = electrode

function makeCell(name, sub, onClick) {
  const card = document.createElement('div');
  card.className = 'cell';
  card.innerHTML = `
    <div class="cell-head">
      <span class="cell-name"></span>
      <span class="cell-sub"></span>
    </div>
    <div class="cell-vals">
      <div><span>filtered</span><b class="cell-filtered">-</b></div>
      <div><span>baseline</span><b class="cell-baseline">-</b></div>
      <div class="cell-delta"><span>delta</span><b class="cell-delta-v">0</b></div>
    </div>
    <div class="cell-bar"><span class="fill"></span><span class="mark"></span></div>`;
  card.querySelector('.cell-name').textContent = name;
  card.querySelector('.cell-sub').textContent = sub;
  card.addEventListener('click', onClick);
  return {
    root: card,
    sub: card.querySelector('.cell-sub'),
    filtered: card.querySelector('.cell-filtered'),
    baseline: card.querySelector('.cell-baseline'),
    delta: card.querySelector('.cell-delta-v'),
    fill: card.querySelector('.fill'),
    mark: card.querySelector('.mark'),
  };
}

function buildZoneCards() {
  els.zoneCards.textContent = '';
  zoneCells.length = 0;
  zones.forEach((zone, z) => {
    const cell = makeCell(zone, '-', () => toggleLive({ kind: 'zone', index: z }));
    els.zoneCards.appendChild(cell.root);
    zoneCells.push(cell);
  });
}

function buildElectrodeCards() {
  els.electrodeCards.textContent = '';
  electrodeCells.length = 0;
  for (let s = 0; s < SENSORS; s += 1) {
    const group = document.createElement('div');
    group.className = 'sensor-group';
    const heading = document.createElement('h3');
    heading.textContent =
      `Sensor ${s} (electrodes ${s * PER_SENSOR}-${s * PER_SENSOR + PER_SENSOR - 1})`;
    group.appendChild(heading);
    const grid = document.createElement('div');
    grid.className = 'sensor-grid';

    for (let c = 0; c < PER_SENSOR; c += 1) {
      const e = s * PER_SENSOR + c;
      const cell = makeCell(`E${e}`, '-', () => toggleLive({ kind: 'electrode', index: e }));
      grid.appendChild(cell.root);
      electrodeCells.push(cell);
    }
    group.appendChild(grid);
    els.electrodeCards.appendChild(group);
  }
}

/** Paint one card's numbers and bar. threshold < 0 means the card has no zone,
 *  so no marker and no active state. */
function paintCell(cell, filtered, baseline, delta, threshold, active) {
  cell.filtered.textContent = filtered;
  cell.baseline.textContent = baseline;
  cell.delta.textContent = delta;
  cell.fill.style.width = `${Math.min(100, (delta / barScale) * 100)}%`;
  if (threshold >= 0) {
    cell.mark.style.setProperty('--thr-pos',
      `${Math.min(100, (threshold / barScale) * 100)}%`);
    cell.mark.hidden = false;
  } else {
    cell.mark.hidden = true;
  }
  cell.root.classList.toggle('touched', active);
}

// --- Trace (canvas sparkline) ----------------------------------------------

let liveSelection = null;   // { kind: 'zone'|'electrode', index }
const sparkBuffer = [];
const allBuffers = Array.from({ length: N_Z }, () => []);
// Delta ring buffer of the zone targeted in the calibration press step, so the
// wizard can show a per-zone trace with the shared renderer.
const calibPressBuffer = [];

function selectLive(selection) {
  liveSelection = selection;
  sparkBuffer.length = 0;
  const on = (cell, isOn) => cell.root.classList.toggle('selected', isOn);
  zoneCells.forEach((cell, z) =>
    on(cell, selection?.kind === 'zone' && selection.index === z));
  electrodeCells.forEach((cell, e) =>
    on(cell, selection?.kind === 'electrode' && selection.index === e));

  // Mark the matching zone on the Playfield disc too (a zone directly, or the
  // zone an electrode feeds).
  let selectedZone = null;
  if (selection?.kind === 'zone') {
    selectedZone = zones[selection.index];
  } else if (selection?.kind === 'electrode' && config) {
    const z = config.map[selection.index];
    if (z !== UNMAPPED && z < N_Z) selectedZone = zones[z];
  }
  livePads.forEach((pad, zone) => pad.classList.toggle('selected', zone === selectedZone));

  updateSparkLabel();
}

// Click a selection to trace it; click the same one again to clear it.
function toggleLive(selection) {
  const same = liveSelection
    && liveSelection.kind === selection.kind
    && liveSelection.index === selection.index;
  selectLive(same ? null : selection);
}

/** Electrode traced and its threshold, from whichever selection is active. */
function selectionTarget() {
  if (!liveSelection) return null;
  if (liveSelection.kind === 'zone') {
    const z = liveSelection.index;
    const e = zoneToElectrode[z];
    return { electrode: e, threshold: config ? config.thr[z] : 0, name: zones[z] };
  }
  const e = liveSelection.index;
  const zone = config ? config.map[e] : UNMAPPED;
  return {
    electrode: e,
    threshold: (config && zone !== UNMAPPED) ? config.thr[zone] : 0,
    name: `E${e}`,
  };
}

function updateSparkLabel() {
  const target = selectionTarget();
  if (!target) {
    els.sparkLabel.textContent = 'Pick a card below to trace its delta.';
    return;
  }
  const zoneName = liveSelection.kind === 'zone'
    ? target.name
    : (config && config.map[target.electrode] !== UNMAPPED
        ? zones[config.map[target.electrode]] : 'XX');
  els.sparkLabel.textContent = target.electrode >= 0
    ? `Tracing ${target.name} - electrode ${target.electrode} (${sensorChannel(target.electrode)}), zone ${zoneName}`
    : `${target.name} has no electrode assigned.`;
  updateLiveThr();
}

// The zone index behind the current trace (a zone directly, or the zone an
// electrode is mapped to), or -1 when the trace has no editable zone.
function tracedZone() {
  if (!liveSelection || !config) return -1;
  if (liveSelection.kind === 'zone') return liveSelection.index;
  const z = config.map[liveSelection.index];
  return z === UNMAPPED ? -1 : z;
}

// Inline threshold editor next to the Trace title. The field is a DRAFT, not
// a live mirror: it is seeded when the traced zone changes, follows the board
// only while untouched, and once edited it keeps the user's value - blur,
// frames, nothing overwrites it. Save (check) applies it; Reset (arrows,
// shown only when the draft differs from the board) drops the edit.
let liveThrZone = -1;     // zone the editor currently shows
let liveThrBoard = null;  // last board value the field was synced against

function updateLiveThr() {
  const z = tracedZone();
  const show = z >= 0 && Boolean(config);
  els.liveThr.hidden = !show;
  if (!show) { liveThrZone = -1; liveThrBoard = null; return; }

  const board = config.thr[z];
  if (z !== liveThrZone) {
    // A new zone was traced: seed the draft from the board.
    liveThrZone = z;
    liveThrBoard = board;
    els.liveThrInput.value = board;
  } else {
    // An untouched draft follows an external change (profile load, console
    // thr, auto-cal); an edited draft belongs to the user and never moves.
    if (Number(els.liveThrInput.value) === liveThrBoard && board !== liveThrBoard) {
      els.liveThrInput.value = board;
    }
    liveThrBoard = board;
  }
  els.liveThrReset.hidden = Number(els.liveThrInput.value) === board;
}

function resetLiveThr() {
  const z = tracedZone();
  if (z < 0 || !config) return;
  els.liveThrInput.value = config.thr[z];
  liveThrBoard = config.thr[z];
  els.liveThrReset.hidden = true;
}

function saveLiveThr() {
  const z = tracedZone();
  if (z < 0 || !config) return;
  let v = Math.round(Number(els.liveThrInput.value));
  if (!Number.isFinite(v)) return;
  v = Math.min(1000, Math.max(1, v));
  els.liveThrInput.value = v;
  send(`thr ${zones[z]} ${v}`);
  config.thr[z] = v;   // optimistic: no flicker back until C is republished
  liveThrBoard = v;
  els.liveThrReset.hidden = true;
  notify(`Threshold ${zones[z]} = ${v}`);
}

function initLiveThr() {
  els.liveThrInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); saveLiveThr(); }
  });
  // Keep the input focused through the button presses (nicer when chaining
  // type -> save -> type again).
  els.liveThrSave.addEventListener('mousedown', (event) => event.preventDefault());
  els.liveThrSave.addEventListener('click', saveLiveThr);
  els.liveThrReset.addEventListener('mousedown', (event) => event.preventDefault());
  els.liveThrReset.addEventListener('click', resetLiveThr);
}

// The trace canvases are CSS-sized (width: 100%): match the backing store to
// the displayed size before drawing, otherwise the fixed HTML width attribute
// gets stretched and the plot looks distorted. Skipped while hidden (size 0).
function syncCanvasSize(canvas) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w > 0 && canvas.width !== w) canvas.width = w;
  if (h > 0 && canvas.height !== h) canvas.height = h;
}

// Top-right peak badge, shared by the single-zone and all-zones traces. The
// caller decides the text and colour; the callers keep their own visibility
// guards (a zero peak draws nothing).
function drawPeakBadge(ctx, w, text, colour) {
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(w - tw - 11, 2, tw + 8, 15);
  ctx.fillStyle = colour;
  ctx.fillText(text, w - 7, 4);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// Core single-zone sparkline: a delta buffer plus optional dashed reference
// lines on a shared auto-scaled axis. Reused by the Live trace and the wizard's
// per-zone press trace, so the drawing lives in exactly one place.
function drawSingleTrace(canvas, buffer, refLines, scaleFloor) {
  syncCanvasSize(canvas);
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const peak = buffer.length ? Math.max(...buffer) : 0;
  const scale = Math.max(scaleFloor, peak * 1.1, 40);
  const y = (v) => h - (Math.min(v, scale) / scale) * (h - 8) - 4;

  refLines.forEach(({ value, colour }) => {
    if (!(value > 0)) return;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y(value));
    ctx.lineTo(w, y(value));
    ctx.stroke();
    ctx.setLineDash([]);
  });

  if (buffer.length > 1) {
    ctx.strokeStyle = '#4ea1ff';         // delta (var --accent)
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    buffer.forEach((value, i) => {
      const px = (i / (SPARK_LEN - 1)) * w;
      if (i === 0) ctx.moveTo(px, y(value));
      else ctx.lineTo(px, y(value));
    });
    ctx.stroke();
  }

  drawYMax(ctx, w, h, scale);

  // Live badge (top right): the tallest peak in the visible window.
  if (peak > 0) drawPeakBadge(ctx, w, `peak ${Math.round(peak)}`, '#4ea1ff');
}

function drawSpark() {
  const canvas = els.spark;
  const target = selectionTarget();
  if (!target || target.electrode < 0 || !config) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const hyst = config.hyst || 0;
  const on = target.threshold;
  const off = Math.round(on * (1 - hyst / 100));
  drawSingleTrace(canvas, sparkBuffer, [
    { value: on, colour: '#ff5c5c' },    // threshold ON  (var --hot)
    { value: off, colour: '#ffb000' },   // threshold OFF (var --warn)
  ], on * 1.6);
}

// One distinct hue per zone, shared by the global trace and its legend.
function zoneColor(z) {
  return `hsl(${Math.round((z / N_Z) * 360)}, 70%, 60%)`;
}

// Label the vertical axis top (auto-scaled max) and bottom (0), so a glance
// tells whether the biggest peak is ~50 or ~800.
function drawYMax(ctx, w, h, scale) {
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  // White text on a dark chip, so it stays readable over the coloured lines.
  const chip = (text, y) => {
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(3, y - 1, tw + 8, 15);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, 7, y + 1);
  };
  chip(`max ${Math.round(scale)}`, 3);
  chip('0', h - 15);
  ctx.textBaseline = 'alphabetic';
}

// Global trace: every zone's delta at once, on a shared auto-scaled axis. The
// target canvas is passed in so the same renderer can also draw onto the
// wizard's own all-zones canvas during step 1.
function drawGlobalSpark(canvas) {
  if (!canvas) return;
  syncCanvasSize(canvas);
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Track the tallest peak in the visible window and whose zone it is: it sets
  // the scale, and is shown live as a badge (top right).
  let peakVal = 0;
  let peakZone = -1;
  for (let z = 0; z < N_Z; z += 1) {
    for (const v of allBuffers[z]) {
      if (v > peakVal) { peakVal = v; peakZone = z; }
    }
  }
  const scale = Math.max(40, peakVal) * 1.1;
  const y = (v) => h - (Math.min(v, scale) / scale) * (h - 8) - 4;

  for (let z = 0; z < N_Z; z += 1) {
    const buf = allBuffers[z];
    if (buf.length < 2) continue;
    ctx.strokeStyle = zoneColor(z);
    ctx.lineWidth = 1;
    ctx.beginPath();
    buf.forEach((v, i) => {
      const px = (i / (SPARK_LEN - 1)) * w;
      if (i === 0) ctx.moveTo(px, y(v));
      else ctx.lineTo(px, y(v));
    });
    ctx.stroke();
  }

  drawYMax(ctx, w, h, scale);

  if (peakZone >= 0 && peakVal > 0) {
    drawPeakBadge(ctx, w, `peak ${zones[peakZone]} ${Math.round(peakVal)}`, zoneColor(peakZone));
  }
}

// One colour chip per zone, built into any container: the Live all-zones trace
// and the wizard's step-1 and step-4 copies share the same legend.
function buildGlobalLegend(target = els.sparkAllLegend) {
  if (!target) return;
  target.textContent = '';
  zones.forEach((zone, z) => {
    const item = document.createElement('span');
    const dot = document.createElement('i');
    dot.style.background = zoneColor(z);
    item.append(dot, document.createTextNode(zone));
    target.appendChild(item);
  });
}

// --- Last triggers (Live) --------------------------------------------------

// Real firmware triggers, newest first, fed by the transport's `T` queue. The
// queue is drained every frame (collection never stops); the table only repaints
// while the Live tab is on screen.
const LAST_TRIG_MAX = 20;
const lastTriggers = [];
let lastTrigDirty = true;

// Wall-clock HH:MM:SS stamp for the trigger list and the calibration console.
function clockStamp() {
  return new Date().toTimeString().slice(0, 8);
}

// Drain the transport's trigger queue once per frame: every event feeds the
// Last-triggers list, and (while the standby verify runs) the verify counters.
function drainTriggerEvents() {
  if (!triggerQueue.length) return;
  const stamp = clockStamp();
  for (const ev of triggerQueue) {
    lastTriggers.unshift({
      zone: ev.zone,
      peak: ev.peak,
      thr: config ? config.thr[ev.zone] : null,
      time: stamp,
    });
    if (calib.phase === 'verify') {
      calib.verifyTrig[ev.zone] += ev.count;
      if (ev.peak > calib.verifyPeak[ev.zone]) calib.verifyPeak[ev.zone] = ev.peak;
      calib.verifyLiveDirty = true;
    }
  }
  triggerQueue.length = 0;
  while (lastTriggers.length > LAST_TRIG_MAX) lastTriggers.pop();
  lastTrigDirty = true;
}

function renderLastTriggers() {
  els.trigRows.textContent = '';
  if (!lastTriggers.length) {
    const row = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'trig-empty';
    td.textContent = 'No trigger yet.';
    row.appendChild(td);
    els.trigRows.appendChild(row);
    return;
  }
  lastTriggers.forEach((t) => {
    const row = document.createElement('tr');
    const cells = [t.time, zones[t.zone], t.thr == null ? '-' : t.thr, t.peak];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      if (i === 1) td.className = 'zone-name';
      td.textContent = text;
      row.appendChild(td);
    });
    els.trigRows.appendChild(row);
  });
}

function clearLastTriggers() {
  lastTriggers.length = 0;
  renderLastTriggers();
}

// --- Signal-processing controls (Tuning) -----------------------------------

// References to the built inputs, so a config refresh can update them.
const proc = {};

// Per-option help, shown by the "?" buttons in a modal dialog.
const OPTION_HELP = {
  hyst: {
    title: 'Release margin (hysteresis)',
    body: `<p><b>In one line:</b> once a zone is on, it takes a bigger drop to
      turn it off again.</p>
      <p>Think of a door that sticks a little: you have to pull slightly harder
      to open it than to keep it shut. Without that stickiness, a finger resting
      exactly at the limit makes the zone chatter on-off-on-off.</p>
      <p class="info-example"><b>Example</b> - threshold 50, hyst 25%: the zone turns <b>on</b> at 50,
      and only lets go below <b>37</b> (50 - 25%). Anything wobbling between 37
      and 50 changes nothing.</p>
      <pre class="info-diagram">delta
   55            .------.
                 |      |
   50 --------- ON ------------- turns ON at 50 (threshold)
   37 ----------|------ OFF ---- lets go under 37
    0 __________'        '______   (37 = 50 x (1 - 25% hyst))
        rest     press    release</pre>
      <p><b>Symptom &rarr; fix:</b> a zone flickers while you hold it &rarr;
      raise hyst (30-40%). Zones feel like they stay on too long after you lift
      &rarr; lower it. <b>Cost of raising:</b> the release comes slightly later
      (never the press).</p>
      <p><b>Note:</b> on a firm tap this margin does nothing - the delta flies
      far past the threshold and falls back just as fast. It earns its keep on
      <b>holds and slides</b>: a light or slowly-lifting finger hovers near the
      threshold for a long moment, and that is when a zone flickers. If you
      never see flicker, lower it (0 releases exactly at the threshold) - the
      release only gets snappier.</p>`,
  },
  avg: {
    title: 'Averaging',
    body: `<p><b>In one line:</b> blur the last N readings together so a single
      ugly one cannot fire a zone.</p>
      <p>Like judging someone's mood over a whole minute instead of one blink:
      one odd instant stops mattering. The cost is that you learn it a moment
      later.</p>
      <p class="info-example"><b>Example</b> - readings 5, 6, <b>60</b>, 5 (that 60 is a noise
      spike). With avg 1 the firmware sees 60 and may fire. With avg 4
      it sees (5+6+60+5)/4 = <b>19</b>: no trigger.</p>
      <pre class="info-diagram">frames        1    2    3    4
raw           5    6   60    5    one noise spike of 60
avg 1         5    6   60    5    the spike can fire the zone
avg 4         5    5   19   19    diluted: (5+6+60+5) / 4 = 19</pre>
      <p><b>Symptom &rarr; fix:</b> single-frame spikes still trigger even with
      a sane threshold &rarr; raise to 2-4. <b>Cost:</b> each extra frame is
      real added lag on <b>every</b> press. Prefer <b>debounce</b> first: it
      fights spikes without slowing a genuine press as much.</p>`,
  },
  debounce: {
    title: 'Debounce',
    body: `<p><b>In one line:</b> "say it twice and I'll believe you". A zone
      must agree with itself several readings in a row before it changes.</p>
      <p><b>on</b> = how many readings above the threshold before it turns
      <b>on</b>. <b>off</b> = how many readings below the release level before
      it turns <b>off</b>. Noise is brief and never repeats cleanly; a real
      finger holds for many readings.</p>
      <p class="info-example"><b>Example</b> - with <b>on 3</b>, a spike lasting 1 reading is
      ignored (it never reaches 3 in a row), while your finger, present for
      dozens of readings, passes easily.</p>
      <pre class="info-diagram">readings above the threshold, in a row (debounce on = 3):
noise spike   X . . .          only 1  -> dropped
real finger   X X X X X ...    3rd one -> ON</pre>
      <p><b>Symptom &rarr; fix:</b> phantom clicks while nobody touches the
      glass &rarr; raise <b>on</b> to 2-4 to smooth them out; <b>cost:</b> each
      step delays a real press (~3 ms per step, see below). A held press
      drops out for an instant &rarr; raise <b>off</b> to 4-6; that one is
      nearly free, a late release is not felt.</p>
      <p>Note: an electrode is re-read every 3rd frame (the three chips take
      turns), so <b>one debounce step is about 3 ms</b>.</p>`,
  },
  gain: {
    title: 'Gain (CDC / CDT)',
    body: `<p><b>In one line:</b> the microphone volume of the sensor. Louder
      signal, but louder hiss too.</p>
      <p>Why not 0? CDC/CDT are not something to minimise - they power the
      measurement itself. At 0 no charge is injected and nothing is measured
      (0 means &laquo; disabled &raquo; in the chip). 16 uA / 0.5 us sit
      mid-range and give a healthy reading; auto-config then trims the current
      per electrode.</p>
      <p><b>CDC</b> (0-63) is how much current is pushed into the electrode;
      <b>CDT</b> (0-7) is how long. Together they scale every reading, touch and
      noise alike - so the <b>ratio</b> between a press and the noise barely
      changes.</p>
      <p class="info-example"><b>Example</b> - press peaks at 40 with noise around 8. Double the
      gain: the press reads ~80, but noise reads ~16. Bigger numbers, same
      difficulty.</p>
      <pre class="info-diagram">           press   noise   press/noise
gain x1      40      8        5 : 1
gain x2      80     16        5 : 1   same ratio, bigger numbers</pre>
      <p><b>Symptom &rarr; fix:</b> presses barely move the bar (peaks under
      ~20) &rarr; raise CDC a little. Readings look pinned at the top
      (saturated) &rarr; lower it. <b>After any change, re-run the thresholds</b>
      (auto-calibration): every number just moved.</p>`,
  },
  filter: {
    title: 'Filter (FFI / SFI / ESI)',
    body: `<p><b>In one line:</b> the sensor chip's own smoothing, applied
      before the firmware ever sees the value.</p>
      <p>Same idea as taking several photos and keeping the average instead of a
      single blurry shot. Three knobs, all with the same trade: cleaner signal,
      slower reaction.</p>
      <pre class="info-diagram">electrode --> [ FFI avg ] --> [ SFI avg ] --> value read
                    one sample every ESI ms
     more averaging = smoother, but older, value</pre>
      <p><b>FFI</b> - readings averaged per sample (0=6, 1=10, 2=18, 3=34).<br>
      <b>SFI</b> - a second averaging pass (0=4, 1=6, 2=10, 3=18).<br>
      <b>ESI</b> - the wait between samples, 0=1 ms up to 7=128 ms.
      This is the cheapest way to fight noise: spreading samples over time
      averages it out without extra work.</p>
      <p><b>Combinations to try:</b></p>
      <p>&bull; <code>0 0 0</code> - fastest, noisiest.<br>
      &bull; <code>0 1 0</code> - light and responsive (firmware default).<br>
      &bull; <code>0 1 3</code> - good anti-noise, barely any lag. Start here if
      the panel is noisy.<br>
      &bull; <code>1 1 4</code> / <code>2 2 4</code> - very clean for a bad
      panel, and you will feel the lag.</p>
      <p><b>Order to try:</b> raise <b>ESI</b> first, then <b>SFI</b>; keep
      <b>FFI</b> low to stay responsive. Then let <b>debounce</b> mop up the
      remaining brief spikes.</p>`,
  },
  baseline: {
    title: 'Baseline tracking (the resting reference)',
    body: `<p><b>In one line:</b> the "zero" each electrode is measured against -
      what it reads when nobody touches it (<code>delta = baseline -
      filtered</code>).</p>
      <p>That zero drifts slowly with temperature, humidity and dust. So it is
      re-centred continuously: a zone neither creeps toward firing on its own,
      nor goes deaf over an evening. It is <b>frozen while a zone is held</b>,
      so a long press is never quietly swallowed.</p>
      <pre class="info-diagram">filtered   902  901  898  903 ...  raw reading, wiggles
baseline   900  900  900  900 ...  memorised rest reference
delta        0    0    2    0 ...  stays ~0 until a real touch</pre>
      <p><b>This only chooses who keeps that zero up to date</b> - the touch
      decision (threshold, hysteresis, debounce) is <b>always</b> done by the
      firmware, in both modes.</p>
      <p><b>Chip (MPR121)</b> - the sensor keeps that zero fresh itself, with
      its proven built-in tracking; the firmware just reads the number.<br>
      <b>Firmware</b> - the firmware maintains the very same number itself, one
      step every <i>rate</i> frames.</p>
      <p><b>In play you cannot tell them apart</b> - same delta, same presses,
      same latency. The only real difference is maintenance: <b>Chip</b> runs at
      a fixed, proven speed and costs nothing; <b>Firmware</b> lets you choose
      the speed (<i>rate</i>) yourself. Keep <b>Chip</b>; switch only if the
      resting reference ever behaves oddly (drifts weirdly, sticks after a
      wiring change) and you want direct control over it.</p>
      <p>This is about slow drift, not speed: it does <b>not</b> change touch
      latency. <b>Set idle level</b> re-seeds the zero immediately - do it after
      moving the cabinet or changing the wiring, with nothing on the glass.</p>`,
  },
  threshold: {
    title: 'Per-zone threshold',
    body: `<p><b>In one line:</b> how hard a zone must be pushed to count as
      touched. <b>Higher = less sensitive.</b></p>
      <p>Every zone is its own little world: a big outer pad and a tiny centre
      pad do not answer with the same strength, so each gets its own number.</p>
      <p class="info-example"><b>Example</b> - a zone rests around 5-10 and peaks at 120 when you
      press it. A threshold of <b>40</b> sits well clear of the noise and well
      under the press. Too low (10) and it fires on its own; too high (110) and
      a quick tap is missed.</p>
      <pre class="info-diagram">delta
  120 . . . . . . press peak (held)
   75 . . . . . . quick in-game tap only reaches here
   40 ----------- threshold: above noise, well under the tap
   10 ~~~~~~~~~~~ sustained noise stays below
    0 ___________
 too low (10) fires alone - too high (110) misses taps</pre>
      <p><b>The rule:</b> place it midway between that zone's <b>sustained</b>
      noise and its fast in-game taps, not right on top of the noise. Between two
      rapid taps a hovering finger keeps a residual delta above the noise; a
      threshold set too low leaves the release margin (OFF) under that residual,
      so the zone never lets go during a spam. The midpoint keeps OFF clear of
      the hovering finger while staying well under a real tap, and <b>debounce</b>
      still kills brief spikes.</p>
      <p>Watch the zone's bar or its trace to place it, or let
      <b>Auto Calibration</b> measure both numbers for you.</p>
      <p><b>Quick start:</b> the <b>All zones</b> control above the table writes
      one value onto every zone at once - a flat starting point before you
      fine-tune each one.</p>`,
  },
  level: {
    title: 'Brightness (level)',
    body: `<p><b>In one line:</b> one dimmer knob for every LED at once.</p>
      <p>From <b>0</b> (off) to <b>255</b> (full). It scales the button, cabinet
      and banner LEDs together - the game still chooses the colours, this only
      decides how bright they come out.</p>
      <p class="info-example"><b>Example</b> - level 127 (the default) is half brightness: plenty
      indoors, and it halves the current the LEDs draw.</p>
      <p>Lower it if the LEDs are dazzling or if the USB supply struggles.</p>`,
  },
  rgb: {
    title: 'LED counts',
    body: `<p>How many <b>addressable pixels in the data chain</b> each unit takes,
      so the firmware drives the right chain length: <b>button</b> (per ring
      button), <b>cabinet</b> (per cabinet light) and <b>banner</b>. The firmware
      repeats each unit's colour this many times down the WS2812 chain.</p>
      <p>This is <b>not</b> the number of LED packages you can see. Two LEDs wired
      <b>in parallel</b> (sharing one data line) are a single addressable pixel, so
      <b>button = 1</b> lights both. Only set <b>2</b> if a button has two pixels
      chained <b>in series</b> (data-out to data-in), in button order.</p>
      <p>Too high a count pushes extra pixels and shifts everything after it
      (cabinet, banner) down the chain. Set a count to <b>0</b> to disable that
      group.</p>`,
  },
  rgbmap: {
    title: "Button LED order (drag'n'drop)",
    body: `<p>Which physical LED on the chain lights each ring button. The chips
      are laid out along the chain - position <b>0</b> on the left to <b>7</b> on
      the right - and each shows the button (<b>B1-B8</b>) that position drives.</p>
      <p><b>Drag</b> a chip to the position that should light it; the new order is
      sent as soon as you drop it. <b>Reset to default</b> restores the factory
      order.</p>`,
  },
  hid: {
    title: 'HID mode',
    body: `<p><b>In one line:</b> which kind of device the PC thinks is plugged
      in.</p>
      <p><b>IO4 (arcade)</b> pretends to be the real arcade IO board - what SEGA
      arcade software expects. <b>Keyboard 1 / 2</b> make the buttons type
      keyboard keys instead (two different layouts), for playing on a PC with
      normal games. <b>Off</b> reports nothing.</p>
      <p><b>Careful:</b> the USB identity is decided at boot, so a change only
      takes effect after <b>Save to flash</b> and a reboot.</p>`,
  },
  aime: {
    title: 'AIME / NFC card reader',
    body: `<p><b>In one line:</b> the card reader used to log in.</p>
      <p><b>Protocol mode</b> (<b>0</b> or <b>1</b>) picks which reader dialect
      the host expects - if the game does not see the reader, try the other
      one.</p>
      <p><b>Virtual AIC</b> makes the board pretend a reader is attached even
      when none is wired, so the game stops complaining.</p>`,
  },
  tweak: {
    title: 'Button polarity (active-high)',
    body: `<p><b>In one line:</b> tells the board whether a pressed button sends
      a <b>1</b> or a <b>0</b>.</p>
      <p>Most switches pull the wire down when pressed (active-low, the
      default). Some optical sensors do the opposite.</p>
      <p><b>Main</b> covers the eight play buttons.</p>
      <p><b>Aux</b> covers the Test / Service / Navigate / Coin ones.</p>
      <p><b>Symptom:</b> a button reads as permanently held, or releases when you
      press it &rarr; flip the matching switch. Otherwise leave both off.</p>`,
  },
};

function optInfoButton(key) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'opt-info';
  b.textContent = '?';
  b.dataset.help = key;
  b.setAttribute('aria-label', 'What does this setting do?');
  return b;
}

// Recommended defaults, highlighted at the bottom of each help popup.
const OPTION_DEFAULTS = {
  threshold: 'just above each zone’s sustained noise (often 15-50 here)',
  hyst: '25%',
  avg: '2 (1 disables it)',
  debounce: 'on 1, off 3',
  gain: 'cdc 16, cdt 1',
  filter: 'ffi 0, sfi 1, esi 3 for a noisy panel (default 0 1 0)',
  baseline: 'Chip (MPR121), rate 400',
  level: '127',
  rgbmap: 'the factory order (Reset to default)',
  hid: 'IO4 (arcade)',
  aime: 'Mode 0, Virtual off',
  tweak: 'off / off',
};

function openOptHelp(key) {
  const help = OPTION_HELP[key];
  if (!help || !els.optDialog) return;
  els.optTitle.textContent = help.title;
  const rec = OPTION_DEFAULTS[key];
  els.optBody.innerHTML = help.body
    + (rec ? `<p class="opt-default">Recommended: <b>${rec}</b></p>` : '');
  els.optDialog.showModal();
}

// Header row for a processing option: its label plus a "?" help button.
function procHead(text, key) {
  const head = document.createElement('div');
  head.className = 'proc-head';
  const name = document.createElement('label');
  name.textContent = text;
  head.appendChild(name);
  if (key) head.appendChild(optInfoButton(key));
  return head;
}

function procScalar(label, key, min, max, hint, command, detail) {
  const box = document.createElement('div');
  box.className = 'proc';

  box.appendChild(procHead(label, key));

  const input = editableNumber(0, min, max, (v) => send(`${command} ${v}`));
  proc[key] = input;
  box.appendChild(input);

  if (detail) {
    const d = document.createElement('small');
    d.className = 'proc-detail';
    d.dataset.detail = key;
    box.appendChild(d);
  }
  const h = document.createElement('small');
  h.textContent = hint;
  box.appendChild(h);
  els.processing.appendChild(box);
}

// A packed setting: several small fields committed together with one command.
function procMulti(label, helpKey, hint, fields, commit) {
  const box = document.createElement('div');
  box.className = 'proc';
  box.appendChild(procHead(label, helpKey));

  const row = document.createElement('div');
  row.className = 'proc-fields';
  fields.forEach((field) => {
    const wrap = document.createElement('div');
    wrap.className = 'proc-field';
    const span = document.createElement('span');
    span.textContent = field.sub;
    const input = editableNumber(0, field.min, field.max, () => commit());
    proc[field.key] = input;
    wrap.append(span, input);
    row.appendChild(wrap);
  });
  box.appendChild(row);

  const h = document.createElement('small');
  h.textContent = hint;
  box.appendChild(h);
  els.processing.appendChild(box);
}

function buildProcessing() {
  els.processing.textContent = '';

  procScalar('Release margin (hyst)', 'hyst', 0, 90,
    'How far below the threshold a zone must fall to release.', 'hyst',
    (v) => `releases at ${100 - v}% of the threshold`);
  procScalar('Averaging', 'avg', 1, 16,
    'Frames averaged before deciding. 1 disables it.', 'avg',
    (v) => (v > 1 ? `mean of ${v} frames` : 'off'));

  procMulti('Debounce (frames)', 'debounce',
    'A change must hold this many frames to be accepted.',
    [{ key: 'debounceOn', sub: 'on', min: 0, max: 15 },
     { key: 'debounceOff', sub: 'off', min: 0, max: 15 }],
    () => send(`debounce ${proc.debounceOn.value} ${proc.debounceOff.value}`));

  procMulti('Gain', 'gain',
    'MPR121 charge-current (CDC) and charge-time (CDT) gain.',
    [{ key: 'gainCdc', sub: 'cdc', min: 0, max: 63 },
     { key: 'gainCdt', sub: 'cdt', min: 0, max: 7 }],
    () => send(`gain ${proc.gainCdc.value} ${proc.gainCdt.value}`));

  procMulti('Filter', 'filter',
    'First-filter iterations (ffi), second-filter (sfi), electrode sample (esi).',
    [{ key: 'ffi', sub: 'ffi', min: 0, max: 3 },
     { key: 'sfi', sub: 'sfi', min: 0, max: 3 },
     { key: 'esi', sub: 'esi', min: 0, max: 7 }],
    () => send(`filter ${proc.ffi.value} ${proc.sfi.value} ${proc.esi.value}`));

  buildBaselineControl();
}

function buildBaselineControl() {
  const box = document.createElement('div');
  box.className = 'proc';
  box.appendChild(procHead('Resting reference (baseline)', 'baseline'));

  const btns = document.createElement('div');
  btns.className = 'proc-btns';
  // Labelled by WHO keeps the reference current, not "hardware vs software":
  // the touch decision itself is always the firmware's, in both modes, and the
  // old wording read as if this switched back to the stock chip detection.
  proc.baselineHw = document.createElement('button');
  proc.baselineHw.type = 'button';
  proc.baselineHw.className = 'seg';
  proc.baselineHw.textContent = 'Chip (MPR121)';
  proc.baselineHw.addEventListener('click', () => send('baseline hw'));
  proc.baselineSoft = document.createElement('button');
  proc.baselineSoft.type = 'button';
  proc.baselineSoft.className = 'seg';
  proc.baselineSoft.textContent = 'Firmware';
  proc.baselineSoft.addEventListener('click', () => send('baseline soft'));
  btns.append(proc.baselineHw, proc.baselineSoft);
  box.appendChild(btns);

  const rate = document.createElement('div');
  rate.className = 'proc-flat';
  const rateLabel = document.createElement('span');
  rateLabel.className = 'proc-detail';
  rateLabel.textContent = 'firmware rate';
  proc.rate = editableNumber(0, 1, 60000, (v) => send(`baseline soft ${v}`));
  rate.append(rateLabel, proc.rate);
  box.appendChild(rate);

  // Re-seed the resting reference now, from the current (untouched) readings.
  const idle = document.createElement('div');
  idle.className = 'proc-btns';
  const idleBtn = document.createElement('button');
  idleBtn.type = 'button';
  idleBtn.textContent = 'Set idle level';
  idleBtn.addEventListener('click', () => {
    send('rebase');
    notify('Idle level set from the current readings');
  });
  idle.appendChild(idleBtn);
  box.appendChild(idle);

  const hint = document.createElement('small');
  hint.innerHTML = 'Hardware: the MPR121 tracks it internally.<br>'
    + 'Software: the firmware tracks it, at the rate below.<br>'
    + 'Either way, frozen while a zone is held. '
    + 'Set idle level re-seeds the reference now.';
  box.appendChild(hint);
  els.processing.appendChild(box);
}

// HID mode from the io4 / nkro pair the firmware reports - one definition for
// the Board buttons, the profile apply commands and the summaries.
function hidModeOf(cfg) {
  return cfg.hidIo4 === 1 ? 'io4'
    : cfg.hidNkro === 1 ? 'key1'
      : cfg.hidNkro === 2 ? 'key2' : 'off';
}
const HID_MODE_LABEL = {
  io4: 'IO4 (arcade)', key1: 'Keyboard 1', key2: 'Keyboard 2', off: 'Off',
};

// filter is a packed byte: ffi = bits 6-7, sfi = bits 4-5, esi = bits 0-2.
function decodeFilter(byte) {
  return { ffi: byte >> 6, sfi: (byte >> 4) & 3, esi: byte & 7 };
}

function refreshProcessing(cfg) {
  const set = (input, value) => { if (input && input !== editing) input.value = value; };
  set(proc.hyst, cfg.hyst);
  set(proc.avg, cfg.avg);
  set(proc.debounceOn, cfg.debounceOn);
  set(proc.debounceOff, cfg.debounceOff);
  set(proc.gainCdc, cfg.gainCdc);
  set(proc.gainCdt, cfg.gainCdt);
  set(proc.rate, cfg.rate);

  const filter = decodeFilter(cfg.filter);
  set(proc.ffi, filter.ffi);
  set(proc.sfi, filter.sfi);
  set(proc.esi, filter.esi);

  proc.baselineHw.classList.toggle('on', cfg.baselineMode === 0);
  proc.baselineSoft.classList.toggle('on', cfg.baselineMode === 1);

  const hystDetail = els.processing.querySelector('[data-detail="hyst"]');
  if (hystDetail) hystDetail.textContent = `releases at ${100 - cfg.hyst}% of the threshold`;
  const avgDetail = els.processing.querySelector('[data-detail="avg"]');
  if (avgDetail) avgDetail.textContent = cfg.avg > 1 ? `mean of ${cfg.avg} frames` : 'off';
}

// --- Board (LEDs, HID, AIME) -----------------------------------------------

// Factory button LED order (firmware RGB_BUTTON_MAP). A published rgbMap value
// of 255 means "default", so it resolves to this position for its slot.
const RGB_DEFAULT_ORDER = [5, 4, 3, 2, 1, 0, 7, 6];

// References to the built controls, so a config refresh can update them.
const board = { hid: {}, aimeMode: {}, chips: [] };

// True while a button-LED-order chip is being dragged, so the ~2 Hz config
// refresh does not reorder the chips out from under the pointer.
let orderDragging = false;

function boardCard(container, label, helpKey) {
  const box = document.createElement('div');
  box.className = 'proc';
  box.appendChild(procHead(label, helpKey));
  container.appendChild(box);
  return box;
}

function boardHint(box, text) {
  const small = document.createElement('small');
  small.textContent = text;
  box.appendChild(small);
}

function commitRgbCounts() {
  // Never send an empty field: fall back to the last known config value so the
  // command always has three valid integers (the firmware rejects otherwise).
  const cfg = config || {};
  const num = (input, fallback) => {
    const n = parseInt(input.value, 10);
    return Number.isInteger(n) ? n : fallback;
  };
  const button = num(board.rgbButton, cfg.rgbButton ?? 0);
  const cabinet = num(board.rgbCab, cfg.rgbCab ?? 0);
  const banner = num(board.rgbBanner, cfg.rgbBanner ?? 0);
  send(`rgb ${button} ${cabinet} ${banner}`);
}

// Chain order the chips should show for a config: order[position] = button, so
// each chip sits at the chain position that lights its button. rgbMap[b] is
// that position (255 = "default", resolved from the factory order).
function rgbTargetOrder(cfg) {
  const order = new Array(8).fill(-1);
  for (let b = 0; b < 8; b += 1) {
    const pos = cfg.rgbMap[b] === UNMAPPED ? RGB_DEFAULT_ORDER[b] : cfg.rgbMap[b];
    if (pos >= 0 && pos < 8) order[pos] = b;
  }
  return order;
}

// Read the chips left-to-right (chain position 0..7) and send the mapping the
// firmware expects: rgbmap[button] = the chain position that lights it.
function commitRgbOrder() {
  const chips = [...board.orderList.querySelectorAll('.led-chip:not(.led-slot)')];
  const rgbmap = new Array(8).fill(0);
  chips.forEach((chip, position) => { rgbmap[Number(chip.dataset.button)] = position; });
  send(`rgbmap ${rgbmap.join(' ')}`);
}

// The chip the dragged one should be inserted before: the nearest chip whose
// horizontal centre is to the right of the pointer, or null to append at the
// end (pointer past every remaining chip).
function chipBeforeX(list, x) {
  const chips = [...list.querySelectorAll('.led-chip:not(.dragging):not(.led-slot)')];
  let closest = null;
  let closestOffset = Number.POSITIVE_INFINITY;
  for (const chip of chips) {
    const box = chip.getBoundingClientRect();
    const offset = box.left + box.width / 2 - x;
    if (offset >= 0 && offset < closestOffset) {
      closestOffset = offset;
      closest = chip;
    }
  }
  return closest;
}

// One draggable pastille per ring button. dataset.button is the button index;
// the chip's DOM position is the chain position that lights it.
function buildLedChip(button) {
  const chip = document.createElement('div');
  chip.className = 'led-chip';
  chip.draggable = true;
  chip.dataset.button = button;
  chip.textContent = `B${button + 1}`;

  chip.addEventListener('dragstart', (e) => {
    orderDragging = true;
    chip.classList.add('dragging');
    // Dashed ghost pinned at the origin for the whole drag, so the starting
    // position stays visible while the chip is moved around.
    const slot = document.createElement('div');
    slot.className = 'led-chip led-slot';
    slot.textContent = chip.textContent;
    chip.after(slot);
    board.dragSlot = slot;
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  chip.addEventListener('dragend', () => {
    chip.classList.remove('dragging');
    if (board.dragSlot) {
      board.dragSlot.remove();
      board.dragSlot = null;
    }
    orderDragging = false;
    commitRgbOrder();
  });
  return chip;
}

// Reorder the existing chips to match the config, only touching the DOM when
// the order actually differs (the config republishes ~2x/s, and a needless
// re-append would make the row flicker).
function syncLedChips(cfg) {
  const target = rgbTargetOrder(cfg);
  const current = [...board.orderList.querySelectorAll('.led-chip')]
    .map((chip) => Number(chip.dataset.button));
  if (target.every((button, i) => button === current[i])) return;
  target.forEach((button) => {
    if (board.chips[button]) board.orderList.appendChild(board.chips[button]);
  });
}

function buildBoardLeds() {
  const grid = document.createElement('div');
  grid.className = 'board-grid';
  els.boardLeds.appendChild(grid);

  const bright = boardCard(grid, 'Brightness (level)', 'level');
  board.level = editableNumber(0, 0, 255, (v) => send(`level ${v}`));
  bright.appendChild(board.level);
  boardHint(bright, 'Global LED brightness, 0 (off) to 255 (full).');

  const counts = boardCard(grid, 'LEDs per unit', 'rgb');
  const countRow = document.createElement('div');
  countRow.className = 'proc-fields';
  [['rgbButton', 'button'], ['rgbCab', 'cabinet'], ['rgbBanner', 'banner']]
    .forEach(([key, sub]) => {
      const wrap = document.createElement('div');
      wrap.className = 'proc-field';
      const span = document.createElement('span');
      span.textContent = sub;
      board[key] = editableNumber(0, 0, 15, () => commitRgbCounts());
      wrap.append(span, board[key]);
      countRow.appendChild(wrap);
    });
  counts.appendChild(countRow);
  boardHint(counts, 'Addressable pixels per button, per cabinet light and for the '
    + 'banner (0-15) - not the visible LED count. Parallel-wired LEDs share one '
    + 'pixel, so button = 1 lights both. The three are sent together.');

  const order = boardCard(grid, "Button LED order (drag'n'drop)", 'rgbmap');
  order.classList.add('board-wide');

  const list = document.createElement('div');
  list.className = 'led-order';
  board.orderList = list;
  board.chips = [];
  for (let b = 0; b < 8; b += 1) {
    const chip = buildLedChip(b);
    board.chips[b] = chip;
    list.appendChild(chip);
  }
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    const dragging = list.querySelector('.led-chip.dragging');
    if (!dragging) return;
    const before = chipBeforeX(list, e.clientX);
    if (before) list.insertBefore(dragging, before);
    else list.appendChild(dragging);
  });
  order.appendChild(list);

  const btns = document.createElement('div');
  btns.className = 'proc-btns';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Reset to default';
  reset.addEventListener('click', () => {
    send('rgbmap reset');
    notify('Button LED order reset to default');
  });
  btns.append(reset);
  order.appendChild(btns);
  boardHint(order, 'Chain position 0 (left) to 7 (right). Drag a button chip to '
    + 'the position that should light it; the new order is sent on drop.');
}

function buildBoardHid() {
  const seg = document.createElement('div');
  seg.className = 'proc-btns';
  [['io4', 'IO4 (arcade)'], ['key1', 'Keyboard 1'],
    ['key2', 'Keyboard 2'], ['off', 'Off']].forEach(([mode, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg';
    btn.textContent = label;
    btn.addEventListener('click', () => send(`hid ${mode}`));
    board.hid[mode] = btn;
    seg.appendChild(btn);
  });
  els.boardHid.appendChild(seg);
}

function buildBoardAime() {
  const modeRow = document.createElement('div');
  modeRow.className = 'board-row';
  const modeLabel = document.createElement('span');
  modeLabel.className = 'board-row-label';
  modeLabel.textContent = 'Protocol mode';
  const modeSeg = document.createElement('div');
  modeSeg.className = 'proc-btns';
  [['0', 'Mode 0'], ['1', 'Mode 1']].forEach(([value, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg';
    btn.textContent = label;
    btn.addEventListener('click', () => send(`aime mode ${value}`));
    board.aimeMode[value] = btn;
    modeSeg.appendChild(btn);
  });
  modeRow.append(modeLabel, modeSeg);

  const virtRow = document.createElement('div');
  virtRow.className = 'board-row';
  const virtLabel = document.createElement('span');
  virtLabel.className = 'board-row-label';
  virtLabel.textContent = 'Virtual AIC';
  const virtSeg = document.createElement('div');
  virtSeg.className = 'proc-btns';
  board.aimeVirtual = {};
  [['on', 'On'], ['off', 'Off']].forEach(([value, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg';
    btn.textContent = label;
    btn.addEventListener('click', () => send(`aime virtual ${value}`));
    board.aimeVirtual[value] = btn;
    virtSeg.appendChild(btn);
  });
  virtRow.append(virtLabel, virtSeg);

  els.boardAime.append(modeRow, virtRow);
}

function buildBoardTweak() {
  const rows = [
    ['tweakMain', 'main_button_active_high', 'Main buttons active-high'],
    ['tweakAux', 'aux_button_active_high', 'Aux buttons active-high'],
  ];
  rows.forEach(([key, option, label]) => {
    const row = document.createElement('div');
    row.className = 'board-row';
    const name = document.createElement('span');
    name.className = 'board-row-label';
    name.textContent = label;
    const seg = document.createElement('div');
    seg.className = 'proc-btns';
    board[key] = {};
    [['on', 'On'], ['off', 'Off']].forEach(([value, text]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'seg';
      btn.textContent = text;
      btn.addEventListener('click', () => send(`tweak ${option} ${value}`));
      board[key][value] = btn;
      seg.appendChild(btn);
    });
    row.append(name, seg);
    els.boardTweak.appendChild(row);
  });
}

function buildBoard() {
  buildBoardLeds();
  buildBoardHid();
  buildBoardAime();
  buildBoardTweak();
}

function refreshBoard(cfg) {
  const set = (input, value) => { if (input && input !== editing) input.value = value; };
  set(board.level, cfg.level);
  set(board.rgbButton, cfg.rgbButton);
  set(board.rgbCab, cfg.rgbCab);
  set(board.rgbBanner, cfg.rgbBanner);

  // Reflect the board's order in the chips, unless the user is mid-drag.
  if (!orderDragging) syncLedChips(cfg);

  // Current HID mode from the io4 / nkro pair the firmware reports.
  const hidMode = hidModeOf(cfg);
  Object.entries(board.hid).forEach(([mode, btn]) =>
    btn.classList.toggle('on', mode === hidMode));

  Object.entries(board.aimeMode).forEach(([value, btn]) =>
    btn.classList.toggle('on', Number(value) === cfg.aimeMode));

  const virtualOn = cfg.aimeVirtual === 1;
  board.aimeVirtual.on.classList.toggle('on', virtualOn);
  board.aimeVirtual.off.classList.toggle('on', !virtualOn);

  const setToggle = (pair, on) => {
    pair.on.classList.toggle('on', on);
    pair.off.classList.toggle('on', !on);
  };
  setToggle(board.tweakMain, cfg.tweakMain === 1);
  setToggle(board.tweakAux, cfg.tweakAux === 1);
}

// --- Profiles --------------------------------------------------------------

// Saved configurations live in localStorage as an array of
// { name, savedAt (ISO), config } - config being a deep copy of the last C
// line the firmware published. Everything here is browser-side; nothing is
// written to flash until the user applies a profile and then saves.
const PROFILE_STORE_KEY = 'mpico-profiles';

// ~90 commands per apply. A short gap between them keeps the serial port from
// being flooded while still finishing in under two seconds.
const APPLY_DELAY_MS = 20;

let applying = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cloneConfig = (cfg) => (typeof structuredClone === 'function'
  ? structuredClone(cfg)
  : JSON.parse(JSON.stringify(cfg)));

function loadProfiles() {
  const raw = storageGet(PROFILE_STORE_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (error) {
    notify('Stored profiles were unreadable and have been ignored', 'warn');
    return [];
  }
}

function storeProfiles(list) {
  // Profiles embed a full config each: quota can genuinely run out, and a
  // silent failure would look like a saved profile that never existed.
  if (!storageSet(PROFILE_STORE_KEY, JSON.stringify(list))) {
    notify('Could not store profiles (browser storage unavailable or full)', 'warn');
  }
}

// A value is a profile if it carries a config object with the arrays
// buildApplyCommands indexes blindly (thr, map, rgbMap): a hand-edited import
// that lacks one of them would otherwise crash mid-apply, with commands
// already sent to the board.
function isProfile(value) {
  return Boolean(value) && typeof value === 'object'
    && Boolean(value.config) && typeof value.config === 'object'
    && Array.isArray(value.config.thr)
    && Array.isArray(value.config.map)
    && Array.isArray(value.config.rgbMap);
}

function makeButton(text, className, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  if (className) b.className = className;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

// Keep a name usable as a filename, without leaning on any one profile name.
function safeFileName(name) {
  return name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'profile';
}

function saveCurrentProfile(name) {
  const trimmed = name.trim();
  if (!trimmed) { notify('Enter a name for the profile', 'warn'); return; }
  if (!config) { notify('Connect the board before saving a profile', 'warn'); return; }

  const list = loadProfiles();
  const existing = list.findIndex((p) => p.name === trimmed);
  const profile = { name: trimmed, savedAt: new Date().toISOString(), config: cloneConfig(config) };

  if (existing >= 0) {
    if (!window.confirm(`A profile named "${trimmed}" already exists. Replace it?`)) return;
    list[existing] = profile;
  } else {
    list.push(profile);
  }
  storeProfiles(list);
  renderProfiles();
  els.profileName.value = '';
  notify(`Profile "${trimmed}" saved`);
}

function deleteProfile(name) {
  if (!window.confirm(`Delete profile "${name}"? This cannot be undone.`)) return;
  storeProfiles(loadProfiles().filter((p) => p.name !== name));
  renderProfiles();
  notify(`Profile "${name}" deleted`);
}

function exportProfile(profile) {
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `mpico-${safeFileName(profile.name)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Give an imported name a " (2)" suffix rather than overwrite a saved profile.
function uniqueName(base, list) {
  if (!list.some((p) => p.name === base)) return base;
  let n = 2;
  while (list.some((p) => p.name === `${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}

function importProfileFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch (error) {
      notify('That file is not valid JSON', 'warn');
      return;
    }
    if (!isProfile(parsed)) {
      notify('That file is not an MPico Extended profile', 'warn');
      return;
    }
    const list = loadProfiles();
    const name = uniqueName((parsed.name || 'Imported profile').trim() || 'Imported profile', list);
    list.push({ name, savedAt: parsed.savedAt || new Date().toISOString(), config: parsed.config });
    storeProfiles(list);
    renderProfiles();
    notify(`Profile "${name}" imported`);
  };
  reader.onerror = () => notify('Could not read that file', 'warn');
  reader.readAsText(file);
}

// The exact CLI sequence that reproduces a profile on the board. Order follows
// the config's own layout; baseline seeds the soft rate first, then drops back
// to hardware when that was the saved mode.
function buildApplyCommands(cfg) {
  const cmds = [];

  for (let z = 0; z < N_Z; z += 1) cmds.push(`thr ${zones[z]} ${cfg.thr[z]}`);

  cmds.push(`hyst ${cfg.hyst}`);
  cmds.push(`avg ${cfg.avg}`);
  cmds.push(`debounce ${cfg.debounceOn} ${cfg.debounceOff}`);

  const filter = decodeFilter(cfg.filter);
  cmds.push(`filter ${filter.ffi} ${filter.sfi} ${filter.esi}`);

  cmds.push(`gain ${cfg.gainCdc} ${cfg.gainCdt}`);

  cmds.push(`baseline soft ${cfg.rate}`);
  if (cfg.baselineMode !== 1) cmds.push('baseline hw');

  for (let e = 0; e < N_E; e += 1) {
    const zone = cfg.map[e] === UNMAPPED ? 'XX' : zones[cfg.map[e]];
    cmds.push(`touch ${Math.floor(e / PER_SENSOR)} ${e % PER_SENSOR} ${zone}`);
  }

  cmds.push(`level ${cfg.level}`);
  cmds.push(`rgb ${cfg.rgbButton} ${cfg.rgbCab} ${cfg.rgbBanner}`);

  if (cfg.rgbMap.every((v) => v === UNMAPPED)) {
    cmds.push('rgbmap reset');
  } else {
    const resolved = cfg.rgbMap.map((v, i) => (v === UNMAPPED ? RGB_DEFAULT_ORDER[i] : v));
    cmds.push(`rgbmap ${resolved.join(' ')}`);
  }

  cmds.push(`hid ${hidModeOf(cfg)}`);

  cmds.push(`aime mode ${cfg.aimeMode}`);
  cmds.push(`aime virtual ${cfg.aimeVirtual ? 'on' : 'off'}`);
  cmds.push(`tweak main_button_active_high ${cfg.tweakMain ? 'on' : 'off'}`);
  cmds.push(`tweak aux_button_active_high ${cfg.tweakAux ? 'on' : 'off'}`);

  return cmds;
}

async function applyProfile(profile) {
  if (!config) { notify('Connect the board before applying a profile', 'warn'); return; }
  if (!isProfile(profile)) { notify('This profile is missing its configuration', 'warn'); return; }
  if (applying) { notify('A profile is already being applied', 'warn'); return; }

  const cmds = buildApplyCommands(profile.config);
  applying = true;
  els.profileApply.hidden = false;

  for (let i = 0; i < cmds.length; i += 1) {
    send(cmds[i]);
    els.profileApplyProgress.textContent = `Applying ${profile.name}... ${i + 1}/${cmds.length}`;
    setHoldProgress(els.profileApplyBar, (i + 1) / cmds.length);
    // Deliberately serial: a small gap between commands paces the serial port.
    await sleep(APPLY_DELAY_MS);
  }

  els.profileApply.hidden = true;
  applying = false;
  notify(`Profile "${profile.name}" applied - Save to flash to keep it`, 'warn');
}

function buildThresholdView(cfg) {
  const section = document.createElement('div');
  section.className = 'profile-section';
  const heading = document.createElement('h4');
  heading.textContent = 'Thresholds by zone';
  section.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'profile-thr-grid';
  zones.forEach((zone, z) => {
    const chip = document.createElement('div');
    chip.className = 'profile-thr';
    const name = document.createElement('span');
    name.className = 'profile-thr-zone';
    name.textContent = zone;
    const value = document.createElement('b');
    value.textContent = cfg.thr[z];
    chip.append(name, value);
    grid.appendChild(chip);
  });
  section.appendChild(grid);
  return section;
}

function buildParamsView(cfg) {
  const section = document.createElement('div');
  section.className = 'profile-section';
  const heading = document.createElement('h4');
  heading.textContent = 'Processing & board';
  section.appendChild(heading);

  const filter = decodeFilter(cfg.filter);
  const hidMode = HID_MODE_LABEL[hidModeOf(cfg)];
  const mapped = cfg.map.filter((z) => z !== UNMAPPED).length;
  const rgbOrder = cfg.rgbMap.every((v) => v === UNMAPPED)
    ? 'default'
    : cfg.rgbMap.map((v, i) => (v === UNMAPPED ? RGB_DEFAULT_ORDER[i] : v)).join(' ');

  const rows = [
    ['Release margin (hyst)', `${cfg.hyst}%`],
    ['Averaging', cfg.avg > 1 ? `${cfg.avg} frames` : 'off'],
    ['Debounce', `on ${cfg.debounceOn}, off ${cfg.debounceOff}`],
    ['Filter (ffi/sfi/esi)', `${filter.ffi} / ${filter.sfi} / ${filter.esi}`],
    ['Gain (cdc/cdt)', `${cfg.gainCdc} / ${cfg.gainCdt}`],
    ['Baseline', cfg.baselineMode === 1 ? `software (rate ${cfg.rate})` : 'hardware'],
    ['Mapped electrodes', `${mapped} of ${N_E}`],
    ['Brightness (level)', String(cfg.level)],
    ['LED counts (button/cab/banner)', `${cfg.rgbButton} / ${cfg.rgbCab} / ${cfg.rgbBanner}`],
    ['Button LED order', rgbOrder],
    ['HID mode', hidMode],
    ['AIME mode', String(cfg.aimeMode)],
    ['Virtual AIC', cfg.aimeVirtual ? 'on' : 'off'],
    ['Main buttons active-high', cfg.tweakMain ? 'on' : 'off'],
    ['Aux buttons active-high', cfg.tweakAux ? 'on' : 'off'],
  ];

  const list = document.createElement('dl');
  list.className = 'profile-params';
  rows.forEach(([label, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  });
  section.appendChild(list);
  return section;
}

function openProfileView(profile) {
  if (!isProfile(profile)) { notify('This profile is missing its configuration', 'warn'); return; }
  els.profileDialogTitle.textContent = profile.name;
  els.profileDialogDate.textContent = formatDate(profile.savedAt);
  els.profileDialogBody.textContent = '';
  els.profileDialogBody.append(buildThresholdView(profile.config), buildParamsView(profile.config));
  els.profileDialog.showModal();
}

function buildProfileRow(profile) {
  const row = document.createElement('div');
  row.className = 'profile-item';

  const meta = document.createElement('div');
  meta.className = 'profile-meta';
  const name = document.createElement('span');
  name.className = 'profile-name';
  name.textContent = profile.name;
  const date = document.createElement('span');
  date.className = 'profile-date';
  date.textContent = formatDate(profile.savedAt);
  meta.append(name, date);

  const actions = document.createElement('div');
  actions.className = 'profile-actions';
  actions.append(
    makeButton('Apply', 'primary', () => applyProfile(profile)),
    makeButton('View', '', () => openProfileView(profile)),
    makeButton('Export', '', () => exportProfile(profile)),
    makeButton('Delete', 'danger', () => deleteProfile(profile.name)),
  );

  row.append(meta, actions);
  return row;
}

function renderProfiles() {
  const list = loadProfiles();
  els.profileList.textContent = '';
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'profile-empty';
    empty.textContent = 'No profiles saved yet. Save the current config above to start.';
    els.profileList.appendChild(empty);
    return;
  }
  list.forEach((profile) => els.profileList.appendChild(buildProfileRow(profile)));
}

els.profileSaveForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveCurrentProfile(els.profileName.value);
});
els.profileImport.addEventListener('click', () => els.profileImportInput.click());
els.profileImportInput.addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) importProfileFile(file);
  event.target.value = '';
});
els.profileDialogClose.addEventListener('click', () => els.profileDialog.close());

// --- Threshold and mapping tables ------------------------------------------

const rowRefs = new Map();   // zone -> { thresholdInput, mappingInput, cells }

// One compact cell: zone name (plus an optional top-right extra for mapping's
// sensor:channel), an editable number, and a live delta / gauge foot. Same refs
// shape as the old table row, so refreshConfig and the per-frame paint below are
// untouched. `cell.deviation` shows the live delta; `cell.gauge` is its bar.
function buildZoneCell(zone, value, min, max, withExtra, onCommit) {
  const cell = document.createElement('div');
  cell.className = 'zcell';
  cell.dataset.zone = zone;

  const top = document.createElement('div');
  top.className = 'zcell-top';
  const name = document.createElement('span');
  name.className = 'zcell-name';
  name.textContent = zone;
  top.appendChild(name);
  const extra = withExtra ? document.createElement('span') : null;
  if (extra) { extra.className = 'zcell-sc'; top.appendChild(extra); }
  cell.appendChild(top);

  const input = editableNumber(value, min, max, onCommit);
  cell.appendChild(input);

  // Same bar model as the Live cards: absolute barScale with a threshold
  // marker, so resting noise reads as a sliver instead of a jumpy fill
  // scaled to the threshold.
  const foot = document.createElement('div');
  foot.className = 'zcell-foot';
  const deviation = document.createElement('span');
  deviation.className = 'deviation';
  const bar = document.createElement('div');
  bar.className = 'cell-bar';
  const fill = document.createElement('span');
  fill.className = 'fill';
  const mark = document.createElement('span');
  mark.className = 'mark';
  bar.append(fill, mark);
  foot.append(deviation, bar);
  cell.appendChild(foot);

  return {
    root: cell,
    input,
    extra,
    cell: { deviation, fill, mark },
  };
}

// Lay the 34 zones out as small cells grouped by family (A1-A8, B1-B8, C1-C2,
// D1-D8, E1-E8), each family under its own label. `build(zone, z)` returns the
// cell root to place. Zones are already in family order, so a new group opens
// whenever the leading letter changes.
function buildZoneGrid(container, build) {
  container.textContent = '';
  let currentFamily = null;
  let grid = null;
  zones.forEach((zone, z) => {
    const family = zone[0];
    if (family !== currentFamily) {
      currentFamily = family;
      const group = document.createElement('div');
      group.className = 'zgrid-group';
      const heading = document.createElement('span');
      heading.className = 'zgrid-fam';
      heading.textContent = `Group ${family}`;
      group.appendChild(heading);
      grid = document.createElement('div');
      grid.className = 'zgrid';
      group.appendChild(grid);
      container.appendChild(group);
    }
    grid.appendChild(build(zone, z));
  });
}

function buildThresholdTable(cfg) {
  buildZoneGrid(els.thresholdRows, (zone, z) => {
    const built = buildZoneCell(zone, cfg.thr[z], 1, 1000, false,
      (v) => send(`thr ${zone} ${v}`));
    rowRefs.set(zone, { thresholdInput: built.input, cells: [built.cell] });
    return built.root;
  });
}

function buildMappingTable(cfg) {
  buildZoneGrid(els.mappingRows, (zone, z) => {
    const electrode = zoneToElectrode[z];
    // The number is the electrode (0..35); committing sends its sensor/channel.
    const built = buildZoneCell(zone, electrode < 0 ? '' : electrode, 0, N_E - 1, true,
      (v) => {
        const e = Number(v);
        if (!Number.isInteger(e) || e < 0 || e >= N_E) return;
        send(`touch ${Math.floor(e / PER_SENSOR)} ${e % PER_SENSOR} ${zone}`);
      });
    built.extra.textContent = electrode < 0 ? '-' : sensorChannel(electrode);

    const refs = rowRefs.get(zone) || {};
    refs.mappingInput = built.input;
    refs.mappingExtra = built.extra;
    refs.cells = [...(refs.cells || []), built.cell];
    rowRefs.set(zone, refs);
    return built.root;
  });
}

// --- Config refresh --------------------------------------------------------

function refreshConfig(cfg) {
  const first = config === null;
  if (config && !config.saved && cfg.saved) notify('Configuration saved to flash');
  config = cfg;

  // electrode -> zone (map) inverted to zone -> electrode.
  zoneToElectrode = new Array(N_Z).fill(-1);
  cfg.map.forEach((zone, electrode) => {
    if (zone !== UNMAPPED && zone < N_Z) zoneToElectrode[zone] = electrode;
  });

  els.saveBanner.hidden = cfg.saved;
  els.sidebarSave.hidden = cfg.saved;

  if (first) {
    buildProcessing();
    buildBoard();
    buildZoneCards();
    buildElectrodeCards();
    rowRefs.clear();
    buildThresholdTable(cfg);
    buildMappingTable(cfg);
  }
  refreshProcessing(cfg);
  refreshBoard(cfg);

  // Threshold-all slider starts from the board's own average, not a fixed value.
  const average = Math.round(cfg.thr.reduce((s, v) => s + v, 0) / cfg.thr.length);
  const uniform = cfg.thr.every((v) => v === cfg.thr[0]);
  if (els.thresholdAllValue !== editing) {
    els.thresholdAllValue.value = Math.min(Number(els.thresholdAllValue.max), average);
    els.thresholdAllOut.textContent = uniform ? String(average) : `${average} avg`;
  }

  // Zone cards carry their electrode; electrode cards carry their zone. Both
  // depend on the mapping, so they are refreshed here rather than every frame.
  zones.forEach((zone, z) => {
    const e = zoneToElectrode[z];
    if (zoneCells[z]) zoneCells[z].sub.textContent = e < 0 ? 'XX' : `E${e}`;
  });
  cfg.map.forEach((zone, e) => {
    if (electrodeCells[e]) {
      electrodeCells[e].sub.textContent = zone === UNMAPPED ? 'XX' : zones[zone];
    }
  });

  // Table inputs, never overwriting a field being edited.
  zones.forEach((zone, z) => {
    const refs = rowRefs.get(zone);
    if (!refs) return;
    if (refs.thresholdInput && refs.thresholdInput !== editing) {
      refs.thresholdInput.value = cfg.thr[z];
    }
    const e = zoneToElectrode[z];
    if (refs.mappingInput && refs.mappingInput !== editing) {
      refs.mappingInput.value = e < 0 ? '' : e;
    }
    if (refs.mappingExtra) refs.mappingExtra.textContent = e < 0 ? '-' : sensorChannel(e);
  });

  updateSparkLabel();
}

// --- Zone picker (Tuning + Mapping) ----------------------------------------

const thrPads = new Map();
const mapPads = new Map();
// Zone -> pad on the auto-calibration step-2 playfield copy (its own instance,
// independent of the Live / Tuning / Mapping discs).
const calibPressPads = new Map();

// Frames a single firmware trigger must be held continuously before a zone is
// remapped. The render pipeline runs at ~25 Hz, so ~35 frames is about 1.5 s -
// long enough that panel noise (which the firmware's threshold + hysteresis +
// debounce already reject) can never lock in an assignment on its own.
const HOLD_FRAMES = 35;

let selectedZone = null;
// Pending assignment. Shape: { zone, heldZone, frames } where zone is the target
// to remap to, heldZone is the firmware-triggered zone currently held (-1 if
// none/ambiguous) and frames counts consecutive held frames.
let learning = null;
let calibration = null;      // guided pass over every zone

function highlightSelected(zone) {
  [thrPads, mapPads].forEach((registry) => {
    registry.forEach((pad, name) => pad.classList.toggle('selected', name === zone));
  });
}

function openThresholdDialog(zone) {
  selectedZone = zone;
  highlightSelected(zone);
  renderThresholdDetail();
  if (config && !els.thrDialog.open) els.thrDialog.showModal();
}

function renderThresholdDetail() {
  if (!selectedZone || !config) return;
  const z = zones.indexOf(selectedZone);
  els.thrTitle.textContent = selectedZone;

  els.thrField.textContent = '';
  const input = editableNumber(config.thr[z], 1, 1000, (v) => {
    send(`thr ${selectedZone} ${v}`);
    els.thrSlider.value = Math.min(Number(els.thrSlider.max), Number(v));
  });
  els.thrField.appendChild(input);

  if (els.thrSlider !== editing) els.thrSlider.value = config.thr[z];
}

function selectZoneForMapping(zone) {
  if (calibration) return;   // the guided pass drives the selection itself
  selectedZone = zone;
  learning = null;
  highlightSelected(zone);
  if (zone && config) {
    renderZoneDetail();
    if (!els.dialog.open) els.dialog.showModal();
  }
}

function renderZoneDetail() {
  if (!selectedZone || !config) return;
  const z = zones.indexOf(selectedZone);
  const e = zoneToElectrode[z];
  els.dialogTitle.textContent = selectedZone;

  if (learning) {
    els.dialogStatus.textContent =
      `Press and hold ${selectedZone} firmly until it locks in.`;
    els.dialogStatus.className = 'dialog-status waiting';
    els.dialogListen.textContent = 'Cancel';
    els.dialogListen.className = '';
    els.dialogHold.hidden = false;
  } else {
    els.dialogStatus.textContent = e < 0
      ? 'No electrode assigned yet.'
      : `Currently reading electrode ${e} (${sensorChannel(e)}).`;
    els.dialogStatus.className = 'dialog-status';
    els.dialogListen.textContent = 'Start listening for touch';
    els.dialogListen.className = 'primary';
    els.dialogHold.hidden = true;
  }
  setHoldProgress(els.dialogHold, 0);

  els.dialogManual.textContent = '';
  const label = document.createElement('label');
  label.textContent = 'Electrode';
  const input = editableNumber(e < 0 ? '' : e, 0, N_E - 1, (v) => {
    const num = Number(v);
    if (!Number.isInteger(num) || num < 0 || num >= N_E) return;
    send(`touch ${Math.floor(num / PER_SENSOR)} ${num % PER_SENSOR} ${selectedZone}`);
  });
  els.dialogManual.append(label, input);
}

/** Fill a hold bar to a 0..1 fraction (dynamic value only, styled in CSS). */
function setHoldProgress(bar, fraction) {
  if (!bar) return;
  bar.style.setProperty('--hold', `${Math.round(Math.min(1, fraction) * 100)}%`);
}

/** While learning, assign the target zone to whichever electrode is driving the
 *  single firmware trigger held steadily for HOLD_FRAMES. The firmware bitmap
 *  (state.zonesActive) is already de-noised by threshold, hysteresis and
 *  debounce, so a real press-and-hold locks in while noise never does. */
function trackLearning() {
  if (!learning) return;

  // The firmware trigger(s) currently on. We want exactly one, unchanged.
  let activeZone = -1;
  let activeCount = 0;
  for (let z = 0; z < N_Z; z += 1) {
    if (state.zonesActive[z]) { activeZone = z; activeCount += 1; }
  }

  if (activeCount === 1 && activeZone === learning.heldZone) {
    learning.frames += 1;
  } else {
    // No trigger, several at once, or a different zone: restart the hold.
    learning.heldZone = activeCount === 1 ? activeZone : -1;
    learning.frames = activeCount === 1 ? 1 : 0;
  }

  const bar = calibration ? els.calibrateHold : els.dialogHold;
  setHoldProgress(bar, learning.frames / HOLD_FRAMES);

  if (learning.frames < HOLD_FRAMES) return;

  // Held long enough. The electrode feeding the pressed zone is the physical
  // sensor under the finger; remap it to the target zone.
  const electrode = zoneToElectrode[activeZone];
  if (electrode < 0) {
    // A triggered zone with no electrode should not happen; wait rather than
    // send a bad command.
    learning.frames = 0;
    setHoldProgress(bar, 0);
    return;
  }
  const target = learning.zone;
  send(`touch ${Math.floor(electrode / PER_SENSOR)} ${electrode % PER_SENSOR} ${target}`);
  learning = null;
  setHoldProgress(bar, 0);
  notify(`${target} mapped to electrode ${electrode} (${sensorChannel(electrode)})`);

  if (calibration) {
    calibration.done += 1;
    nextCalibrationZone();
  } else {
    renderZoneDetail();
  }
}

function renderCalibration() {
  els.calibrate.hidden = Boolean(calibration);
  els.calibrateStatus.hidden = !calibration;
  if (!calibration) return;
  els.calibrateZone.textContent =
    `Press and hold ${selectedZone} firmly until it locks in.`;
  els.calibrateProgress.textContent = `${calibration.done} of ${zones.length} assigned`;
  setHoldProgress(els.calibrateHold, 0);
}

function stopCalibration() {
  if (!calibration) return;
  calibration = null;
  learning = null;
  selectedZone = null;
  highlightSelected(null);
  renderCalibration();
}

function nextCalibrationZone() {
  if (!calibration || calibration.index >= zones.length) {
    const done = calibration ? calibration.done : 0;
    calibration = null;
    learning = null;
    selectedZone = null;
    highlightSelected(null);
    renderCalibration();
    notify(`Calibration finished, ${done} zone(s) assigned - use Save to flash`, 'warn');
    return;
  }
  const zone = zones[calibration.index];
  calibration.index += 1;
  selectedZone = zone;
  highlightSelected(zone);
  learning = { zone, heldZone: -1, frames: 0 };
  renderCalibration();
}

// --- Console ---------------------------------------------------------------

let lastConsole = null;

function consoleHtml(lines) {
  return lines.map((raw) => {
    const match = raw.match(PROMPT_RE);
    if (!match) return `<div class="log-line">${escapeHtml(raw)}</div>`;
    const prompt = `<span class="log-prompt">${escapeHtml(match[1])}</span>`;
    if (!match[2]) return `<div class="log-line log-bare">${prompt}</div>`;
    const command = `<span class="log-cmd">${escapeHtml(match[2])}</span>`;
    return `<div class="log-line log-entry">${prompt}${command}</div>`;
  }).join('');
}

// --- Logs (live per-zone stats + session recording) ------------------------

// Recording is started explicitly (Start/Stop button) and bounded so a
// forgotten session cannot grow without limit: 30000 samples is ~20 min at
// the ~25 Hz display rate. The live per-zone stats, by contrast, always run:
// they are a handful of numbers, not a sample stream.
const LOG_MAX_SAMPLES = 30000;
const LOG_RENDER_MS = 300;   // stats table / status refresh cadence (~3x/s)

// Per-zone running stats since the last reset. peak: highest delta ever seen;
// noiseCeil: highest delta while the zone was NOT firmware-active (standby
// noise floor); triggers: rising edges of the firmware active bitmap.
const logStats = Array.from({ length: N_Z }, () => ({
  peak: 0, noiseCeil: 0, triggers: 0,
}));
const logPrevActive = new Array(N_Z).fill(false);
const logRows = [];   // per-zone cell refs, index = zone position

const recording = { active: false, startedAt: 0, startIso: '', samples: [] };
let logLastRender = 0;

function buildLogTable() {
  els.logRows.textContent = '';
  logRows.length = 0;
  zones.forEach((zone, z) => {
    const row = document.createElement('tr');
    row.dataset.zone = zone;

    const name = document.createElement('td');
    name.className = 'zone-name';
    name.textContent = zone;

    const thr = document.createElement('td');
    const peak = document.createElement('td');
    const noise = document.createElement('td');
    const triggers = document.createElement('td');
    thr.textContent = '-';
    peak.textContent = '0';
    noise.textContent = '0';
    triggers.textContent = '0';

    row.append(name, thr, peak, noise, triggers);
    els.logRows.appendChild(row);
    logRows.push({ row, thr, peak, noise, triggers });
  });
}

// Called every frame from render() once config exists: update stats always,
// push a sample while recording, and refresh the table on a throttle so the
// DOM is not rebuilt at the full frame rate.
function logFrame(data) {
  for (let z = 0; z < N_Z; z += 1) {
    const e = zoneToElectrode[z];
    const delta = e >= 0 ? data.deltas[e] : 0;
    const active = data.zonesActive[z];
    const s = logStats[z];
    if (delta > s.peak) s.peak = delta;
    if (!active && delta > s.noiseCeil) s.noiseCeil = delta;
    if (active && !logPrevActive[z]) s.triggers += 1;
    logPrevActive[z] = active;
  }

  recordSample(data);   // no-op unless recording was started (Start button)

  // Stats collect every frame; the table itself only repaints when visible.
  const now = performance.now();
  if (activeSection === 'logs' && now - logLastRender >= LOG_RENDER_MS) {
    logLastRender = now;
    renderLogStats();
    updateRecordStatus();
  }
}

function recordSample(data) {
  if (!recording.active) return;
  if (!recording.samples.length) {
    recording.startedAt = performance.now();
    recording.startIso = new Date().toISOString();
  }
  const deltas = new Array(N_Z);
  const active = new Array(N_Z);
  for (let z = 0; z < N_Z; z += 1) {
    const e = zoneToElectrode[z];
    deltas[z] = e >= 0 ? data.deltas[e] : 0;
    active[z] = data.zonesActive[z] ? 1 : 0;
  }
  recording.samples.push({
    t: Math.round(performance.now() - recording.startedAt),
    deltas,
    active,
  });
  // Rolling window: drop the oldest sample once past the cap.
  if (recording.samples.length > LOG_MAX_SAMPLES) recording.samples.shift();
}

function renderLogStats() {
  for (let z = 0; z < N_Z; z += 1) {
    const cells = logRows[z];
    if (!cells) continue;
    const s = logStats[z];
    const thr = config ? config.thr[z] : null;
    cells.thr.textContent = thr == null ? '-' : thr;
    cells.peak.textContent = s.peak;
    cells.noise.textContent = s.noiseCeil;
    cells.triggers.textContent = s.triggers;
    cells.row.classList.toggle('noisy', thr != null && s.noiseCeil >= thr);
  }
}

function resetLogStats() {
  logStats.forEach((s) => { s.peak = 0; s.noiseCeil = 0; s.triggers = 0; });
  logPrevActive.fill(false);
  renderLogStats();
  notify('Live stats reset');
}

function updateRecordStatus() {
  const n = recording.samples.length;
  els.logRecCount.textContent = n;
  const ms = n > 1 ? recording.samples[n - 1].t - recording.samples[0].t : 0;
  els.logRecDuration.textContent = `${(ms / 1000).toFixed(1)} s`;
  els.logRecState.textContent = !recording.active ? (n ? 'stopped' : 'off')
    : (config ? 'recording' : 'waiting for board');
  els.logRecToggle.textContent = recording.active ? 'Stop recording' : 'Start recording';
  els.logRecToggle.classList.toggle('recording', recording.active);
}

// Start opens a fresh session: new sample clock, and (when auto-save is on) a
// fresh dated file, so one recording = one file on disk. Stop freezes the
// samples: they stay exportable until the next Start or Clear.
function toggleRecording() {
  if (recording.active) {
    recording.active = false;
    flushAutoSave();   // write the tail of the session to disk now
    updateRecordStatus();
    notify('Recording stopped');
    return;
  }
  recording.active = true;
  recording.samples = [];
  recording.startedAt = performance.now();
  recording.startIso = new Date().toISOString();
  autoSave.lastSampleT = -1;
  autoSave.fileName = '';
  autoSave.headerWritten = false;
  updateRecordStatus();
  notify('Recording started');
}

// Clear empties the current session (running or stopped) and restarts its clock.
function clearLog() {
  recording.samples = [];
  recording.startedAt = performance.now();
  recording.startIso = new Date().toISOString();
  // The sample clock restarts at 0, so the disk pointer (a sample.t) must too,
  // otherwise the fresh samples would look "already written" and be skipped.
  autoSave.lastSampleT = -1;
  updateRecordStatus();
  notify('Session log cleared');
}

// A timestamped, filename-safe name for an exported file.
function logFileName(kind, ext) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `mpico-${kind}-${stamp}.${ext}`;
}

function downloadFile(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Session-CSV row formats, shared by the manual export and the auto-save so both
// paths always agree on the header, the sample row, and the action-journal line.
function sessionCsvHeader() {
  return ['t_ms', ...zones, ...zones.map((zone) => `${zone}_on`)].join(',');
}

function sessionCsvRow(s) {
  return [s.t, ...s.deltas, ...s.active].join(',');
}

function sessionActionLine(a, t) {
  return `# ${t},${a.kind},"${a.text.replace(/"/g, '""')}"`;
}

function exportSessionCsv() {
  if (!recording.samples.length) { notify('Nothing recorded yet', 'warn'); return; }
  const lines = [sessionCsvHeader()];
  for (const s of recording.samples) lines.push(sessionCsvRow(s));
  // Trailing action journal (commented lines, same clock as t_ms). A negative
  // t_ms means the action happened before the first recorded sample.
  lines.push('', '# actions: t_ms,kind,text');
  for (const a of actionLog) {
    const t = Math.round(a.t - recording.startedAt);
    lines.push(sessionActionLine(a, t));
  }
  downloadFile(lines.join('\n'), 'text/csv', logFileName('session', 'csv'));
}

function exportSessionJson() {
  if (!recording.samples.length) { notify('Nothing recorded yet', 'warn'); return; }
  const last = recording.samples[recording.samples.length - 1];
  const payload = {
    recordedAt: recording.startIso,
    durationMs: last ? last.t : 0,
    zones: [...zones],
    samples: recording.samples,
    // Monitor-side actions on the same clock as samples.t; negative t = the
    // action happened before the first recorded sample.
    actions: actionLog.map((a) => ({
      t: Math.round(a.t - recording.startedAt),
      at: a.at,
      kind: a.kind,
      text: a.text,
    })),
  };
  downloadFile(JSON.stringify(payload), 'application/json', logFileName('session', 'json'));
}

function exportStatsCsv() {
  const header = ['zone', 'threshold', 'peak', 'noise_ceiling', 'triggers'];
  const lines = [header.join(',')];
  zones.forEach((zone, z) => {
    const s = logStats[z];
    const thr = config ? config.thr[z] : '';
    lines.push([zone, thr, s.peak, s.noiseCeil, s.triggers].join(','));
  });
  downloadFile(lines.join('\n'), 'text/csv', logFileName('stats', 'csv'));
}

function exportStatsJson() {
  const stats = zones.map((zone, z) => {
    const s = logStats[z];
    return {
      zone,
      threshold: config ? config.thr[z] : null,
      peak: s.peak,
      noiseCeil: s.noiseCeil,
      triggers: s.triggers,
    };
  });
  const payload = { recordedAt: new Date().toISOString(), stats };
  downloadFile(JSON.stringify(payload), 'application/json', logFileName('stats', 'json'));
}

els.logReset.addEventListener('click', resetLogStats);
els.logStatsCsv.addEventListener('click', exportStatsCsv);
els.logStatsJson.addEventListener('click', exportStatsJson);
els.logRecToggle.addEventListener('click', toggleRecording);
els.logRecord.addEventListener('click', clearLog);
els.logSessionCsv.addEventListener('click', exportSessionCsv);
els.logSessionJson.addEventListener('click', exportSessionJson);
els.trigClear.addEventListener('click', clearLastTriggers);

// --- Auto-save session logs to disk ----------------------------------------

// Mirrors the exported session CSV, but written continuously to a folder the
// user picks once (File System Access API). The directory handle is remembered
// in IndexedDB, so on a later visit the same folder is used with no re-pick,
// provided the browser still grants read/write permission.
const AUTOSAVE_DB = 'monitor-logs';
const AUTOSAVE_STORE = 'handles';
const AUTOSAVE_KEY = 'root';
const AUTOSAVE_FLUSH_MS = 60000;   // append new data at most once a minute

// status: 'unsupported' | 'off' | 'reauth' | 'active'.
//   off      - no folder chosen
//   reauth   - a folder is remembered but permission is 'prompt' (needs a click)
//   active   - saving; a file is created lazily on the first sample
const autoSave = {
  supported: typeof window !== 'undefined'
    && typeof window.showDirectoryPicker === 'function'
    && 'indexedDB' in window,
  handle: null,
  status: 'off',
  timer: null,
  fileName: '',        // frozen at the first flush that carries a sample
  year: '',
  month: '',
  headerWritten: false,
  lastSampleT: -1,          // sample.t of the last sample written to disk
  lastActionT: -Infinity,   // performance.now of the last action written
  writing: false,           // guard: never overlap two async writes
  warned: false,            // notify a write failure only once
};

// A write is never blocked on connection: while recording is on, samples
// accumulate in `recording` regardless of the visible tab, so the timer alone
// drives writes.

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AUTOSAVE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(AUTOSAVE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetHandle() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const req = db.transaction(AUTOSAVE_STORE, 'readonly')
      .objectStore(AUTOSAVE_STORE).get(AUTOSAVE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSetHandle(handle) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUTOSAVE_STORE, 'readwrite');
    tx.objectStore(AUTOSAVE_STORE).put(handle, AUTOSAVE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDeleteHandle() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUTOSAVE_STORE, 'readwrite');
    tx.objectStore(AUTOSAVE_STORE).delete(AUTOSAVE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Freeze the file name and its year/month folder on the first sample of this
// recording, so each recording lands in its own dated file.
function initAutoSaveFile() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  autoSave.year = String(d.getFullYear());
  autoSave.month = p(d.getMonth() + 1);
  autoSave.fileName = `mpico-session-${autoSave.year}-${autoSave.month}-`
    + `${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.csv`;
}

async function autoSaveFileHandle() {
  const yearDir = await autoSave.handle.getDirectoryHandle(autoSave.year, { create: true });
  const monthDir = await yearDir.getDirectoryHandle(autoSave.month, { create: true });
  return monthDir.getFileHandle(autoSave.fileName, { create: true });
}

function autoSaveStatusText() {
  if (autoSave.status === 'unsupported') {
    return 'Not supported: this needs Chrome or Edge.';
  }
  if (autoSave.status === 'off') {
    return 'Off. Choose a folder to save every session to disk automatically.';
  }
  if (autoSave.status === 'reauth') {
    return 'Paused: the browser needs permission again. Click Choose folder to allow it.';
  }
  return autoSave.fileName
    ? `Active: saving to ${autoSave.year}/${autoSave.month}/${autoSave.fileName}`
    : 'Active: a file is created on the next sample.';
}

function updateAutoSaveUi() {
  els.autosaveStatus.textContent = autoSaveStatusText();
  els.autosaveChoose.hidden = autoSave.status === 'unsupported';
  els.autosaveDisable.hidden = autoSave.status === 'unsupported' || autoSave.status === 'off';
}

function setAutoSaveStatus(status) {
  autoSave.status = status;
  updateAutoSaveUi();
}

function startAutoSaveTimer() {
  if (autoSave.timer) clearInterval(autoSave.timer);
  autoSave.timer = setInterval(() => { flushAutoSave(); }, AUTOSAVE_FLUSH_MS);
}

// Turn saving on for this page session: a fresh dated file, pointers rewound so
// the first flush captures everything recorded so far.
function activateAutoSave() {
  autoSave.fileName = '';
  autoSave.year = '';
  autoSave.month = '';
  autoSave.headerWritten = false;
  autoSave.lastSampleT = -1;
  autoSave.lastActionT = -Infinity;
  autoSave.warned = false;
  setAutoSaveStatus('active');
  startAutoSaveTimer();
  flushAutoSave();
}

// Append whatever is new since the last flush: sample rows first, then the new
// action-journal lines. The header is written only when the file is created.
async function flushAutoSave() {
  if (autoSave.status !== 'active' || !autoSave.handle || autoSave.writing) return;

  const newSamples = recording.samples.filter((s) => s.t > autoSave.lastSampleT);
  // The file is created on the first sample, never before: no empty files.
  if (!autoSave.fileName && !newSamples.length) return;
  const newActions = actionLog.filter((a) => a.t > autoSave.lastActionT);
  if (autoSave.fileName && !newSamples.length && !newActions.length) return;

  autoSave.writing = true;
  const firstCreate = !autoSave.fileName;
  try {
    if (!autoSave.fileName) initAutoSaveFile();
    const fileHandle = await autoSaveFileHandle();
    const existing = await fileHandle.getFile();
    const size = existing.size;

    const lines = [];
    if (!autoSave.headerWritten && size === 0) lines.push(sessionCsvHeader());
    for (const s of newSamples) lines.push(sessionCsvRow(s));
    for (const a of newActions) {
      const t = Math.round(a.t - recording.startedAt);
      lines.push(sessionActionLine(a, t));
    }

    if (lines.length) {
      const writable = await fileHandle.createWritable({ keepExistingData: true });
      await writable.seek(size);
      await writable.write(`${lines.join('\n')}\n`);
      await writable.close();
    }

    autoSave.headerWritten = true;
    if (newSamples.length) autoSave.lastSampleT = newSamples[newSamples.length - 1].t;
    if (newActions.length) autoSave.lastActionT = newActions[newActions.length - 1].t;
    if (firstCreate) updateAutoSaveUi();
  } catch {
    // A failed write must never break the monitor; warn once, keep trying.
    if (!autoSave.warned) {
      autoSave.warned = true;
      notify('Auto-save to disk failed', 'warn');
    }
  } finally {
    autoSave.writing = false;
  }
}

async function chooseAutoSaveFolder() {
  els.autosaveChoose.disabled = true;
  try {
    // A remembered folder in the 'prompt' state only needs its permission back:
    // the button click is the required user gesture, so re-picking is optional.
    if (autoSave.handle && autoSave.status === 'reauth') {
      const perm = await autoSave.handle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') { activateAutoSave(); return; }
    }
    const handle = await window.showDirectoryPicker({ id: 'mpico-logs', mode: 'readwrite' });
    autoSave.handle = handle;
    await idbSetHandle(handle);
    activateAutoSave();
  } catch (error) {
    if (error && error.name === 'AbortError') return;   // user dismissed the picker
    notify('Could not open the folder', 'warn');
  } finally {
    els.autosaveChoose.disabled = false;
  }
}

async function disableAutoSave() {
  if (autoSave.timer) { clearInterval(autoSave.timer); autoSave.timer = null; }
  autoSave.handle = null;
  autoSave.fileName = '';
  setAutoSaveStatus('off');
  try { await idbDeleteHandle(); } catch { /* nothing stored to remove */ }
}

async function initAutoSave() {
  if (!autoSave.supported) { setAutoSaveStatus('unsupported'); return; }
  els.autosaveChoose.addEventListener('click', chooseAutoSaveFolder);
  els.autosaveDisable.addEventListener('click', disableAutoSave);
  // Best-effort final append when the page goes away (reload, close, navigate).
  window.addEventListener('pagehide', () => { flushAutoSave(); });

  try {
    const handle = await idbGetHandle();
    if (!handle) { setAutoSaveStatus('off'); return; }
    autoSave.handle = handle;
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    // 'granted' resumes silently; anything else waits for a click to re-grant.
    if (perm === 'granted') activateAutoSave();
    else setAutoSaveStatus('reauth');
  } catch {
    setAutoSaveStatus('off');
  }
}

// --- Auto-calibration wizard -----------------------------------------------

// A guided pass that measures, per zone, the standby noise floor and the peak
// of a real press, then derives a threshold sitting above the noise and below
// the press. The outcome is a profile (reusing the profile store/apply code) -
// nothing is written to flash on its own. All measurement is driven from the
// render pipeline (calibFrame), active only while a measurement phase runs.

const CALIB_NOISE_MS = 15000;    // final standby noise window (untouched)
const CALIB_PRESS_TARGET = 3;    // prolonged presses that confirm a zone (auto)
const CALIB_QUICK_TARGET = 5;    // brief taps in the quickfire sub-phase
const CALIB_PRESS_HOLD = 5;      // frames a press must hold above the level (~200 ms)
const CALIB_PRESS_MARGIN = 8;    // floor of the detection margin over noise
const CALIB_MIN_MARGIN = 6;      // floor of the threshold margin over noise
const CALIB_RISKY_GAP = 12;      // press within this of noise -> "risky"
const CALIB_QUICK_RISKY_FRAC = 0.6;  // threshold above this fraction of quickfire -> risky

// Step 1 auto-tune sequence timings (all one 'noise' phase, driven by timestamp).
const CALIB_TUNE_REBASE_MS = 800;   // settle after the board reset (rebase)
const CALIB_TUNE_NATIVE_MS = 8000;  // native-noise measurement window
const CALIB_TUNE_SETTLE_MS = 500;   // settle after applying a trial parameter
const CALIB_TUNE_TRIAL_MS = 6000;   // per-trial measurement window
const CALIB_TUNE_IMPROVE = 0.2;     // worst noise must drop this fraction to keep a trial

// Step 4 (standby verify): a longer, more trustworthy watch that counts real
// firmware triggers (T lines) against the applied thresholds.
const CALIB_VERIFY_MS = 60000;   // standby verify window
const VERIFY_RAISE_MARGIN = 8;   // put a flagged threshold this far over noise/peak
const VERIFY_LOWER_MIN_GAP = 6;  // only suggest lowering if it drops by this much
const CALIB_REVERIFY_MAX = 6;    // cap on automatic re-verify passes

// Recommended global parameters seeded into step 3 when the step-1 auto-tune did
// not run. Debounce is the main anti-spike lever; the rest is a sane start.
const CALIB_PARAM_DEFAULTS = { debounceOn: 3, debounceOff: 3, avg: 2, hyst: 25 };

const calib = {
  phase: 'idle',        // 'idle' | 'noise' | 'press' | 'results'
  restorePending: null, // globals to re-apply after a disconnect mid step-1
  noiseCeil: new Array(N_Z).fill(0),
  noiseP95: new Array(N_Z).fill(0),
  pressPeak: new Array(N_Z).fill(null),   // null = zone not measured
  threshold: new Array(N_Z).fill(0),
  status: new Array(N_Z).fill('kept'),    // 'ok' | 'risky' | 'kept'
  pressOrder: [],       // mapped zone indices, in A1..E8 order
  pressState: new Array(N_Z).fill('pending'),  // 'pending'|'measured'|'skipped'
  pressChips: [],       // one selectable chip per mapped zone
  pressPos: 0,          // position in pressOrder of the targeted zone
  pressZone: -1,        // targeted zone index
  pressMax: 0,          // strongest delta in the current session (firm press)
  pressCount: 0,        // completed prolonged presses this session
  pressHeld: 0,         // frames held above the detection level
  pressInPress: false,  // a hold has been confirmed, awaiting release
  pressSub: 'long',     // 'long' (firm presses) | 'quick' (brief taps)
  quickfire: new Array(N_Z).fill(null),   // median of the brief-tap peaks per zone
  quickCount: 0,        // taps counted in the current quick sub-phase
  quickPeaks: [],       // per-tap peaks in the current quick sub-phase
  quickInTap: false,    // a tap is in progress (delta above the level)
  quickTapPeak: 0,      // strongest delta in the current tap
  advanceMode: 'auto',  // 'auto' | 'manual'
  paramInputs: {},      // editable param fields, built once
  mapAlertE: -1,        // electrode flagged as answering for another zone (-1 none)
  verifyCeil: new Array(N_Z).fill(0),   // delta ceiling over the verify window
  verifyTrig: new Array(N_Z).fill(0),   // real firmware triggers (T) during verify
  verifyPeak: new Array(N_Z).fill(0),   // strongest T peak during verify
  verifyLiveDirty: false,               // repaint the live triggered-zones list
  verifyEndsAt: 0,
  verifyAdjust: [],     // pending {zone,current,suggested,dir,reason,warn}
  reverify: { active: false, pass: 0 }, // Apply & re-verify loop state
  // Step-1 auto-tune. `saved` holds the globals to restore on cancel; `tuned`
  // (once measured) seeds the step-3 recommended parameters.
  tune: {
    step: 'idle',       // idle|rebase|native|settle|trial|final|done
    until: 0,
    peak: new Array(N_Z).fill(0),
    samples: Array.from({ length: N_Z }, () => []),
    cur: { avg: 1, debounceOn: 1 },
    best: Infinity,
    trials: [],
    trialIdx: 0,
    pending: null,
  },
  tuneSaved: null,      // { avg, debounceOn, debounceOff } or null
  tuned: null,          // { avg, debounceOn, debounceOff, hyst } or null
};

// Calibration DOM, kept local so the shared els object stays focused.
const cel = {
  steps: document.getElementById('calib-steps'),
  rebase: document.getElementById('calib-rebase'),
  noiseStart: document.getElementById('calib-noise-start'),
  noiseProgress: document.getElementById('calib-noise-progress'),
  noiseBar: document.getElementById('calib-noise-bar'),
  noiseCount: document.getElementById('calib-noise-count'),
  console: document.getElementById('calib-console'),
  traceAllWrap: document.getElementById('calib-trace-all-wrap'),
  traceAll: document.getElementById('calib-trace-all'),
  pressTrace: document.getElementById('calib-press-trace'),
  pressDisc: document.getElementById('calib-press-disc'),
  sound: document.getElementById('calib-sound'),
  mapAlert: document.getElementById('calib-map-alert'),
  mapAlertText: document.getElementById('calib-map-alert-text'),
  mapAlertRemap: document.getElementById('calib-map-alert-remap'),
  pressInstr: document.getElementById('calib-press-instr'),
  advAuto: document.getElementById('calib-adv-auto'),
  advManual: document.getElementById('calib-adv-manual'),
  advHint: document.getElementById('calib-advance-hint'),
  pressZone: document.getElementById('calib-press-zone'),
  pressMax: document.getElementById('calib-press-max'),
  pressCount: document.getElementById('calib-press-count'),
  pressProgress: document.getElementById('calib-press-progress'),
  zoneStrip: document.getElementById('calib-zone-strip'),
  pressBar: document.getElementById('calib-press-bar'),
  pressPrev: document.getElementById('calib-press-prev'),
  pressNext: document.getElementById('calib-press-next'),
  pressSkip: document.getElementById('calib-press-skip'),
  pressFinish: document.getElementById('calib-press-finish'),
  stop: document.getElementById('calib-stop'),
  resultRows: document.getElementById('calib-result-rows'),
  params: document.getElementById('calib-params'),
  paramsOrigin: document.getElementById('calib-params-origin'),
  toVerify: document.getElementById('calib-to-verify'),
  toProfile: document.getElementById('calib-to-profile'),
  verifyStart: document.getElementById('calib-verify-start'),
  verifySkip: document.getElementById('calib-verify-skip'),
  verifyProgress: document.getElementById('calib-verify-progress'),
  verifyBar: document.getElementById('calib-verify-bar'),
  verifyCount: document.getElementById('calib-verify-count'),
  verifyLive: document.getElementById('calib-verify-live'),
  verifyTraceAll: document.getElementById('calib-verify-trace-all'),
  verifyLiveEmpty: document.getElementById('calib-verify-live-empty'),
  verifyLiveWrap: document.getElementById('calib-verify-live-wrap'),
  verifyLiveRows: document.getElementById('calib-verify-live-rows'),
  verifyResults: document.getElementById('calib-verify-results'),
  verifySummary: document.getElementById('calib-verify-summary'),
  verifyRows: document.getElementById('calib-verify-rows'),
  verifyAdjustActions: document.getElementById('calib-verify-adjust-actions'),
  verifyTable: document.getElementById('calib-verify-table'),
  verifyApply: document.getElementById('calib-verify-apply'),
  verifyReverify: document.getElementById('calib-verify-reverify'),
  verifyRecheck: document.getElementById('calib-verify-recheck'),
  verifyToProfile: document.getElementById('calib-verify-to-profile'),
  profileForm: document.getElementById('calib-profile-form'),
  profileName: document.getElementById('calib-profile-name'),
  applyNow: document.getElementById('calib-apply-now'),
};

const clampThr = (v) => Math.min(1000, Math.max(1, Math.round(v)));

// Approximate percentile from a sample array (sort once, nearest-rank).
function calibPercentile(samples, p) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[idx];
}

// Show one wizard step, hide the rest, and light its marker in the step list.
function calibShowStep(step) {
  document.querySelectorAll('.calib-step').forEach((el) => {
    el.hidden = Number(el.dataset.step) !== step;
  });
  cel.steps.querySelectorAll('li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('active', n === step);
    li.classList.toggle('done', n < step);
  });
}

// --- Wizard sound and action log -------------------------------------------

// Beeps (Web Audio) and spoken zone names, both optional. The AudioContext is
// created lazily on the first user gesture (the Start button, the toggle) so an
// autoplay policy never silently blocks it.
const CALIB_SOUND_KEY = 'mpico-calib-sound';
let calibSoundOn = storageGet(CALIB_SOUND_KEY) !== '0';   // default on
let calibAudioCtx = null;

function calibAudio() {
  if (!calibSoundOn) return null;
  if (!calibAudioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try { calibAudioCtx = new Ctx(); } catch { return null; }
  }
  if (calibAudioCtx.state === 'suspended') calibAudioCtx.resume().catch(() => {});
  return calibAudioCtx;
}

function calibBeep(freq = 880, dur = 0.06) {
  const ctx = calibAudio();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  const t0 = ctx.currentTime;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// Two quick higher beeps: a zone is done.
function calibBeepDone() {
  calibBeep(1320, 0.07);
  setTimeout(() => calibBeep(1660, 0.07), 90);
}

// Speak text; zone names are passed letter-then-digit ("A 1") so they read out
// as "A one" rather than "A-teen".
function calibSpeak(text) {
  if (!calibSoundOn || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';   // zone names read in English whatever the browser locale
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch { /* speech unavailable, ignore */ }
}

const calibZoneSpeech = (name) => name.split('').join(' ');

function calibSetSound(on) {
  calibSoundOn = on;
  storageSet(CALIB_SOUND_KEY, on ? '1' : '0');
  cel.sound.classList.toggle('on', on);
  cel.sound.textContent = on ? 'Sound on' : 'Sound off';
  if (!on && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  }
}

// Timestamped action log for the step-1 auto-tune console.
function calibLogClear() {
  cel.console.textContent = '';
}

function calibLog(message) {
  const line = document.createElement('div');
  line.className = 'calib-log-line';
  line.textContent = `[${clockStamp()}] ${message}`;
  cel.console.appendChild(line);
  while (cel.console.childElementCount > 200) cel.console.removeChild(cel.console.firstChild);
  cel.console.scrollTop = cel.console.scrollHeight;
}

// Restore the globals changed for native measurement. Called on cancel; a
// normal finish keeps the tuned values live (they are what we recommend).
function calibRestoreGlobals() {
  const s = calib.tuneSaved;
  if (!s) return;
  send(`avg ${s.avg}`);
  send(`debounce ${s.debounceOn} ${s.debounceOff}`);
  calib.tuneSaved = null;
}

// Clear every measurement and return to the idle first step. Does NOT touch the
// board (see calibRestoreGlobals) or the saved globals, so an internal reset in
// the middle of the wizard cannot lose the originals.
function calibReset() {
  calib.phase = 'idle';
  calib.noiseCeil.fill(0);
  calib.noiseP95.fill(0);
  calib.pressPeak.fill(null);
  calib.quickfire.fill(null);
  calib.threshold.fill(0);
  calib.status.fill('kept');
  calib.pressState.fill('pending');
  calib.pressOrder = [];
  calib.pressChips = [];
  calib.pressPos = 0;
  calib.pressZone = -1;
  calib.pressMax = 0;
  calib.pressCount = 0;
  calib.pressHeld = 0;
  calib.pressInPress = false;
  calib.pressSub = 'long';
  calib.quickCount = 0;
  calib.quickPeaks = [];
  calib.quickInTap = false;
  calib.quickTapPeak = 0;
  calib.mapAlertE = -1;
  calib.verifyCeil.fill(0);
  calib.verifyTrig.fill(0);
  calib.verifyPeak.fill(0);
  calib.verifyAdjust = [];
  calib.reverify.active = false;
  calib.reverify.pass = 0;
  calib.tuned = null;
  calibResetTune();
  cel.zoneStrip.textContent = '';
  cel.noiseProgress.hidden = true;
  cel.noiseStart.disabled = false;
  cel.mapAlert.hidden = true;
  cel.verifyProgress.hidden = true;
  cel.verifyLive.hidden = true;
  cel.verifyResults.hidden = true;
  cel.verifyStart.disabled = false;
  calibPressBuffer.length = 0;
  setHoldProgress(cel.noiseBar, 0);
  setHoldProgress(cel.verifyBar, 0);
  calibSetAdvance('auto');
  calibShowStep(1);
}

function calibResetTune() {
  const t = calib.tune;
  t.step = 'idle';
  t.until = 0;
  t.peak.fill(0);
  t.samples.forEach((a) => { a.length = 0; });
  t.cur = { avg: 1, debounceOn: 1 };
  t.best = Infinity;
  t.trials = [];
  t.trialIdx = 0;
  t.pending = null;
  cel.console.textContent = '';
  cel.console.hidden = true;
  cel.traceAllWrap.hidden = true;
}

function calibStop() {
  const wasMeasuring = calib.phase === 'noise' || calib.phase === 'press'
    || calib.phase === 'verify';
  calibRestoreGlobals();
  calibReset();
  if (wasMeasuring) notify('Calibration stopped, measurements discarded', 'warn');
}

// --- Step 1: reset, native noise, auto-tune --------------------------------

// The whole step-1 sequence runs under phase 'noise', dispatched by tune.step
// from calibNoiseFrame on a wall-clock timer. It resets the board, measures the
// native noise, tries a few reactivity-first parameter changes, and ends with a
// long final noise pass that fixes each zone's floor.

function calibStartNoise() {
  if (!config) { notify('Connect the board before calibrating', 'warn'); return; }
  calibReset();
  calibAudio();   // unlock audio on this user gesture
  calib.phase = 'noise';
  // Save the globals to restore on cancel (only if not already saved by a run
  // still in progress, so the true originals survive a re-run).
  if (!calib.tuneSaved) {
    calib.tuneSaved = {
      avg: config.avg,
      debounceOn: config.debounceOn,
      debounceOff: config.debounceOff,
    };
  }
  cel.console.hidden = false;
  cel.traceAllWrap.hidden = false;
  cel.noiseProgress.hidden = false;
  cel.noiseStart.disabled = true;
  calibLogClear();
  calibLog('reset board (rebase)');
  send('rebase');
  calibTuneEnter('rebase', CALIB_TUNE_REBASE_MS);
}

const CALIB_TUNE_WINDOW = {
  rebase: CALIB_TUNE_REBASE_MS,
  native: CALIB_TUNE_NATIVE_MS,
  settle: CALIB_TUNE_SETTLE_MS,
  trial: CALIB_TUNE_TRIAL_MS,
  final: CALIB_NOISE_MS,
};

function calibTuneEnter(step, ms) {
  calib.tune.step = step;
  calib.tune.until = performance.now() + ms;
}

function calibTuneResetWindow() {
  calib.tune.peak.fill(0);
  calib.tune.samples.forEach((a) => { a.length = 0; });
}

// Worst (highest) per-zone peak across all mapped zones in the current window.
function calibTuneWorst() {
  let worst = 0;
  let zone = -1;
  for (let z = 0; z < N_Z; z += 1) {
    if (zoneToElectrode[z] < 0) continue;
    if (calib.tune.peak[z] > worst) { worst = calib.tune.peak[z]; zone = z; }
  }
  return { worst, zone };
}

function calibTuneStatusText(step, remaining) {
  const secs = Math.ceil(remaining / 1000);
  if (step === 'rebase') return 'resetting the board...';
  if (step === 'native') return `measuring native noise - ${secs} s`;
  if (step === 'settle') return 'applying parameter...';
  if (step === 'trial') return `testing a parameter - ${secs} s`;
  return `${secs} s left - do not touch the panel`;
}

function calibNoiseFrame(data) {
  const t = calib.tune;
  // Every mapped zone, no active-exclusion: during the whole sequence nothing is
  // touched, so any activity is noise we must see.
  for (let z = 0; z < N_Z; z += 1) {
    const e = zoneToElectrode[z];
    if (e < 0) continue;
    const delta = data.deltas[e];
    if (delta > t.peak[z]) t.peak[z] = delta;
    if (t.step === 'final') t.samples[z].push(delta);
  }
  const now = performance.now();
  const remaining = Math.max(0, t.until - now);
  const window = CALIB_TUNE_WINDOW[t.step] || 1;
  setHoldProgress(cel.noiseBar, 1 - remaining / window);
  cel.noiseCount.textContent = calibTuneStatusText(t.step, remaining);
  if (now < t.until) return;
  calibTuneAdvance();
}

// Move the auto-tune to its next stage once the current window elapsed.
function calibTuneAdvance() {
  const t = calib.tune;
  if (t.step === 'rebase') {
    send('avg 1');
    calibLog(`edit param avg: ${calib.tuneSaved.avg} → 1`);
    send('debounce 1 3');
    calibLog(`edit param debounce_on: ${calib.tuneSaved.debounceOn} → 1`);
    t.cur = { avg: 1, debounceOn: 1 };
    calibTuneResetWindow();
    calibTuneEnter('native', CALIB_TUNE_NATIVE_MS);
    return;
  }
  if (t.step === 'native') {
    const { worst, zone } = calibTuneWorst();
    t.best = worst;
    calibLog(`checking noise → worst ${zone >= 0 ? zones[zone] : '-'}=${worst}`);
    t.trials = [
      { param: 'avg', label: 'avg', value: 2 },
      { param: 'avg', label: 'avg', value: 3 },
      { param: 'debounceOn', label: 'debounce_on', value: 2 },
    ];
    t.trialIdx = 0;
    calibTuneStartTrial();
    return;
  }
  if (t.step === 'settle') {
    calibTuneResetWindow();
    calibTuneEnter('trial', CALIB_TUNE_TRIAL_MS);
    return;
  }
  if (t.step === 'trial') {
    calibTuneEvalTrial();
    return;
  }
  if (t.step === 'final') {
    calibTuneFinish();
  }
}

function calibTuneSetCmd(tr) {
  if (tr.param === 'avg') return `avg ${tr.value}`;
  return `debounce ${tr.value} 3`;
}

function calibTuneStartTrial() {
  const t = calib.tune;
  if (t.trialIdx >= t.trials.length) {
    calibLog('final noise measurement (15 s) - do not touch the panel');
    calibTuneResetWindow();
    calibTuneEnter('final', CALIB_NOISE_MS);
    return;
  }
  const tr = t.trials[t.trialIdx];
  t.pending = tr;
  const before = tr.param === 'avg' ? t.cur.avg : t.cur.debounceOn;
  if (tr.value <= before) {   // already at/above this value, nothing to try
    t.trialIdx += 1;
    calibTuneStartTrial();
    return;
  }
  calibLog(`edit param ${tr.label}: ${before} → ${tr.value}`);
  send(calibTuneSetCmd(tr));
  calibTuneEnter('settle', CALIB_TUNE_SETTLE_MS);
}

function calibTuneEvalTrial() {
  const t = calib.tune;
  const tr = t.pending;
  const { worst } = calibTuneWorst();
  const before = tr.param === 'avg' ? t.cur.avg : t.cur.debounceOn;
  if (worst <= t.best * (1 - CALIB_TUNE_IMPROVE)) {
    t.best = worst;
    if (tr.param === 'avg') t.cur.avg = tr.value; else t.cur.debounceOn = tr.value;
    calibLog(`checking noise → max ${worst}; clearly quieter - keeping ${tr.label} ${tr.value}`);
  } else {
    // Revert to the retained value: reactivity wins ties.
    if (tr.param === 'avg') send(`avg ${t.cur.avg}`);
    else send(`debounce ${t.cur.debounceOn} 3`);
    calibLog(`checking noise → max ${worst}; not much difference; we prefer reactivity - keeping ${tr.label} ${before}`);
  }
  t.trialIdx += 1;
  calibTuneStartTrial();
}

function calibTuneFinish() {
  const t = calib.tune;
  for (let z = 0; z < N_Z; z += 1) {
    calib.noiseCeil[z] = t.peak[z];
    calib.noiseP95[z] = calibPercentile(t.samples[z], 0.95);
    t.samples[z].length = 0;
  }
  calib.tuned = { avg: t.cur.avg, debounceOn: t.cur.debounceOn, debounceOff: 3, hyst: 25 };
  calibLog(`done - kept avg ${t.cur.avg}, debounce_on ${t.cur.debounceOn}`);
  t.step = 'done';
  cel.noiseProgress.hidden = true;
  calibStartPress();
}

// --- Step 2: press force per zone (user-paced, navigable) ------------------

// Advance mode: Auto moves on once CALIB_PRESS_TARGET presses are counted;
// Manual never advances on its own. Both keep Previous / Next / Skip / Finish.
function calibSetAdvance(mode) {
  calib.advanceMode = mode;
  cel.advAuto.classList.toggle('on', mode === 'auto');
  cel.advManual.classList.toggle('on', mode === 'manual');
  cel.advHint.textContent = mode === 'auto'
    ? `Auto: moves on after ${CALIB_PRESS_TARGET} presses.`
    : 'Manual: stays on the zone; use Next when done.';
}

function calibStartPress() {
  // Every zone, mapped or not: an unmapped zone is exactly the case where the
  // step-2 mapping watch is needed (press its physical pad, get the Remap).
  calib.pressOrder = [];
  for (let z = 0; z < N_Z; z += 1) calib.pressOrder.push(z);
  calib.phase = 'press';
  calib.pressState.fill('pending');
  calib.pressPeak.fill(null);
  calibShowStep(2);
  calibBuildZoneStrip();
  calibGoTo(0);
}

// One clickable chip per mapped zone, so any zone can be revisited later.
function calibBuildZoneStrip() {
  cel.zoneStrip.textContent = '';
  calib.pressChips = [];
  calib.pressOrder.forEach((z, pos) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'calib-chip';
    chip.textContent = zones[z];
    chip.addEventListener('click', () => calibJumpTo(pos));
    cel.zoneStrip.appendChild(chip);
    calib.pressChips.push(chip);
  });
}

// Highlight the targeted zone on the step-2 playfield copy. Event-driven (set
// on every zone change), so it persists across frames and through the quick-tap
// sub-phase, which keeps the same zone.
function calibPaintDiscTarget() {
  const targetName = calib.pressZone >= 0 ? zones[calib.pressZone] : null;
  calibPressPads.forEach((pad, zone) => pad.classList.toggle('target', zone === targetName));
}

// Reflect each zone's status; the targeted zone is always shown as current.
function calibRenderZoneStrip() {
  calib.pressOrder.forEach((z, pos) => {
    const chip = calib.pressChips[pos];
    if (!chip) return;
    const state = pos === calib.pressPos ? 'current' : calib.pressState[z];
    chip.className = `calib-chip calib-chip-${state}`;
  });
}

// Clear the live session on the targeted zone, ready for a fresh measurement.
function calibResetZoneSession() {
  calib.pressMax = 0;
  calib.pressCount = 0;
  calib.pressHeld = 0;
  calib.pressInPress = false;
  calib.pressSub = 'long';
  calib.quickCount = 0;
  calib.quickPeaks = [];
  calib.quickInTap = false;
  calib.quickTapPeak = 0;
  calibPressBuffer.length = 0;
  cel.pressMax.textContent = '0';
  cel.pressCount.textContent = `0 / ${CALIB_PRESS_TARGET}`;
  setHoldProgress(cel.pressBar, 0);
}

// Target a zone by position: starts a clean session on it and updates the UI.
function calibGoTo(pos) {
  calib.pressPos = pos;
  calib.pressZone = calib.pressOrder[pos];
  calibResetZoneSession();
  calibClearMapAlert();
  cel.pressZone.textContent = zones[calib.pressZone];
  cel.pressProgress.textContent = `Zone ${pos + 1} of ${calib.pressOrder.length}`;
  cel.pressInstr.textContent = zoneToElectrode[calib.pressZone] < 0
    ? `${zones[calib.pressZone]} has no electrode assigned: press its physical pad, then use Remap in the alert below.`
    : `Press and release ${zones[calib.pressZone]} firmly, at your own pace.`;
  cel.pressPrev.disabled = pos === 0;
  calibRenderZoneStrip();
  calibPaintDiscTarget();
  // Announce the zone and the phase it opens on (firm presses); the quick-taps
  // sub-phase announces itself when it starts.
  calibSpeak(`${calibZoneSpeech(zones[calib.pressZone])}, long press`);
}

const calibMedian = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// After the firm presses, the same session records five brief taps (a delta
// crossing the level then falling, no hold). The median tap peak is the zone's
// "quickfire" - the real in-game gesture the threshold must stay under.
function calibEnterQuick() {
  calibRecordPress();   // lock the firm-press peak before the taps
  calib.pressSub = 'quick';
  calib.quickCount = 0;
  calib.quickPeaks = [];
  calib.quickInTap = false;
  calib.quickTapPeak = 0;
  cel.pressInstr.textContent =
    `Now tap ${zones[calib.pressZone]} briefly ${CALIB_QUICK_TARGET} times (about once per second). `
    + 'Quick taps mirror real play: a brief press leaves a weaker signal, '
    + 'and that is what this refines.';
  cel.pressCount.textContent = `0 / ${CALIB_QUICK_TARGET} taps`;
  setHoldProgress(cel.pressBar, 0);
  calibSpeak('quick taps');
}

// Commit the current session's peak, but only when a press actually happened,
// so backing out of a zone never wipes an earlier measurement with a zero.
function calibRecordPress() {
  if (calib.pressMax > 0) {
    calib.pressPeak[calib.pressZone] = calib.pressMax;
    calib.pressState[calib.pressZone] = 'measured';
  }
}

// Jump to a zone from the strip. Clicking the current zone restarts its
// measurement; clicking another commits the current one first.
function calibJumpTo(pos) {
  if (calib.phase !== 'press') return;
  if (pos === calib.pressPos) { calibResetZoneSession(); return; }
  calibRecordPress();
  calibGoTo(pos);
}

// Move to the next zone, or finish once the last one is committed.
function calibAdvance() {
  if (calib.pressPos >= calib.pressOrder.length - 1) { calibFinishPress(); return; }
  calibGoTo(calib.pressPos + 1);
}

// The detection level a delta must clear to count as a press or tap on a zone.
function calibPressLevel(z) {
  return calib.noiseCeil[z]
    + Math.max(CALIB_PRESS_MARGIN, Math.round(0.5 * calib.noiseCeil[z]));
}

function calibPressFrame(data) {
  const z = calib.pressZone;
  const e = zoneToElectrode[z];
  // The mapping watch runs even when the targeted zone has no electrode yet:
  // pressing its physical pad lights up whichever electrode it is wired to,
  // and the alert offers the remap.
  calibCheckMapping(data, z);
  if (e < 0) return;
  const delta = data.deltas[e];

  // Per-zone trace buffer for the wizard's targeted-zone trace.
  calibPressBuffer.push(delta);
  while (calibPressBuffer.length > SPARK_LEN) calibPressBuffer.shift();

  if (delta > calib.pressMax) {
    calib.pressMax = delta;
    cel.pressMax.textContent = delta;
  }

  const level = calibPressLevel(z);
  if (calib.pressSub === 'long') {
    // Prolonged-press detection: the delta rises a clear margin above the zone's
    // measured noise (or the firmware calls it active), holds CALIB_PRESS_HOLD
    // frames, then falls back below the level -> one counted press.
    if (delta >= level || data.zonesActive[z]) {
      calib.pressHeld += 1;
      if (calib.pressHeld >= CALIB_PRESS_HOLD) calib.pressInPress = true;
    } else {
      if (calib.pressInPress) {
        calib.pressCount += 1;
        calibBeep();
        cel.pressCount.textContent = `${calib.pressCount} / ${CALIB_PRESS_TARGET}`;
        setHoldProgress(cel.pressBar, calib.pressCount / CALIB_PRESS_TARGET);
        if (calib.advanceMode === 'auto' && calib.pressCount >= CALIB_PRESS_TARGET) {
          calibEnterQuick();
          return;
        }
      }
      calib.pressHeld = 0;
      calib.pressInPress = false;
    }
  } else {
    // Quick taps: a delta crossing the level then falling, no hold requirement.
    if (delta >= level) {
      calib.quickInTap = true;
      if (delta > calib.quickTapPeak) calib.quickTapPeak = delta;
    } else if (calib.quickInTap) {
      calib.quickPeaks.push(calib.quickTapPeak);
      calib.quickCount += 1;
      calibBeep();
      calib.quickInTap = false;
      calib.quickTapPeak = 0;
      cel.pressCount.textContent = `${calib.quickCount} / ${CALIB_QUICK_TARGET} taps`;
      setHoldProgress(cel.pressBar, calib.quickCount / CALIB_QUICK_TARGET);
      if (calib.quickCount >= CALIB_QUICK_TARGET) {
        calib.quickfire[z] = calibMedian(calib.quickPeaks);
        calibBeepDone();
        calibRecordPress();
        if (calib.advanceMode === 'auto') { calibAdvance(); return; }
      }
    }
  }
}

// Passive mapping check: if a pad other than the targeted one answers strongest
// (above the level), flag it with a one-click remap. Non-blocking. Unmapped
// electrodes are scanned too: they are the prime remap candidates.
function calibCheckMapping(data, z) {
  if (!config) return;
  const level = calibPressLevel(z);
  const targetE = zoneToElectrode[z];
  let strongE = -1;
  let strongD = 0;
  for (let e = 0; e < N_E; e += 1) {
    const d = data.deltas[e];
    if (d > strongD) { strongD = d; strongE = e; }
  }
  // The correct pad answering clears any earlier alert.
  if (targetE >= 0 && data.deltas[targetE] >= level
    && (strongE === targetE || strongD < level)) {
    calibClearMapAlert();
    return;
  }
  if (strongE >= 0 && strongE !== targetE && strongD >= level) {
    calibShowMapAlert(strongE);
  }
}

function calibShowMapAlert(e) {
  if (calib.mapAlertE === e) return;
  calib.mapAlertE = e;
  // An unmapped electrode is named by its sensor:channel, never `E<n>`, which
  // would read as one of the E1-E8 zones.
  const source = config.map[e] === UNMAPPED
    ? `unassigned electrode ${sensorChannel(e)}`
    : zones[config.map[e]];
  cel.mapAlertText.textContent = `Response detected on ${source} - check mapping`;
  cel.mapAlert.hidden = false;
}

function calibClearMapAlert() {
  if (calib.mapAlertE === -1) return;
  calib.mapAlertE = -1;
  cel.mapAlert.hidden = true;
}

// Remap the flagged electrode to the currently targeted zone (same command the
// Mapping tab sends), then dismiss the alert.
function calibRemap() {
  const e = calib.mapAlertE;
  const z = calib.pressZone;
  if (e < 0 || z < 0 || !config) return;
  send(`touch ${Math.floor(e / PER_SENSOR)} ${e % PER_SENSOR} ${zones[z]}`);
  notify(`${zones[z]} remapped to electrode ${e} (${sensorChannel(e)}) - Save to flash to keep it`, 'warn');
  calibClearMapAlert();
}

// Trace of the targeted zone: delta, its threshold ON/OFF, and the step-1 noise
// ceiling, drawn with the shared single-zone renderer.
function drawCalibPressTrace() {
  const canvas = cel.pressTrace;
  if (!canvas) return;
  const z = calib.pressZone;
  if (calib.phase !== 'press' || z < 0 || !config) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const on = config.thr[z] || 0;
  const off = Math.round(on * (1 - (config.hyst || 0) / 100));
  drawSingleTrace(canvas, calibPressBuffer, [
    { value: on, colour: '#ff5c5c' },     // threshold ON
    { value: off, colour: '#ffb000' },    // threshold OFF
    { value: calib.noiseCeil[z], colour: '#8a94a6' },  // noise ceiling
  ], on * 1.6);
}

function calibFinishPress() {
  calib.phase = 'results';
  calibClearMapAlert();
  calibComputeAll();
  calibSeedParams();
  calibBuildResults();
  calibShowStep(3);
}

// --- Step 3: compute + review ----------------------------------------------

// Threshold placement. The floor is the old "just above the noise" rule
// (noise + margin). When the zone's fast taps (quickfire) are known and usable,
// the threshold is raised to the midpoint between noise and taps: between two
// rapid taps a hovering finger keeps a residual delta above the noise, and the
// release margin (OFF) must stay above it or the zone never lets go during a
// spam. The higher of floor and midpoint wins; without a usable quickfire only
// the floor applies. A zone stays "risky" if its press barely clears the noise
// or the threshold lands too close to its fast taps.
function calibThresholdFor(ceil, quick) {
  const floor = ceil + Math.max(CALIB_MIN_MARGIN, 0.3 * ceil);
  const mid = quick != null && quick > ceil ? ceil + 0.5 * (quick - ceil) : 0;
  return clampThr(Math.max(floor, mid));
}

function calibComputeAll() {
  for (let z = 0; z < N_Z; z += 1) {
    const e = zoneToElectrode[z];
    const peak = calib.pressPeak[z];
    if (e < 0 || peak === null) {
      calib.status[z] = 'kept';
      calib.threshold[z] = config ? config.thr[z] : 1;
      continue;
    }
    const ceil = calib.noiseCeil[z];
    const quick = calib.quickfire[z];
    const thr = calibThresholdFor(ceil, quick);
    calib.threshold[z] = thr;
    const closeToQuick = quick != null && thr > CALIB_QUICK_RISKY_FRAC * quick;
    calib.status[z] = (peak - ceil < CALIB_RISKY_GAP || closeToQuick) ? 'risky' : 'ok';
  }
}

const CALIB_STATUS_LABEL = { ok: 'ok', risky: 'risky', kept: 'kept (not measured)' };

// One result cell: the suggested threshold shown large, with the measurements
// (noise / press / quick) small below. The status ('ok' | 'risky' | 'kept')
// colours the whole cell; the p95 noise stays as a hover title.
function calibResultCell(z) {
  const cell = document.createElement('div');
  cell.className = `zcell calib-rescell ${calib.status[z]}`;
  cell.dataset.zone = zones[z];
  cell.title = `95th percentile noise: ${calib.noiseP95[z]}`;

  const top = document.createElement('div');
  top.className = 'zcell-top';
  const name = document.createElement('span');
  name.className = 'zcell-name';
  name.textContent = zones[z];
  const status = document.createElement('span');
  status.className = 'calib-res-status';
  // The short word here; the full "kept (not measured)" lives in the legend.
  status.textContent = CALIB_STATUS_LABEL[calib.status[z]].split(' ')[0];
  top.append(name, status);
  cell.appendChild(top);

  const thr = document.createElement('b');
  thr.className = 'calib-res-thr';
  thr.textContent = calib.threshold[z];
  cell.appendChild(thr);

  const peak = calib.pressPeak[z] === null ? '-' : calib.pressPeak[z];
  const quick = calib.quickfire[z] == null ? '-' : calib.quickfire[z];
  const meas = document.createElement('div');
  meas.className = 'calib-res-meas';
  meas.textContent = `noise ${calib.noiseCeil[z]} / press ${peak} / quick ${quick}`;
  cell.appendChild(meas);

  return cell;
}

function calibBuildResults() {
  cel.resultRows.textContent = '';
  let currentFamily = null;
  let grid = null;
  for (let z = 0; z < N_Z; z += 1) {
    if (zoneToElectrode[z] < 0) continue;   // unmapped zones are not shown
    const family = zones[z][0];
    if (family !== currentFamily) {
      currentFamily = family;
      const group = document.createElement('div');
      group.className = 'zgrid-group';
      const heading = document.createElement('span');
      heading.className = 'zgrid-fam';
      heading.textContent = `Group ${family}`;
      group.appendChild(heading);
      grid = document.createElement('div');
      grid.className = 'zgrid';
      group.appendChild(grid);
      cel.resultRows.appendChild(group);
    }
    grid.appendChild(calibResultCell(z));
  }
}

function calibBuildParams() {
  cel.params.textContent = '';
  const defs = [
    ['debounceOn', 'debounce on', 0, 15],
    ['debounceOff', 'debounce off', 0, 15],
    ['avg', 'avg', 1, 16],
    ['hyst', 'hyst %', 0, 90],
  ];
  defs.forEach(([key, label, min, max]) => {
    const wrap = document.createElement('div');
    wrap.className = 'proc-field';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = min;
    input.max = max;
    input.value = CALIB_PARAM_DEFAULTS[key];
    wrap.append(span, input);
    cel.params.appendChild(wrap);
    calib.paramInputs[key] = input;
  });
}

// Seed the editable parameters from the step-1 auto-tune when it ran, otherwise
// from the built-in defaults, and note which in the origin line.
function calibSeedParams() {
  const seed = calib.tuned || CALIB_PARAM_DEFAULTS;
  Object.keys(calib.paramInputs).forEach((key) => {
    const value = seed[key] != null ? seed[key] : CALIB_PARAM_DEFAULTS[key];
    calib.paramInputs[key].value = value;
  });
  cel.paramsOrigin.textContent = calib.tuned
    ? 'Seeded from the step-1 auto-tune.'
    : 'Default values (run step 1 to auto-tune these).';
}

// Reset the editable parameters (used by "Start over").
function calibResetParams() {
  calib.tuned = null;
  calibSeedParams();
}

// --- Shared adjustment review (used by verify and live calibration) --------

// Render a list of {zone,current,suggested,dir,reason} into a <tbody> as rows
// with a per-zone checkbox (checked by default). Reused by the standby verify
// and the live-calibration review so the accept / accept-all logic lives once.
function buildAdjustmentReview(tbody, adjustments) {
  tbody.textContent = '';
  adjustments.forEach((adj) => {
    const row = document.createElement('tr');
    row.classList.add(`adjust-${adj.dir}`);
    if (adj.warn) row.classList.add('adjust-warn');

    const pick = document.createElement('td');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.dataset.zone = String(adj.zone);
    box.dataset.suggested = String(adj.suggested);
    pick.appendChild(box);

    const name = document.createElement('td');
    name.className = 'zone-name';
    name.textContent = zones[adj.zone];

    const cur = document.createElement('td');
    cur.textContent = adj.current;

    const sug = document.createElement('td');
    sug.textContent = adj.suggested;

    const change = document.createElement('td');
    const diff = adj.suggested - adj.current;
    change.className = `adjust-change adjust-${adj.dir}`;
    change.textContent = `${diff > 0 ? '+' : ''}${diff} (${adj.dir})`;

    const reason = document.createElement('td');
    reason.className = 'adjust-reason';
    reason.textContent = adj.reason;

    row.append(pick, name, cur, sug, change, reason);
    tbody.appendChild(row);
  });
}

// Read the checked rows back as [{zone, suggested}].
function collectAcceptedAdjustments(tbody) {
  const out = [];
  tbody.querySelectorAll('input[type=checkbox]:checked').forEach((box) => {
    out.push({ zone: Number(box.dataset.zone), suggested: Number(box.dataset.suggested) });
  });
  return out;
}

// Send accepted thresholds live to the board (leaves it unsaved on purpose).
function applyAdjustmentsToBoard(accepted) {
  if (!config) { notify('Connect the board first', 'warn'); return 0; }
  accepted.forEach(({ zone, suggested }) => send(`thr ${zones[zone]} ${suggested}`));
  return accepted.length;
}

// Wire the Accept all / Accept none buttons once (they target a tbody by id).
function initAdjustmentToggles() {
  document.querySelectorAll('.adjust-all').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll(`#${btn.dataset.target} input[type=checkbox]`)
      .forEach((box) => { box.checked = true; });
  }));
  document.querySelectorAll('.adjust-none').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll(`#${btn.dataset.target} input[type=checkbox]`)
      .forEach((box) => { box.checked = false; });
  }));
}

// --- Step 4: verify thresholds against standby noise -----------------------

function calibStartVerify() {
  if (!config) { notify('Connect the board before verifying', 'warn'); return; }
  // Apply the candidate thresholds live so the firmware's own triggers (T lines)
  // reflect exactly what we are verifying.
  for (let z = 0; z < N_Z; z += 1) {
    if (zoneToElectrode[z] < 0) continue;
    send(`thr ${zones[z]} ${calib.threshold[z]}`);
    config.thr[z] = calib.threshold[z];
  }
  calib.phase = 'verify';
  calib.verifyCeil.fill(0);
  calib.verifyTrig.fill(0);
  calib.verifyPeak.fill(0);
  calib.verifyAdjust = [];
  calib.verifyEndsAt = performance.now() + CALIB_VERIFY_MS;
  cel.verifyResults.hidden = true;
  cel.verifyProgress.hidden = false;
  // Show the live trace and the triggered-zones list, reset for this pass.
  cel.verifyLive.hidden = false;
  cel.verifyLiveEmpty.hidden = false;
  cel.verifyLiveWrap.hidden = true;
  cel.verifyLiveRows.textContent = '';
  calib.verifyLiveDirty = false;
  cel.verifyStart.disabled = true;
  cel.verifyApply.disabled = false;
  setHoldProgress(cel.verifyBar, 0);
  cel.verifyCount.textContent = `${(CALIB_VERIFY_MS / 1000).toFixed(0)} s left - do not touch the panel`;
}

// Track the delta ceiling per zone (peaks are reliable now). Real triggers come
// from the T queue, folded in by drainTriggerEvents.
function calibVerifyFrame(data) {
  for (let z = 0; z < N_Z; z += 1) {
    const e = zoneToElectrode[z];
    if (e < 0) continue;
    const delta = data.deltas[e];
    if (delta > calib.verifyCeil[z]) calib.verifyCeil[z] = delta;
  }
  const now = performance.now();
  const remaining = Math.max(0, calib.verifyEndsAt - now);
  setHoldProgress(cel.verifyBar, 1 - remaining / CALIB_VERIFY_MS);
  cel.verifyCount.textContent = `${Math.ceil(remaining / 1000)} s left - do not touch the panel`;
  if (now >= calib.verifyEndsAt) calibFinishVerify();
}

// Live list of zones that fired since the start of the current pass, newest data
// folded in by drainTriggerEvents. Only repaints on a change (dirty flag); the
// dispatch already gates it on the calibration section being visible.
function calibRenderVerifyLive() {
  if (!calib.verifyLiveDirty) return;
  calib.verifyLiveDirty = false;
  const fired = [];
  for (let z = 0; z < N_Z; z += 1) {
    if (calib.verifyTrig[z] > 0) fired.push(z);
  }
  cel.verifyLiveEmpty.hidden = fired.length > 0;
  cel.verifyLiveWrap.hidden = fired.length === 0;
  cel.verifyLiveRows.textContent = '';
  fired.forEach((z) => {
    const row = document.createElement('tr');
    const cells = [zones[z], calib.threshold[z], calib.noiseCeil[z],
      calib.verifyTrig[z], calib.verifyPeak[z]];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      if (i === 0) td.className = 'zone-name';
      td.textContent = text;
      row.appendChild(td);
    });
    cel.verifyLiveRows.appendChild(row);
  });
}

// Add a "may miss fast taps" caveat when a raised threshold lands too close to
// the zone's known quickfire level.
function calibVerifyWarn(z, suggested) {
  const quick = calib.quickfire[z];
  return quick != null && suggested > CALIB_QUICK_RISKY_FRAC * quick;
}

// Any real trigger (or noise reaching the threshold) is a false trigger to raise
// above; otherwise headroom means the threshold can drop.
function calibComputeVerify() {
  const adjust = [];
  for (let z = 0; z < N_Z; z += 1) {
    if (zoneToElectrode[z] < 0) continue;
    const cand = calib.threshold[z];
    const ceil = calib.verifyCeil[z];
    const trig = calib.verifyTrig[z];
    const tpeak = calib.verifyPeak[z];
    if (trig > 0 || ceil >= cand) {
      const suggested = clampThr(Math.max(ceil, tpeak) + VERIFY_RAISE_MARGIN);
      if (suggested > cand) {
        const warn = calibVerifyWarn(z, suggested);
        let reason = trig > 0
          ? `${trig} false trigger(s), peak ${tpeak}`
          : `noise reached ${ceil}`;
        if (warn) reason += ' - may miss fast taps';
        adjust.push({ zone: z, current: cand, suggested, dir: 'raise', reason, warn });
      }
      continue;
    }
    // Headroom: the real resting noise sits well below the threshold.
    const peak = calib.pressPeak[z];
    if (peak === null) continue;
    const ideal = calibThresholdFor(ceil, calib.quickfire[z]);
    if (ideal <= cand - VERIFY_LOWER_MIN_GAP) {
      const warn = calibVerifyWarn(z, ideal);
      let reason = `noise only ${ceil}, room below ${cand}`;
      if (warn) reason += ' - may miss fast taps';
      adjust.push({ zone: z, current: cand, suggested: ideal, dir: 'lower', reason, warn });
    }
  }
  return adjust;
}

function calibFinishVerify() {
  calib.phase = 'results';   // measurement done; stay on step 4 showing results
  cel.verifyProgress.hidden = true;
  cel.verifyLive.hidden = true;   // a re-verify pass re-shows it via calibStartVerify
  cel.verifyStart.disabled = false;
  calib.verifyAdjust = calibComputeVerify();
  const raises = calib.verifyAdjust.filter((a) => a.dir === 'raise');
  const anyFalse = calib.verifyTrig.some((v) => v > 0) || raises.length > 0;

  // Re-verify loop: apply the raises automatically and run another pass until a
  // clean one, capped so it always terminates.
  if (calib.reverify.active) {
    if (anyFalse && calib.reverify.pass < CALIB_REVERIFY_MAX) {
      calib.reverify.pass += 1;
      raises.forEach((a) => { calib.threshold[a.zone] = a.suggested; });
      applyAdjustmentsToBoard(raises.map((a) => ({ zone: a.zone, suggested: a.suggested })));
      calibBuildResults();
      notify(`Re-verify pass ${calib.reverify.pass}: raised ${raises.length} zone(s)`, 'warn');
      calibStartVerify();
      return;
    }
    calib.reverify.active = false;
  }

  buildAdjustmentReview(cel.verifyRows, calib.verifyAdjust);
  const lowers = calib.verifyAdjust.filter((a) => a.dir === 'lower').length;
  cel.verifySummary.textContent = !anyFalse && calib.verifyAdjust.length === 0
    ? 'Clean pass - no false trigger in 60 s.'
    : `${raises.length} zone(s) to raise (fired on their own), ${lowers} to lower (extra headroom). Uncheck any you want to keep, then apply.`;
  // A clean pass has nothing to review or apply: strip the step down to
  // "Continue to profile" plus an optional re-check.
  const noAdjust = calib.verifyAdjust.length === 0;
  cel.verifyAdjustActions.hidden = noAdjust;
  cel.verifyTable.hidden = noAdjust;
  cel.verifyApply.hidden = noAdjust;
  cel.verifyReverify.hidden = noAdjust;
  cel.verifyRecheck.hidden = !noAdjust;
  cel.verifyResults.hidden = false;
}

// Apply the accepted verify suggestions to the candidate thresholds (so they
// flow into the profile) and push them live to the board.
function calibApplyVerify() {
  const accepted = collectAcceptedAdjustments(cel.verifyRows);
  if (!accepted.length) { notify('Nothing selected to apply', 'warn'); return; }
  accepted.forEach(({ zone, suggested }) => { calib.threshold[zone] = suggested; });
  applyAdjustmentsToBoard(accepted);
  calibBuildResults();   // reflect new thresholds in the step-3 table
  notify(`Applied ${accepted.length} adjustment(s) - Save to flash to keep them`);
  cel.verifyApply.disabled = true;
}

// Apply the ticked raises, then re-run the 60 s window automatically, looping
// until a clean pass.
function calibApplyReverify() {
  const accepted = collectAcceptedAdjustments(cel.verifyRows);
  accepted.forEach(({ zone, suggested }) => { calib.threshold[zone] = suggested; });
  if (accepted.length) {
    applyAdjustmentsToBoard(accepted);
    calibBuildResults();
  }
  calib.reverify.active = true;
  calib.reverify.pass = 0;
  calibStartVerify();
}

// --- Step 5: build + save the profile --------------------------------------

function calibParamValue(key, min, max) {
  const n = parseInt(calib.paramInputs[key].value, 10);
  if (!Number.isInteger(n)) return CALIB_PARAM_DEFAULTS[key];
  return Math.min(max, Math.max(min, n));
}

function calibCreateProfile() {
  if (!config) { notify('Connect the board before creating a profile', 'warn'); return; }

  const cfg = cloneConfig(config);
  for (let z = 0; z < N_Z; z += 1) cfg.thr[z] = calib.threshold[z];
  cfg.debounceOn = calibParamValue('debounceOn', 0, 15);
  cfg.debounceOff = calibParamValue('debounceOff', 0, 15);
  cfg.avg = calibParamValue('avg', 1, 16);
  cfg.hyst = calibParamValue('hyst', 0, 90);

  const name = cel.profileName.value.trim() || `Auto-cal ${new Date().toLocaleString()}`;
  const list = loadProfiles();
  const existing = list.findIndex((p) => p.name === name);
  // Embed the per-zone measurements alongside the config, so the numbers behind
  // the thresholds travel with the profile.
  const profile = {
    name,
    savedAt: new Date().toISOString(),
    config: cfg,
    calib: {
      noise: [...calib.noiseCeil],
      p95: [...calib.noiseP95],
      peak: [...calib.pressPeak],
      quick: [...calib.quickfire],
    },
  };

  if (existing >= 0) {
    if (!window.confirm(`A profile named "${name}" already exists. Replace it?`)) return;
    list[existing] = profile;
  } else {
    list.push(profile);
  }
  storeProfiles(list);
  renderProfiles();
  notify(`Profile "${name}" created from calibration`);

  // The tuned globals are what the profile carries; keep them live and drop the
  // restore point so leaving the wizard does not undo them.
  calib.tuneSaved = null;

  if (cel.applyNow.checked) {
    applyProfile(profile);
    // The wizard's outcome went through the standby verify: applying it without
    // persisting would lose it on the next power cycle. Save right away.
    send('save');
    notify(`Profile "${name}" applied and saved to flash`);
  }
}

// Called every frame from render(): advance whichever measurement is running.
// A dropped link mid-measurement stops the wizard rather than freezing it.
function calibFrame(data) {
  // Step 1 pushes probe settings (avg/debounce) live onto the board. If the link
  // then drops, those stay on the board while the wizard resets - so stash the
  // originals and re-apply them once the board is back.
  if (calib.restorePending && calib.phase === 'idle' && data.connected && config) {
    calib.tuneSaved = calib.restorePending;
    calib.restorePending = null;
    calibRestoreGlobals();
  }
  if (calib.phase !== 'noise' && calib.phase !== 'press' && calib.phase !== 'verify') return;
  if (!data.connected || !config) {
    if (calib.tuneSaved) calib.restorePending = calib.tuneSaved;
    calibReset();
    notify('Board disconnected - calibration stopped', 'warn');
    return;
  }
  if (calib.phase === 'noise') calibNoiseFrame(data);
  else if (calib.phase === 'press') calibPressFrame(data);
  else if (calib.phase === 'verify') calibVerifyFrame(data);
}

function calibInit() {
  calibBuildParams();
  calibReset();

  cel.rebase.addEventListener('click', () => {
    if (!config) { notify('Connect the board first', 'warn'); return; }
    send('rebase');
    notify('Idle level set from the current readings');
  });
  cel.noiseStart.addEventListener('click', calibStartNoise);
  cel.advAuto.addEventListener('click', () => calibSetAdvance('auto'));
  cel.advManual.addEventListener('click', () => calibSetAdvance('manual'));
  calibSetSound(calibSoundOn);   // reflect the stored preference on the toggle
  cel.sound.addEventListener('click', () => { calibAudio(); calibSetSound(!calibSoundOn); });
  cel.mapAlertRemap.addEventListener('click', calibRemap);
  cel.pressPrev.addEventListener('click', () => {
    if (calib.phase !== 'press' || calib.pressPos === 0) return;
    calibRecordPress();
    calibGoTo(calib.pressPos - 1);
  });
  cel.pressNext.addEventListener('click', () => {
    if (calib.phase !== 'press') return;
    calibRecordPress();
    calibAdvance();
  });
  cel.pressSkip.addEventListener('click', () => {
    if (calib.phase !== 'press') return;
    calib.pressState[calib.pressZone] = 'skipped';
    calib.pressPeak[calib.pressZone] = null;
    calibAdvance();
  });
  cel.pressFinish.addEventListener('click', () => {
    if (calib.phase !== 'press') return;
    calibRecordPress();
    calibFinishPress();
  });
  cel.stop.addEventListener('click', calibStop);

  const goToProfile = () => {
    cel.profileName.value = `Auto-cal ${new Date().toLocaleString()}`;
    cel.applyNow.checked = true;
    calibShowStep(5);
  };
  // Results (step 3) -> standby verify (step 4).
  cel.toVerify.addEventListener('click', () => {
    calib.phase = 'results';
    calib.reverify.active = false;
    calib.reverify.pass = 0;
    cel.verifyResults.hidden = true;
    cel.verifyProgress.hidden = true;
    cel.verifyLive.hidden = true;
    cel.verifyStart.disabled = false;
    cel.verifyApply.disabled = false;
    setHoldProgress(cel.verifyBar, 0);
    calibShowStep(4);
  });
  cel.toProfile.addEventListener('click', goToProfile);        // results -> skip verify
  cel.verifyToProfile.addEventListener('click', goToProfile);  // verify -> profile
  cel.verifyStart.addEventListener('click', calibStartVerify);
  cel.verifySkip.addEventListener('click', goToProfile);
  cel.verifyApply.addEventListener('click', calibApplyVerify);
  cel.verifyReverify.addEventListener('click', calibApplyReverify);
  cel.verifyRecheck.addEventListener('click', calibStartVerify);

  cel.profileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    calibCreateProfile();
  });
  document.querySelectorAll('.calib-restart').forEach((btn) =>
    btn.addEventListener('click', () => { calibReset(); calibResetParams(); }));
  initAdjustmentToggles();
}

// --- Live calibration ------------------------------------------------------

// Tunes thresholds during real play. Per zone it tracks the resting noise floor
// as a slow envelope, then detects excursions (a delta rising a clear margin
// over the floor and lasting a few frames). Each excursion is classified against
// the firmware's own trigger bitmap: a real trigger is a hit (tight if it barely
// cleared the threshold), an untouched excursion that climbed near the threshold
// is a near-miss - the brief in-game tap that falls just short. On stop it
// suggests lowering the zones that miss; an opt-in mode lowers them live.

const LIVE_RISE_MARGIN = 6;     // delta over floor that starts an excursion
const LIVE_MIN_EXCURSION = 8;   // min excursion height over floor to count
const LIVE_FALL_MARGIN = 3;     // excursion ends when delta falls back near floor
const LIVE_MIN_FRAMES = 2;      // frames an excursion must last (drops 1-frame noise)
const LIVE_NEAR_FRAC = 0.65;    // untouched peak >= thr*frac counts as a near-miss
const LIVE_TIGHT_MARGIN = 8;    // triggered but peak within this of thr = tight
const LIVE_MISS_MIN = 2;        // near-misses (or tight hits) before we suggest
const LIVE_UNDER_MARGIN = 4;    // place a lowered threshold this far under the peak
const LIVE_SAFE_MARGIN = 8;     // never drop a threshold below floor + this
const LIVE_AUTO_MS = 10000;     // auto-apply: quiet window on a zone before lowering
const LIVE_RENDER_MS = 500;     // observation table refresh throttle

const liveCal = {
  running: false,
  paused: false,
  autoApply: false,
  startedAt: 0,
  lastRender: 0,
  noiseFloor: new Array(N_Z).fill(0),
  exc: Array.from({ length: N_Z }, () => ({ active: false, peak: 0, frames: 0, triggered: false })),
  stats: Array.from({ length: N_Z }, () => ({
    hits: 0, tight: 0, miss: 0, missPeak: 0, minTrig: Infinity, lastTrigAt: 0, lastAutoAt: 0,
  })),
};

const lcel = {
  start: document.getElementById('livecal-start'),
  pause: document.getElementById('livecal-pause'),
  resume: document.getElementById('livecal-resume'),
  stop: document.getElementById('livecal-stop'),
  state: document.getElementById('livecal-state'),
  elapsed: document.getElementById('livecal-elapsed'),
  autoapply: document.getElementById('livecal-autoapply'),
  rows: document.getElementById('livecal-rows'),
  review: document.getElementById('livecal-review'),
  summary: document.getElementById('livecal-summary'),
  reviewRows: document.getElementById('livecal-review-rows'),
  apply: document.getElementById('livecal-apply'),
  discard: document.getElementById('livecal-discard'),
};

function liveCalSetState(label, tone) {
  lcel.state.textContent = label;
  lcel.state.className = `badge ${tone}`;
}

function liveCalResetStats() {
  liveCal.noiseFloor.fill(0);
  liveCal.exc.forEach((e) => { e.active = false; e.peak = 0; e.frames = 0; e.triggered = false; });
  liveCal.stats.forEach((s) => {
    s.hits = 0; s.tight = 0; s.miss = 0; s.missPeak = 0;
    s.minTrig = Infinity; s.lastTrigAt = 0; s.lastAutoAt = 0;
  });
}

function liveCalStart() {
  if (!config) { notify('Connect the board before live calibration', 'warn'); return; }
  liveCalResetStats();
  // Seed the noise floor from a prior wizard noise pass when available.
  for (let z = 0; z < N_Z; z += 1) liveCal.noiseFloor[z] = calib.noiseCeil[z] || 0;
  const now = performance.now();
  liveCal.stats.forEach((s) => { s.lastTrigAt = now; });
  liveCal.running = true;
  liveCal.paused = false;
  liveCal.startedAt = now;
  liveCal.lastRender = 0;
  lcel.start.hidden = true;
  lcel.pause.hidden = false;
  lcel.resume.hidden = true;
  lcel.stop.hidden = false;
  lcel.review.hidden = true;
  liveCalSetState('recording', 'badge-on');
  liveCalRenderTable();
}

function liveCalPause() {
  if (!liveCal.running) return;
  liveCal.paused = true;
  lcel.pause.hidden = true;
  lcel.resume.hidden = false;
  liveCalSetState('paused', 'badge-off');
}

function liveCalResume() {
  if (!liveCal.running) return;
  liveCal.paused = false;
  lcel.pause.hidden = false;
  lcel.resume.hidden = true;
  liveCalSetState('recording', 'badge-on');
}

function liveCalStop() {
  if (!liveCal.running) return;
  liveCal.running = false;
  liveCal.paused = false;
  lcel.start.hidden = false;
  lcel.pause.hidden = true;
  lcel.resume.hidden = true;
  lcel.stop.hidden = true;
  liveCalSetState('idle', 'badge-off');
  liveCalRenderTable();

  const adjust = liveCalComputeSuggestions();
  buildAdjustmentReview(lcel.reviewRows, adjust);
  lcel.summary.textContent = adjust.length === 0
    ? 'No adjustment suggested - no zone missed a clear press. Play more, or lower a few by hand in Tuning.'
    : `${adjust.length} zone(s) missed clear presses and could be lowered. Uncheck any you want to keep, then apply.`;
  lcel.review.hidden = false;
  lcel.apply.disabled = adjust.length === 0;
}

// Suggested lowering for one zone, or null. Shared by the live table and stop.
function liveCalSuggestFor(z) {
  if (!config) return null;
  const s = liveCal.stats[z];
  const cur = config.thr[z];
  const floor = liveCal.noiseFloor[z];
  if (s.miss >= LIVE_MISS_MIN && s.missPeak > 0) {
    const t = clampThr(Math.max(floor + LIVE_SAFE_MARGIN, s.missPeak - LIVE_UNDER_MARGIN));
    if (t < cur) return { suggested: t, dir: 'lower', reason: `${s.miss} near-miss up to ${s.missPeak}` };
  }
  if (s.miss === 0 && s.tight >= LIVE_MISS_MIN && Number.isFinite(s.minTrig)) {
    const t = clampThr(Math.max(floor + LIVE_SAFE_MARGIN, s.minTrig - LIVE_UNDER_MARGIN));
    if (t < cur) return { suggested: t, dir: 'lower', reason: `${s.tight} tight hits, min ${s.minTrig}` };
  }
  return null;
}

function liveCalComputeSuggestions() {
  const adjust = [];
  for (let z = 0; z < N_Z; z += 1) {
    if (zoneToElectrode[z] < 0) continue;
    const sug = liveCalSuggestFor(z);
    if (sug) adjust.push({ zone: z, current: config.thr[z], suggested: sug.suggested, dir: sug.dir, reason: sug.reason });
  }
  return adjust;
}

// Classify one finished excursion on zone z into the running stats.
function liveCalClassify(z) {
  const exc = liveCal.exc[z];
  if (exc.frames < LIVE_MIN_FRAMES) return;                     // too brief = noise spike
  if (exc.peak < liveCal.noiseFloor[z] + LIVE_MIN_EXCURSION) return;  // too small = noise
  const s = liveCal.stats[z];
  const onThr = config.thr[z];
  if (exc.triggered) {
    s.hits += 1;
    s.lastTrigAt = performance.now();
    if (exc.peak - onThr < LIVE_TIGHT_MARGIN) s.tight += 1;
    if (exc.peak < s.minTrig) s.minTrig = exc.peak;
  } else if (exc.peak >= onThr * LIVE_NEAR_FRAC) {
    s.miss += 1;
    // Only peaks below the threshold are fixable by lowering it (a peak above
    // that never triggered was blocked by debounce, not the threshold).
    if (exc.peak < onThr && exc.peak > s.missPeak) s.missPeak = exc.peak;
  }
}

function liveCalFrame(data) {
  if (!liveCal.running || liveCal.paused) return;
  if (!data.connected || !config) {
    liveCalStop();
    notify('Board disconnected - live calibration stopped', 'warn');
    return;
  }
  for (let z = 0; z < N_Z; z += 1) {
    const e = zoneToElectrode[z];
    if (e < 0) continue;
    const delta = data.deltas[e];
    const active = data.zonesActive[z];
    const exc = liveCal.exc[z];
    let floor = liveCal.noiseFloor[z];

    if (!exc.active) {
      // Track the resting noise floor only while quiet: rise a bit toward higher
      // noise, decay very slowly - an envelope just under the real noise.
      if (!active) {
        floor += (delta - floor) * (delta > floor ? 0.05 : 0.002);
        liveCal.noiseFloor[z] = floor;
      }
      if (delta >= floor + LIVE_RISE_MARGIN) {
        exc.active = true; exc.peak = delta; exc.frames = 1; exc.triggered = active;
      }
    } else {
      exc.frames += 1;
      if (delta > exc.peak) exc.peak = delta;
      if (active) exc.triggered = true;
      if (delta <= floor + LIVE_FALL_MARGIN) {
        liveCalClassify(z);
        exc.active = false; exc.peak = 0; exc.frames = 0; exc.triggered = false;
      }
    }
  }

  const now = performance.now();
  if (now - liveCal.lastRender >= LIVE_RENDER_MS) {
    liveCal.lastRender = now;
    // Observation keeps running from any tab; the table repaint is only worth
    // it when the section is on screen.
    if (activeSection === 'livecal') liveCalRenderTable();
    lcel.elapsed.textContent = `${((now - liveCal.startedAt) / 1000).toFixed(0)} s`;
    if (liveCal.autoApply) liveCalAutoApply(now);
  }
}

// Opt-in: lower a zone live once it has steady near-misses and has not triggered
// for a while (so we are not fighting an active press).
function liveCalAutoApply(now) {
  for (let z = 0; z < N_Z; z += 1) {
    if (zoneToElectrode[z] < 0) continue;
    const s = liveCal.stats[z];
    if (s.miss < LIVE_MISS_MIN || s.missPeak <= 0) continue;
    if (now - s.lastTrigAt < LIVE_AUTO_MS || now - s.lastAutoAt < LIVE_AUTO_MS) continue;
    const sug = liveCalSuggestFor(z);
    if (!sug) continue;
    send(`thr ${zones[z]} ${sug.suggested}`);
    s.lastAutoAt = now;
    s.miss = 0; s.missPeak = 0;   // re-observe at the new threshold
    notify(`Live: lowered ${zones[z]} to ${sug.suggested}`, 'warn');
  }
}

function liveCalRenderTable() {
  lcel.rows.textContent = '';
  for (let z = 0; z < N_Z; z += 1) {
    if (zoneToElectrode[z] < 0) continue;
    const s = liveCal.stats[z];
    const sug = liveCalSuggestFor(z);
    const row = document.createElement('tr');
    const touched = s.hits || s.miss;
    if (!touched) row.classList.add('livecal-idle');
    if (s.miss) row.classList.add('livecal-miss');

    const cells = [
      zones[z],
      Math.round(liveCal.noiseFloor[z]),
      config ? config.thr[z] : '-',
      s.hits,
      s.tight,
      s.miss,
      s.missPeak || '-',
    ];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      if (i === 0) td.className = 'zone-name';
      if (i === 5) td.className = 'livecal-nearmiss';
      td.textContent = text;
      row.appendChild(td);
    });
    const sugTd = document.createElement('td');
    sugTd.className = 'livecal-suggest';
    sugTd.textContent = sug ? sug.suggested : '-';
    row.appendChild(sugTd);
    lcel.rows.appendChild(row);
  }
}

function liveCalApply() {
  const accepted = collectAcceptedAdjustments(lcel.reviewRows);
  if (!accepted.length) { notify('Nothing selected to apply', 'warn'); return; }
  applyAdjustmentsToBoard(accepted);
  notify(`Applied ${accepted.length} adjustment(s) - Save to flash to keep them`);
  lcel.review.hidden = true;
  liveCalResetStats();
  liveCalRenderTable();
}

function liveCalInit() {
  liveCalSetState('idle', 'badge-off');
  liveCalRenderTable();
  lcel.start.addEventListener('click', liveCalStart);
  lcel.pause.addEventListener('click', liveCalPause);
  lcel.resume.addEventListener('click', liveCalResume);
  lcel.stop.addEventListener('click', liveCalStop);
  lcel.autoapply.addEventListener('change', () => { liveCal.autoApply = lcel.autoapply.checked; });
  lcel.apply.addEventListener('click', liveCalApply);
  lcel.discard.addEventListener('click', () => {
    lcel.review.hidden = true;
    liveCalResetStats();
    liveCalRenderTable();
  });
}

// --- Render ----------------------------------------------------------------

let lastActive = null;

// Which section is on screen (kept by the nav handler). Painting is gated on
// it: collection (trace buffers, log stats, calibration measurements) always
// runs, but the DOM of a hidden tab is not worth updating 25 times a second.
let activeSection = 'info';
let autoSaveWasConnected = false;

function render(data) {
  els.rate.textContent = data.rate;
  els.link.textContent = data.connected
    ? (data.source || 'connected')
    : (data.error || 'disconnected');
  els.link.className = `badge ${data.connected ? 'badge-on' : 'badge-off'}`;
  els.disconnect.hidden = !data.connected;

  // Board just went away (unplugged): flush the tail to disk before the samples
  // stop arriving. The Disconnect button reloads the page instead, which fires
  // pagehide - covered there.
  if (autoSaveWasConnected && !data.connected) flushAutoSave();
  autoSaveWasConnected = data.connected;

  // While disconnected, the board-driven tabs show the shared gate and their
  // nav entry is locked; Information stays open.
  updateConnectGate();

  // Auto-scale the card bars to the deltas actually seen (rise fast, fall slow).
  const frameMax = data.deltas.reduce((m, v) => (v > m ? v : m), 0);
  const scaleTarget = Math.max(BAR_FLOOR, frameMax * 1.2);
  barScale += (scaleTarget - barScale) * (scaleTarget > barScale ? 0.4 : 0.02);

  if (data.config && data.config !== config) {
    // transport.js replaces state.config only on a fresh C line, so an identity
    // check is enough to know it changed.
    refreshConfig(data.config);
  }

  // The transport bumps consoleVersion on every write: comparing two integers
  // replaces re-joining ~200 lines at every frame.
  const consoleSig = data.consoleVersion || 0;
  if (consoleSig !== lastConsole) {
    lastConsole = consoleSig;
    els.console.innerHTML = consoleHtml(data.console);
    els.console.scrollTop = els.console.scrollHeight;
  }

  // Drain real triggers (T lines) every frame - collection never stops. The Last
  // triggers list only repaints on the Live tab; the standby verify consumes them
  // inside the drain.
  drainTriggerEvents();
  if (activeSection === 'live' && lastTrigDirty) {
    lastTrigDirty = false;
    renderLastTriggers();
  }

  // Active-zone readout and disc highlight, from the firmware's own bitmap.
  if (activeSection === 'live') {
    const activeNames = [];
    zones.forEach((zone, z) => {
      const active = data.zonesActive[z];
      if (active) activeNames.push(zone);
      livePads.get(zone)?.classList.toggle('touched', active);
    });
    const activeText = activeNames.length ? activeNames.join('  ') : 'none';
    if (activeText !== lastActive) {
      lastActive = activeText;
      els.active.textContent = activeText;
    }
  }

  if (!config) { drawSpark(); return; }

  if (activeSection === 'live') {
    // Live zone cards.
    zones.forEach((zone, z) => {
      const e = zoneToElectrode[z];
      const cell = zoneCells[z];
      if (!cell) return;
      if (e < 0) {
        paintCell(cell, '-', '-', 0, -1, false);
        return;
      }
      paintCell(cell, data.filtered[e], baselineOf(e), data.deltas[e],
        config.thr[z], data.zonesActive[z]);
    });

    // Live electrode cards.
    for (let e = 0; e < N_E; e += 1) {
      const cell = electrodeCells[e];
      if (!cell) continue;
      const zone = config.map[e];
      const threshold = zone === UNMAPPED ? -1 : config.thr[zone];
      const active = zone !== UNMAPPED && data.zonesActive[zone];
      paintCell(cell, data.filtered[e], baselineOf(e), data.deltas[e], threshold, active);
    }
  }

  // Threshold / mapping tables, and the threshold-disc tint.
  if (activeSection === 'tuning' || activeSection === 'mapping') {
    zones.forEach((zone, z) => {
      const e = zoneToElectrode[z];
      const delta = e < 0 ? 0 : data.deltas[e];
      const threshold = config.thr[z] || 1;
      const active = data.zonesActive[z];

      thrPads.get(zone)?.classList.toggle('touched', active);
      mapPads.get(zone)?.classList.toggle('touched', active);
      const thrPad = thrPads.get(zone);
      if (thrPad) {
        const ratio = Math.min(1, delta / threshold);
        thrPad.classList.toggle('rising', !active && ratio > 0.15);
        thrPad.style.fillOpacity = (active || ratio <= 0.15) ? '' : String(0.15 + ratio * 0.6);
      }

      if (zone === selectedZone && els.thrDialog.open) {
        els.thrReading.textContent = `${delta} of ${threshold}`;
        els.thrReading.classList.toggle('over', active);
      }

      const refs = rowRefs.get(zone);
      if (refs) {
        const width = `${Math.min(100, (delta / barScale) * 100)}%`;
        const thrPos = `${Math.min(100, (threshold / barScale) * 100)}%`;
        refs.cells.forEach(({ deviation, fill, mark }) => {
          deviation.textContent = delta;
          deviation.classList.toggle('over', active);
          fill.style.width = width;
          fill.classList.toggle('over', active);
          mark.style.setProperty('--thr-pos', thrPos);
        });
      }
    });
  }

  // Trace buffers always accumulate (a trace must not have holes from time
  // spent on another tab); only the drawing is gated on the visible section.
  const target = selectionTarget();
  if (target && target.electrode >= 0) {
    sparkBuffer.push(data.deltas[target.electrode]);
    while (sparkBuffer.length > SPARK_LEN) sparkBuffer.shift();
  }
  for (let z = 0; z < N_Z; z += 1) {
    const e = zoneToElectrode[z];
    allBuffers[z].push(e >= 0 ? data.deltas[e] : 0);
    while (allBuffers[z].length > SPARK_LEN) allBuffers[z].shift();
  }
  if (activeSection === 'live') {
    drawSpark();
    drawGlobalSpark(els.sparkAll);
    updateLiveThr();   // keep the inline threshold in sync (skips while editing)
  }

  // Live log stats (and a recorded sample when recording), throttled inside.
  logFrame(data);

  // Advance the auto-calibration wizard while a measurement phase is running.
  calibFrame(data);

  // Wizard traces reuse the Live renderers, gated on the calibration phase
  // (buffers already accumulated above): the all-zones trace during the step-1
  // noise/auto-tune measurement, the targeted-zone trace during the presses.
  if (activeSection === 'calibration') {
    if (calib.phase === 'noise') drawGlobalSpark(cel.traceAll);
    else if (calib.phase === 'press') {
      drawCalibPressTrace();
      // Keep the disc's live "touched" state like the Live view, so a press is
      // seen landing on the targeted pad.
      zones.forEach((zone, z) => {
        calibPressPads.get(zone)?.classList.toggle('touched', data.zonesActive[z]);
      });
    } else if (calib.phase === 'verify') {
      drawGlobalSpark(cel.verifyTraceAll);
      calibRenderVerifyLive();
    }
  }

  // Live calibration observes real play whenever it is running.
  liveCalFrame(data);

  trackLearning();
}

// --- Navigation ------------------------------------------------------------

const sidebarToggle = document.getElementById('sidebar-toggle');
function syncSidebarToggle(collapsed) {
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  sidebarToggle.setAttribute('aria-label', label);
  sidebarToggle.title = label;
}
syncSidebarToggle(document.body.classList.contains('sidebar-collapsed'));

// Below the stacking breakpoint the same toggle drives the floating drawer
// instead of the desktop rail. The drawer state is deliberately not persisted:
// an overlay reopening on its own would be a nuisance, not a preference.
const drawerMq = window.matchMedia('(max-width: 1100px)');
function closeDrawer() { document.body.classList.remove('menu-open'); }

sidebarToggle.addEventListener('click', () => {
  if (drawerMq.matches) {
    document.body.classList.toggle('menu-open');
    return;
  }
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  storageSet(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  syncSidebarToggle(collapsed);
});

// Picking a section, clicking past the drawer, pressing Escape, or resizing
// across the breakpoint all close it.
document.addEventListener('click', (e) => {
  if (!document.body.classList.contains('menu-open')) return;
  if (!e.target.closest('.sidebar')) closeDrawer();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});
drawerMq.addEventListener('change', closeDrawer);

document.querySelectorAll('.nav button').forEach((button) => {
  button.addEventListener('click', () => {
    closeDrawer();
    document.querySelectorAll('.nav button').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');
    document.querySelectorAll('.section').forEach((section) => {
      section.classList.toggle('active', section.dataset.section === button.dataset.section);
    });
    activeSection = button.dataset.section;
    // Repaint right away with the collected data, rather than waiting up to
    // one frame period for the gated blocks to run again.
    if (config) render(state);
    stopCalibration();
    // A running noise/press measurement off-screen would record meaningless
    // data; results already computed (and the standby verify, which needs no
    // interaction) are left intact.
    if (button.dataset.section !== 'calibration'
        && (calib.phase === 'noise' || calib.phase === 'press')) {
      calibStop();
    }
    // A locked tab navigates as usual, then shows the gate in place of its
    // content; Information (never locked) shows normally.
    updateConnectGate(true);
  });
});

document.querySelectorAll('.info-nav button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.info-nav button').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');
    document.querySelectorAll('.info-content article').forEach((article) => {
      article.classList.toggle('active', article.dataset.topic === button.dataset.topic);
    });
  });
});

// --- Live view toggle ------------------------------------------------------

els.viewZone.addEventListener('click', () => {
  els.viewZone.classList.add('on');
  els.viewElectrode.classList.remove('on');
  els.zoneView.hidden = false;
  els.electrodeView.hidden = true;
});
els.viewElectrode.addEventListener('click', () => {
  els.viewElectrode.classList.add('on');
  els.viewZone.classList.remove('on');
  els.electrodeView.hidden = false;
  els.zoneView.hidden = true;
});

// --- Threshold slider dialog -----------------------------------------------

let thrSliderPending = 0;

els.thrSlider.addEventListener('input', () => {
  if (!selectedZone) return;
  const field = els.thrField.querySelector('input');
  if (field) field.value = els.thrSlider.value;
  const now = performance.now();
  if (now - thrSliderPending < 150) return;   // each command republishes config
  thrSliderPending = now;
  send(`thr ${selectedZone} ${els.thrSlider.value}`);
});
els.thrSlider.addEventListener('change', () => {
  if (selectedZone) send(`thr ${selectedZone} ${els.thrSlider.value}`);
});
els.thrSlider.addEventListener('focus', () => { editing = els.thrSlider; });
els.thrSlider.addEventListener('blur', () => { editing = null; });

els.thrSave.addEventListener('click', () => { send('save'); els.thrDialog.close(); });
els.thrClose.addEventListener('click', () => els.thrDialog.close());
els.thrDialog.addEventListener('close', () => {
  selectedZone = null;
  highlightSelected(null);
});

// --- Mapping dialog and calibration ----------------------------------------

els.calibrate.addEventListener('click', () => {
  if (els.dialog.open) els.dialog.close();
  selectedZone = null;
  highlightSelected(null);
  calibration = { index: 0, done: 0 };
  nextCalibrationZone();
});
els.calibrateSkip.addEventListener('click', () => { if (calibration) nextCalibrationZone(); });
els.calibrateStop.addEventListener('click', stopCalibration);

els.dialogListen.addEventListener('click', () => {
  learning = learning ? null : { zone: selectedZone, heldZone: -1, frames: 0 };
  renderZoneDetail();
});
els.dialogClose.addEventListener('click', () => els.dialog.close());
els.dialog.addEventListener('close', () => { learning = null; });

// --- Tuning forms and sliders ----------------------------------------------

// Reset-to-defaults sits in the Signal-processing header (same command and
// notice the old Presets card used).
document.getElementById('proc-reset-defaults').addEventListener('click', () => {
  send('preset default');
  notify('Default preset applied - use Save to flash to keep it', 'warn');
});

// A slider under the pointer must not change value while the page is scrolled.
document.querySelectorAll('input[type="range"]').forEach((slider) => {
  slider.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });
});

// Guard the slider like the number fields: while it has focus (being dragged),
// a config refresh must not snap it back to the current average.
els.thresholdAllValue.addEventListener('focus', () => { editing = els.thresholdAllValue; });
els.thresholdAllValue.addEventListener('blur', () => { editing = null; });
els.thresholdAllValue.addEventListener('input', () => {
  els.thresholdAllOut.textContent = els.thresholdAllValue.value;
});
els.thresholdAll.addEventListener('submit', (event) => {
  event.preventDefault();
  send(`thr all ${els.thresholdAllValue.value}`);
  notify(`Every zone set to ${els.thresholdAllValue.value}`);
});

els.rebase.addEventListener('click', () => {
  send('rebase');
  notify('Idle level set from the current readings');
});

// --- Console events --------------------------------------------------------

els.consoleForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (els.command.value.trim()) send(els.command.value.trim());
  els.command.value = '';
});
els.consoleClear.addEventListener('click', () => {
  state.console = [];
  transport?.clear?.();
  render(state);
});

document.querySelectorAll('[data-cmd]').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.confirm && !window.confirm(button.dataset.confirm)) return;
    send(button.dataset.cmd);
  });
});

// Any "?" help button (static or built at runtime) opens the option dialog.
document.addEventListener('click', (e) => {
  const info = e.target.closest('.opt-info');
  if (info && info.dataset.help) openOptHelp(info.dataset.help);
});

els.disconnect.addEventListener('click', async () => {
  els.disconnect.disabled = true;
  await transport?.disconnect?.();
  location.reload();
});

// --- Startup ---------------------------------------------------------------

const livePads = new Map();

// This cabinet needs a couple of families flipped vs the stock geometry, for the
// preview only: D is on the outer ring (E inside), and C1 is on the right (C2 on
// the left).
function swapDE(geo) {
  for (let i = 1; i <= 8; i += 1) {
    const d = `D${i}`;
    const e = `E${i}`;
    const tmp = geo[d];
    geo[d] = geo[e];
    geo[e] = tmp;
  }
  const c = geo.C1;
  geo.C1 = geo.C2;
  geo.C2 = c;
  return geo;
}

function start() {
  zones = zoneNames();
  activeSection = document.querySelector('.nav button.active')?.dataset.section || 'info';
  buildGlobalLegend();
  buildGlobalLegend(document.getElementById('calib-trace-all-legend'));
  buildGlobalLegend(document.getElementById('calib-verify-trace-legend'));
  buildLogTable();
  renderLastTriggers();
  updateRecordStatus();
  renderProfiles();
  calibInit();
  liveCalInit();
  initLiveThr();
  initAutoSave();
  geometry = swapDE({ ...ZONES_GEOMETRY });

  buildDisc(els.liveDisc, livePads, (zone) => {
    els.viewZone.click();
    toggleLive({ kind: 'zone', index: zones.indexOf(zone) });
  });
  buildDisc(els.thrDisc, thrPads, openThresholdDialog);
  buildDisc(els.mapDisc, mapPads, selectZoneForMapping);
  // Step-2 playfield copy: clicking a pad jumps to that zone, like its chip.
  buildDisc(cel.pressDisc, calibPressPads, (zone) => {
    const pos = calib.pressOrder.indexOf(zones.indexOf(zone));
    if (pos >= 0) calibJumpTo(pos);
  });

  transport = createTransport(state, () => render(state));

  els.connect.hidden = false;
  // The sidebar Connect button and the gate's inline "Connect" trigger the same
  // flow, so the gate is a first-class way to connect from any locked tab.
  const connectButtons = [els.connect, ...document.querySelectorAll('.connect-inline')];
  const connectBoard = async () => {
    connectButtons.forEach((b) => { b.disabled = true; });
    try {
      await transport.connect();
      els.connect.hidden = true;
    } catch (error) {
      state.error = String(error.message || error);
      render(state);
    }
    connectButtons.forEach((b) => { b.disabled = false; });
  };
  connectButtons.forEach((b) => b.addEventListener('click', connectBoard));
  els.link.textContent = 'click Connect to pick the board';

  // Lock the shell before the first frame arrives, so the tabs read correctly
  // on load rather than only after the first render.
  updateConnectGate(true);
}

start();
