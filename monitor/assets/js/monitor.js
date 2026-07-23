// UI logic for the Mai Pico monitor. Constants N_ZONES / N_ELECTRODES come from
// transport.js (same script scope); short aliases keep the loops readable.
const N_Z = N_ZONES;         // 34 zones
const N_E = N_ELECTRODES;    // 36 electrodes
const SENSORS = 3;           // 3 x MPR121
const PER_SENSOR = N_E / SENSORS;   // 12 electrodes each
const UNMAPPED = 255;        // map[e] === 255: electrode not connected

const SVG_NS = 'http://www.w3.org/2000/svg';
const CX = 210;
const CY = 210;

// Card bars auto-scale to the deltas actually seen. Real-world deltas (through
// wires, ITO and glass) are far smaller than direct-on-sensor tests, so a fixed
// 1023 scale would barely move. barScale eases toward the recent peak, with a
// floor so small deltas and low thresholds stay readable. Updated each frame.
const BAR_FLOOR = 120;
let barScale = BAR_FLOOR;
const SPARK_LEN = 240;       // trace ring-buffer length, ~10 s at 25 Hz

// CLI prompt for the console colouring.
const PROMPT_RE = /^(mai_pico>\s?)(.*)$/;

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

function send(command) {
  transport?.send(command);
}

// --- Elements --------------------------------------------------------------

const els = {
  link: document.getElementById('link'),
  rate: document.getElementById('rate'),
  connect: document.getElementById('connect'),
  disconnect: document.getElementById('disconnect'),
  saveBanner: document.getElementById('save-banner'),
  saveMessage: document.getElementById('save-message'),
  active: document.getElementById('active'),
  liveDisc: document.getElementById('live-disc'),
  spark: document.getElementById('spark'),
  sparkLabel: document.getElementById('spark-label'),
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
};

const needsConfig = document.querySelectorAll('.needs-config');

// --- Small helpers ---------------------------------------------------------

let toastTimer = null;

function notify(message, tone = 'ok') {
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
    onCommit(input.value);
    editing = null;
  });
  return input;
}

function polar(angleDeg, radius) {
  const rad = (angleDeg * Math.PI) / 180;
  return [CX + radius * Math.sin(rad), CY - radius * Math.cos(rad)];
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
}

function drawSpark() {
  const canvas = els.spark;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const target = selectionTarget();
  if (!target || target.electrode < 0 || !config) return;

  const hyst = config.hyst || 0;
  const on = target.threshold;
  const off = Math.round(on * (1 - hyst / 100));
  const peak = sparkBuffer.length ? Math.max(...sparkBuffer) : 0;
  const scale = Math.max(on * 1.6, peak * 1.1, 40);
  const y = (v) => h - (Math.min(v, scale) / scale) * (h - 8) - 4;

  const line = (value, colour) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y(value));
    ctx.lineTo(w, y(value));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  if (on > 0) line(on, '#ff5c5c');       // threshold ON  (var --hot)
  if (off > 0) line(off, '#ffb000');     // threshold OFF (var --warn)

  if (sparkBuffer.length > 1) {
    ctx.strokeStyle = '#4ea1ff';         // delta (var --accent)
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    sparkBuffer.forEach((value, i) => {
      const px = (i / (SPARK_LEN - 1)) * w;
      if (i === 0) ctx.moveTo(px, y(value));
      else ctx.lineTo(px, y(value));
    });
    ctx.stroke();
  }
}

// One distinct hue per zone, shared by the global trace and its legend.
function zoneColor(z) {
  return `hsl(${Math.round((z / N_Z) * 360)}, 70%, 60%)`;
}

// Global trace: every zone's delta at once, on a shared auto-scaled axis.
function drawGlobalSpark() {
  const canvas = els.sparkAll;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  let peak = 40;
  for (const buf of allBuffers) {
    for (const v of buf) {
      if (v > peak) peak = v;
    }
  }
  const scale = peak * 1.1;
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
}

