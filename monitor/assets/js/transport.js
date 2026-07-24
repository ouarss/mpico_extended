/*
 * WebSerial link to a Mai Pico board.
 *
 * The page talks to the board's "Command Line" CDC interface directly: nothing
 * else to run, but Chrome or Edge only, and the port must be picked once from
 * the browser prompt. Opened straight from disk (file://), there is no backend.
 */

// --- Firmware constants (verified on the device) ---------------------------

const USB_VENDOR_ID = 0x0ca3;
const USB_PRODUCT_ID = 0x0021;
// Meaningless on a USB CDC port, but the WebSerial API demands a rate.
const BAUD_RATE = 115200;

const N_ZONES = 34;         // A1-8 B1-8 C1-2 D1-8 E1-8
const N_ELECTRODES = 36;    // 3 x MPR121, 12 electrodes each
// F <36 filtered> <36 delta> <16-hex zone bitmap>
const F_TOKENS = 1 + 2 * N_ELECTRODES + 1;   // 74

const CLI_PROMPT = 'mai_pico>';
// Holds a full command reply comfortably; the page only redraws the console
// when its content changes, so the cap is about memory, not speed.
const CONSOLE_LINES = 200;

const ENCODER = new TextEncoder();

/** Append with a rolling cap - one definition of the log semantics. */
const pushCapped = (list, item, cap) => [...list, item].slice(-cap);

/** Console writes bump a version counter so the page can detect a change by
 *  comparing two integers instead of re-joining ~200 lines every frame. */
function logConsole(state, text) {
  state.console = pushCapped(state.console, text, CONSOLE_LINES);
  state.consoleVersion = (state.consoleVersion || 0) + 1;
}

/** A C line must at least carry the arrays the page indexes blindly; a
 *  truncated-but-valid JSON would otherwise crash every later render. */
function isUsableConfig(c) {
  return c && Array.isArray(c.thr) && c.thr.length === N_ZONES
    && Array.isArray(c.map) && c.map.length === N_ELECTRODES;
}

/**
 * A 16-hex zone bitmap is 64 bits, past the 2^53 exact-integer range, so it is
 * read as two 32-bit halves. The high half (first 8 hex) carries bits 63..32,
 * the low half (last 8 hex) bits 31..0.
 */
function parseZoneBitmap(hex) {
  const high = parseInt(hex.slice(0, 8), 16);
  const low = parseInt(hex.slice(8, 16), 16);
  const active = new Array(N_ZONES).fill(false);
  for (let z = 0; z < N_ZONES; z += 1) {
    active[z] = z < 32
      ? Boolean((low >>> z) & 1)
      : Boolean((high >>> (z - 32)) & 1);
  }
  return active;
}

/** Parses the firmware's output lines and folds them into shared state. */
function createParser(state, onUpdate) {
  let started = 0;
  let frames = 0;

  return function handleLine(text) {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Config JSON, republished on `feed on` and after every setting change.
    if (trimmed[0] === 'C' && trimmed[1] === ' ') {
      try {
        const parsed = JSON.parse(trimmed.slice(2));
        if (isUsableConfig(parsed)) {
          state.config = parsed;
          onUpdate();
          return;
        }
      } catch { /* truncated line, ignore */ }
    }

    const parts = trimmed.split(/\s+/);

    // Live frame: F <36 filtered> <36 delta> <bitmap16hex>
    if (parts[0] === 'F' && parts.length === F_TOKENS) {
      const filtered = parts.slice(1, 1 + N_ELECTRODES).map(Number);
      const deltas = parts.slice(1 + N_ELECTRODES, 1 + 2 * N_ELECTRODES).map(Number);
      if (filtered.some(Number.isNaN) || deltas.some(Number.isNaN)) return;

      state.filtered = filtered;
      state.deltas = deltas;
      state.zonesActive = parseZoneBitmap(parts[F_TOKENS - 1]);

      frames += 1;
      if (!started) started = performance.now();
      const elapsed = (performance.now() - started) / 1000;
      if (elapsed > 0.5) state.rate = Math.round((frames / elapsed) * 10) / 10;

      onUpdate();
      return;
    }

    // Anything else - command echoes, replies, diagnostics - is console text.
    logConsole(state, text);
    onUpdate();
  };
}