function buildGlobalLegend() {
  if (!els.sparkAllLegend) return;
  els.sparkAllLegend.textContent = '';
  zones.forEach((zone, z) => {
    const item = document.createElement('span');
    const dot = document.createElement('i');
    dot.style.background = zoneColor(z);
    item.append(dot, document.createTextNode(zone));
    els.sparkAllLegend.appendChild(item);
  });
}

// --- Signal-processing controls (Tuning) -----------------------------------

// References to the built inputs, so a config refresh can update them.
const proc = {};

// Per-option help, shown by the "?" buttons in a modal dialog.
const OPTION_HELP = {
  hyst: {
    title: 'Release margin (hysteresis)',
    body: `<p>Once a zone is <b>on</b>, it stays on until its delta falls back to
      <b>threshold x (1 - hyst%)</b>. This gap stops a reading hovering right at
      the threshold from rattling on and off.</p>
      <p>Higher = steadier hold, slightly later release. 0 releases exactly at the
      threshold. Typical 20-40%.</p>`,
  },
  avg: {
    title: 'Averaging',
    body: `<p>Averages the last N filtered samples of each electrode before the
      delta is computed, smoothing electrical noise so a one-frame spike cannot
      trigger.</p>
      <p>Every added frame is a frame of latency, so keep it low. <b>1 disables
      it</b> (lowest latency). Raise it only if a zone still flickers once its
      threshold is set.</p>`,
  },
  latency: {
    title: 'Added delay (latency)',
    body: `<p>Holds the final decision back by N frames before it is reported.
      This is a pure timing offset - it does <b>not</b> filter noise.</p>
      <p>Leave at 0 unless you specifically need to delay the output. Higher =
      more input lag.</p>`,
  },
  debounce: {
    title: 'Debounce',
    body: `<p>A zone must stay above its threshold for <b>on</b> consecutive
      samples before it turns on, and below the release level for <b>off</b>
      samples before it turns off.</p>
      <p>Low <b>on</b> = fast press; higher <b>off</b> = a hold that will not drop
      out mid-press. This is the main tool against brief spurious triggers.</p>`,
  },
  gain: {
    title: 'Gain (CDC / CDT)',
    body: `<p>The MPR121 analog front-end. <b>CDC</b> (charge/discharge current,
      0-63) and <b>CDT</b> (charge/discharge time, 0-7) set how hard the
      electrodes are driven - effectively the raw scale of the readings.</p>
      <p>Higher gain = a bigger delta for the same touch, but also more noise.
      Change only if deltas are too small or saturating, then re-tune the
      thresholds.</p>`,
  },
  filter: {
    title: 'Filter (FFI / SFI / ESI)',
    body: `<p>The MPR121's own smoothing of the raw signal, before the firmware
      even sees it. Three stages:</p>
      <p><b>FFI</b> - first-filter samples averaged per reading:
      0=6, 1=10, 2=18, 3=34. More = smoother but slower.</p>
      <p><b>SFI</b> - a second averaging stage: 0=4, 1=6, 2=10, 3=18 samples.
      Same trade-off.</p>
      <p><b>ESI</b> - time between samples: 0=1&nbsp;ms up to 7=128&nbsp;ms
      (1/2/4/8/16/32/64/128). Higher spreads samples over more time - steadier
      against noise, but the reading reacts more slowly.</p>
      <p><b>Combinations to try:</b></p>
      <p>&bull; <code>0 0 0</code> - fastest, noisiest.<br>
      &bull; <code>0 1 0</code> - light and responsive (firmware default).<br>
      &bull; <code>0 1 3</code> - good anti-noise without much lag.<br>
      &bull; <code>1 1 4</code> or <code>2 2 4</code> - very clean for noisy
      panels, at the cost of latency.</p>
      <p>On a noisy panel with small deltas, raise <b>ESI</b> first (it fights
      noise cheaply), then <b>SFI</b>; keep FFI low to stay responsive. Pair it
      with <b>debounce</b> (below) to drop the brief spikes.</p>`,
  },
  baseline: {
    title: 'Baseline tracking',
    body: `<p>The <b>baseline</b> is an electrode's level at rest, when nothing
      touches it - the "zero" a touch is measured against
      (delta = baseline - filtered).</p>
      <p>That resting level drifts slowly (temperature, humidity, dust), so it is
      tracked: the reference follows the drift, so a zone neither creeps toward
      triggering nor goes numb over time. It is <b>frozen while a zone is held</b>,
      so a long press is never slowly absorbed and dropped.</p>
      <p><b>Hardware</b> lets the MPR121 track it internally (recommended,
      simplest). <b>Software</b> tracks it in the firmware, one step every
      <i>rate</i> frames - pick it only to set the re-centring speed yourself.</p>
      <p>This is about slow drift, not speed: it does <b>not</b> affect touch
      latency. Use <b>Set idle level</b> to re-seed the reference at once.</p>`,
  },
  presets: {
    title: 'Presets',
    body: `<p><b>Default</b> restores the recommended processing values.
      <b>Flat threshold</b> sets one value on all 34 zones - a quick starting
      point before fine-tuning. <b>Set idle level</b> re-seeds the baseline from
      the current (untouched) readings.</p>
      <p>Nothing here reaches flash until you <b>Save to flash</b>.</p>`,
  },
  threshold: {
    title: 'Per-zone threshold',
    body: `<p>The delta a zone must reach to count as touched.
      <b>Higher = less sensitive.</b></p>
      <p>Through wires, ITO and glass, real deltas are <b>small</b> and vary with
      zone size - a firm press might peak around 25-170, while standby noise
      wanders by about ±10 with the odd spike. Set each threshold just above a
      zone's own <b>sustained</b> noise, not above the spikes.</p>
      <p>Then let <b>debounce</b> reject the brief spikes, so the threshold can
      stay low enough to catch a real (weak) press. Watch the zone's bar or trace
      to place it.</p>`,
  },
  level: {
    title: 'Brightness (level)',
    body: `<p>Global brightness of every LED, from <b>0</b> (off) to <b>255</b>
      (full). It scales all the button, cabinet and banner LEDs together.</p>
      <p>Lower it if the LEDs are too bright or draw too much current.</p>`,
  },
  rgb: {
    title: 'LED counts',
    body: `<p>How many LEDs are wired to each unit, so the firmware drives the
      right length of chain: <b>button</b> (per ring button), <b>cabinet</b> (per
      cabinet light) and <b>banner</b>. Each is 0-15; the three are sent
      together.</p>
      <p>Set a count to <b>0</b> to disable that group.</p>`,
  },
  rgbmap: {
    title: 'Button LED order',
    body: `<p>Which physical LED on the chain lights each ring button. The chips
      are laid out along the chain - position <b>0</b> on the left to <b>7</b> on
      the right - and each shows the button (<b>B1-B8</b>) that position drives.</p>
      <p><b>Drag</b> a chip to the position that should light it; the new order is
      sent as soon as you drop it. <b>Reset to default</b> restores the factory
      order.</p>`,
  },
  hid: {
    title: 'HID mode',
    body: `<p>How the board reports its inputs to the host over USB.</p>
      <p><b>IO4 (arcade)</b> emulates the arcade IO4 board - use it with SEGA
      arcade software. <b>Keyboard 1</b> and <b>Keyboard 2</b> send NKRO keyboard
      keys (two layouts) for PC play. <b>Off</b> disables HID reporting.</p>`,
  },
  aime: {
    title: 'AIME / NFC',
    body: `<p>The card reader. <b>Protocol mode</b> selects the reader firmware
      protocol the host expects (<b>0</b> or <b>1</b>).</p>
      <p><b>Virtual AIC</b> exposes a virtual card so the game sees a reader even
      without a physical AIC connected.</p>`,
  },
  tweak: {
    title: 'Button polarity (active-high)',
    body: `<p>Whether the button inputs read as pressed when driven <b>high</b>
      instead of low. <b>Main</b> covers the eight play buttons; <b>Aux</b> the
      Test / Service / Navigate / Coin buttons.</p>
      <p>Leave off unless the buttons read inverted (stuck on, or released when
      pressed).</p>`,
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
  latency: '0 (no added delay)',
  debounce: 'on 1, off 3',
  gain: 'cdc 16, cdt 1',
  filter: 'ffi 0, sfi 1, esi 3 for a noisy panel (default 0 1 0)',
  baseline: 'Hardware',
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
  procScalar('Added delay (latency)', 'latency', 0, 9,
    'Holds the result back before sending it.', 'latency', null);

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
  buildPresetControl();
}

function buildBaselineControl() {
  const box = document.createElement('div');
  box.className = 'proc';
  box.appendChild(procHead('Baseline tracking', 'baseline'));

  const btns = document.createElement('div');
  btns.className = 'proc-btns';
  proc.baselineHw = document.createElement('button');
  proc.baselineHw.type = 'button';
  proc.baselineHw.className = 'seg';
  proc.baselineHw.textContent = 'Hardware';
  proc.baselineHw.addEventListener('click', () => send('baseline hw'));
  proc.baselineSoft = document.createElement('button');
  proc.baselineSoft.type = 'button';
  proc.baselineSoft.className = 'seg';
  proc.baselineSoft.textContent = 'Software';
  proc.baselineSoft.addEventListener('click', () => send('baseline soft'));
  btns.append(proc.baselineHw, proc.baselineSoft);
  box.appendChild(btns);

  const rate = document.createElement('div');
  rate.className = 'proc-flat';
  const rateLabel = document.createElement('span');
  rateLabel.className = 'proc-detail';
  rateLabel.textContent = 'soft rate';
  proc.rate = editableNumber(0, 1, 60000, (v) => send(`baseline soft ${v}`));
  rate.append(rateLabel, proc.rate);
  box.appendChild(rate);

  const hint = document.createElement('small');
  hint.innerHTML = 'Hardware: the MPR121 tracks it internally.<br>'
    + 'Software: the firmware tracks it, at the rate below.<br>'
    + 'Either way, frozen while a zone is held.';
  box.appendChild(hint);
  els.processing.appendChild(box);
}

function buildPresetControl() {
  const box = document.createElement('div');
  box.className = 'proc proc-reset';
  box.appendChild(procHead('Presets', 'presets'));

  const btns = document.createElement('div');
  btns.className = 'proc-btns';
  const def = document.createElement('button');
  def.type = 'button';
  def.textContent = 'Default';
  def.addEventListener('click', () => {
    send('preset default');
    notify('Default preset applied - use Save to flash to keep it', 'warn');
  });
  const rebase = document.createElement('button');
  rebase.type = 'button';
  rebase.textContent = 'Set idle level';
  rebase.addEventListener('click', () => {
    send('rebase');
    notify('Idle level set from the current readings');
  });
  btns.append(def, rebase);
  box.appendChild(btns);

  const flat = document.createElement('div');
  flat.className = 'proc-flat';
  const flatInput = document.createElement('input');
  flatInput.type = 'number';
  flatInput.min = 1;
  flatInput.max = 1000;
  flatInput.value = 35;
  flatInput.addEventListener('focus', () => { editing = flatInput; });
  flatInput.addEventListener('blur', () => { editing = null; });
  const flatBtn = document.createElement('button');
  flatBtn.type = 'button';
  flatBtn.textContent = 'Flat threshold';
  flatBtn.addEventListener('click', () => {
    send(`preset flat ${flatInput.value}`);
    notify(`Every zone set to ${flatInput.value}`);
  });
  flat.append(flatInput, flatBtn);
  box.appendChild(flat);

  const hint = document.createElement('small');
  hint.textContent = 'Default restores the recommended processing values; Flat '
    + 'sets one threshold on every zone.';
  box.appendChild(hint);
  els.processing.appendChild(box);
}

// filter is a packed byte: ffi = bits 6-7, sfi = bits 4-5, esi = bits 0-2.
function decodeFilter(byte) {
  return { ffi: byte >> 6, sfi: (byte >> 4) & 3, esi: byte & 7 };
}

function refreshProcessing(cfg) {
  const set = (input, value) => { if (input && input !== editing) input.value = value; };
  set(proc.hyst, cfg.hyst);
  set(proc.avg, cfg.avg);
  set(proc.latency, cfg.latency);
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
  const chips = [...board.orderList.querySelectorAll('.led-chip')];
  const rgbmap = new Array(8).fill(0);
  chips.forEach((chip, position) => { rgbmap[Number(chip.dataset.button)] = position; });
  send(`rgbmap ${rgbmap.join(' ')}`);
}

// The chip the dragged one should be inserted before: the nearest chip whose
// horizontal centre is to the right of the pointer, or null to append at the
// end (pointer past every remaining chip).
function chipBeforeX(list, x) {
  const chips = [...list.querySelectorAll('.led-chip:not(.dragging)')];
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
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  chip.addEventListener('dragend', () => {
    chip.classList.remove('dragging');
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
  boardHint(counts, 'LED count per button, per cabinet light and for the banner '
    + '(0-15). The three are sent together.');

  const order = boardCard(grid, 'Button LED order', 'rgbmap');
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
  const hidMode = cfg.hidIo4 === 1 ? 'io4'
    : cfg.hidNkro === 1 ? 'key1'
      : cfg.hidNkro === 2 ? 'key2' : 'off';
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

// --- Threshold and mapping tables ------------------------------------------

const rowRefs = new Map();   // zone -> { thresholdInput, mappingInput, cells }

function buildZoneRow(zone, value, min, max, extraCell, onCommit) {
  const row = document.createElement('tr');
  row.dataset.zone = zone;

  const name = document.createElement('td');
  name.textContent = zone;
  name.className = 'zone-name';

  const valueCell = document.createElement('td');
  const input = editableNumber(value, min, max, onCommit);
  valueCell.appendChild(input);

  const extra = extraCell ? document.createElement('td') : null;
  if (extra) extra.className = 'deviation';

  const deviation = document.createElement('td');
  deviation.className = 'deviation';

  const gauge = document.createElement('td');
  gauge.innerHTML = '<div class="gauge"><span></span></div>';

  if (extra) row.append(name, valueCell, extra, deviation, gauge);
  else row.append(name, valueCell, deviation, gauge);

  return {
    row,
    input,
    extra,
    cell: { deviation, gauge: gauge.querySelector('span') },
  };
}

function buildThresholdTable(cfg) {
  els.thresholdRows.textContent = '';
  zones.forEach((zone, z) => {
    const built = buildZoneRow(zone, cfg.thr[z], 1, 1000, false,
      (v) => send(`thr ${zone} ${v}`));
    els.thresholdRows.appendChild(built.row);
    rowRefs.set(zone, { thresholdInput: built.input, cells: [built.cell] });
  });
}

function buildMappingTable(cfg) {
  els.mappingRows.textContent = '';
  zones.forEach((zone, z) => {
    const electrode = zoneToElectrode[z];
    // The number is the electrode (0..35); committing sends its sensor/channel.
    const built = buildZoneRow(zone, electrode < 0 ? '' : electrode, 0, N_E - 1, true,
      (v) => {
        const e = Number(v);
        if (!Number.isInteger(e) || e < 0 || e >= N_E) return;
        send(`touch ${Math.floor(e / PER_SENSOR)} ${e % PER_SENSOR} ${zone}`);
      });
    built.extra.textContent = electrode < 0 ? '-' : sensorChannel(electrode);
    els.mappingRows.appendChild(built.row);

    const refs = rowRefs.get(zone) || {};
    refs.mappingInput = built.input;
    refs.mappingExtra = built.extra;
    refs.cells = [...(refs.cells || []), built.cell];
    rowRefs.set(zone, refs);
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

// --- Render ----------------------------------------------------------------

let lastActive = null;

function render(data) {
  els.rate.textContent = data.rate;
  els.link.textContent = data.connected
    ? (data.source || 'connected')
    : (data.error || 'disconnected');
  els.link.className = `badge ${data.connected ? 'badge-on' : 'badge-off'}`;
  els.disconnect.hidden = !data.connected;

  const hasConfig = config !== null;
  needsConfig.forEach((el) => { el.hidden = hasConfig; });

  // Auto-scale the card bars to the deltas actually seen (rise fast, fall slow).
  const frameMax = data.deltas.reduce((m, v) => (v > m ? v : m), 0);
  const scaleTarget = Math.max(BAR_FLOOR, frameMax * 1.2);
  barScale += (scaleTarget - barScale) * (scaleTarget > barScale ? 0.4 : 0.02);

  if (data.config && data.config !== config) {
    // transport.js replaces state.config only on a fresh C line, so an identity
    // check is enough to know it changed.
    refreshConfig(data.config);
  }

  const consoleSig = data.console.join('\n');
  if (consoleSig !== lastConsole) {
    lastConsole = consoleSig;
    els.console.innerHTML = consoleHtml(data.console);
    els.console.scrollTop = els.console.scrollHeight;
  }

  // Active-zone readout and disc highlight, from the firmware's own bitmap.
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

  if (!config) { drawSpark(); return; }

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

  // Threshold / mapping tables, and the threshold-disc tint.
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
      const width = `${Math.min(100, (delta / threshold) * 100)}%`;
      refs.cells.forEach(({ deviation, gauge }) => {
        deviation.textContent = delta;
        deviation.classList.toggle('over', active);
        gauge.style.width = width;
        gauge.classList.toggle('over', active);
      });
    }
  });

  // Trace: append the selected electrode's delta, then redraw.
  const target = selectionTarget();
  if (target && target.electrode >= 0) {
    sparkBuffer.push(data.deltas[target.electrode]);
    while (sparkBuffer.length > SPARK_LEN) sparkBuffer.shift();
  }
  drawSpark();

  // Global trace: push every zone's delta and redraw all lines.
  for (let z = 0; z < N_Z; z += 1) {
    const e = zoneToElectrode[z];
    allBuffers[z].push(e >= 0 ? data.deltas[e] : 0);
    while (allBuffers[z].length > SPARK_LEN) allBuffers[z].shift();
  }
  drawGlobalSpark();

  trackLearning();
}

// --- Navigation ------------------------------------------------------------

document.querySelectorAll('.nav button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.nav button').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');
    document.querySelectorAll('.section').forEach((section) => {
      section.classList.toggle('active', section.dataset.section === button.dataset.section);
    });
    stopCalibration();
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

// This cabinet has D on the outer ring and E inside; the stock geometry draws
// them the other way round, so swap the two families for the preview only.
function swapDE(geo) {
  for (let i = 1; i <= 8; i += 1) {
    const d = `D${i}`;
    const e = `E${i}`;
    const tmp = geo[d];
    geo[d] = geo[e];
    geo[e] = tmp;
  }
  return geo;
}

function start() {
  zones = zoneNames();
  buildGlobalLegend();
  geometry = swapDE({ ...ZONES_GEOMETRY });

  buildDisc(els.liveDisc, livePads, (zone) => {
    els.viewZone.click();
    toggleLive({ kind: 'zone', index: zones.indexOf(zone) });
  });
  buildDisc(els.thrDisc, thrPads, openThresholdDialog);
  buildDisc(els.mapDisc, mapPads, selectZoneForMapping);

  transport = createTransport(state, () => render(state));

  els.connect.hidden = false;
  // The sidebar Connect button and every inline "Connect" in a needs-config
  // notice trigger the same flow.
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
}

start();