/** Reads the board's command port straight from the page. */
function webSerialTransport(state, onUpdate) {
  const handleLine = createParser(state, onUpdate);
  let writer = null;
  let reader = null;
  let opened = null;
  let pumping = null;
  let buffer = '';

  /*
   * Release the port before the page goes away. A port left open stays claimed
   * by the dead page, and the next open fails - including after a plain reload.
   */
  function releaseOnUnload() {
    const close = () => {
      try { reader?.cancel(); } catch { /* already gone */ }
      try { writer?.releaseLock(); } catch { /* already gone */ }
      try { opened?.close(); } catch { /* already gone */ }
    };
    window.addEventListener('pagehide', close);
    window.addEventListener('beforeunload', close);
  }

  // Decode the raw stream ourselves rather than piping through a
  // TextDecoderStream: the firmware echoes character by character, and a plain
  // buffer split on '\n' absorbs that cleanly.
  async function pump(port) {
    reader = port.readable.getReader();
    const decoder = new TextDecoder();

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let cut = buffer.indexOf('\n');
        while (cut >= 0) {
          handleLine(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 1);
          cut = buffer.indexOf('\n');
        }
        // A line this long means we lost sync; drop it rather than let the
        // buffer grow without bound.
        if (buffer.length > 8192) buffer = '';
      }
    } finally {
      reader.releaseLock();
    }
  }

  return {
    label: 'WebSerial',
    needsConnect: true,

    async connect() {
      if (!('serial' in navigator)) {
        throw new Error('This browser has no WebSerial. Use Chrome or Edge.');
      }
      const port = await navigator.serial.requestPort({
        filters: [{ usbVendorId: USB_VENDOR_ID, usbProductId: USB_PRODUCT_ID }],
      });
      await port.open({ baudRate: BAUD_RATE });
      opened = port;
      writer = port.writable.getWriter();
      releaseOnUnload();

      state.connected = true;
      state.source = 'Mai Pico (WebSerial)';
      state.error = '';
      onUpdate();

      port.addEventListener?.('disconnect', () => {
        state.connected = false;
        state.error = 'board unplugged';
        onUpdate();
      });

      pumping = pump(port).catch((error) => {
        state.connected = false;
        state.error = String(error.message || error);
        onUpdate();
      });

      // Only `feed on`: it starts the live frames and makes the board
      // republish its configuration (the C line). There is no `cfg` command.
      await this.send('feed on');
    },

    async send(command) {
      if (!writer) {
        logConsole(state, `not connected: ${command}`);
        onUpdate();
        return;
      }
      try {
        await writer.write(ENCODER.encode(`\r\n${command}\r\n`));
      } catch (error) {
        // A silent failure here is the worst kind: the control looks dead and
        // nothing explains why.
        logConsole(state, `send failed: ${error.message || error}`);
        onUpdate();
      }
    },

    clear() {
      state.console = [];
      state.consoleVersion = (state.consoleVersion || 0) + 1;
      onUpdate();
    },

    // Hand the port back cleanly. Cancelling the reader ends the pump loop,
    // which releases its lock; only then can the port close, freeing it for the
    // next open. Awaited by the caller before it reloads.
    async disconnect() {
      state.connected = false;
      try { await reader?.cancel(); } catch { /* already gone */ }
      try { await pumping; } catch { /* pump already ended */ }
      try { writer?.releaseLock(); } catch { /* already gone */ }
      try { await opened?.close(); } catch { /* already gone */ }
      reader = writer = opened = null;
      onUpdate();
    },
  };
}

/*
 * Redraw at most once per animation frame. Frames arrive ~25 times a second
 * and each command adds console lines, so redrawing on every one of them would
 * run the full render far more often than the screen can show it.
 */
function throttle(render) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  };
}

/** Start point shared with monitor.js: WebSerial is the only transport. */
function createTransport(state, render) {
  return webSerialTransport(state, throttle(render));
}
