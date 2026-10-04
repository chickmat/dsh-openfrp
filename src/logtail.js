/**
 * dsh-openfrp — live log reading.
 *
 * The verified fact this module exists for (docs §13): a running Minecraft
 * server appends to `logs/latest.log` **in real time**. But the log file is the
 * *only* observation channel that survives the human owning the server process,
 * so it has to be read carefully:
 *
 *  - **Polling, not fs.watch**: `fs.watch` is unreliable on Windows for files
 *    that are appended to by another process, and it does not survive rotation.
 *  - **Track a byte offset** and only read the delta — otherwise a multi-MB log
 *    gets re-read on every tick.
 *  - **Handle truncation/rotation**: the server renames `latest.log` to a dated
 *    `.log.gz` on startup, so a shrinking file means "start over from 0".
 *  - **Never equate quiet with dead.** An idle server logs nothing at all
 *    (measured: 47 seconds of zero growth). Liveness must be probed by other
 *    means — see `service.js` diagnosis.
 *
 * @module dsh-openfrp/logtail
 */

import fs from 'node:fs';

/** Read the last `count` lines without loading the whole file. */
export function readTailLines(file, count = 50) {
  try {
    const { size } = fs.statSync(file);
    const window = Math.min(size, Math.max(64 * 1024, count * 512));
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(window);
      const bytes = fs.readSync(fd, buffer, 0, window, size - window);
      const text = buffer.subarray(0, bytes).toString('utf8');
      const lines = text.split(/\r?\n/);
      // A partial first line is expected when the window does not start at a line boundary.
      if (size > window) lines.shift();
      const trimmed = lines.filter(line => line !== '');
      return trimmed.slice(-count);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** Current size, or -1 when the file does not exist yet. */
function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

/** Read up to `length` bytes at `start`; returns what was actually read. */
function readAt(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

/** How many trailing bytes we remember to detect a rewritten file. */
const VERIFY_WINDOW = 16;

/**
 * Follow a growing log file.
 *
 * Rotation/truncation is detected two ways, because size alone is not enough:
 * a rewritten file whose new content is *longer* than our offset would never
 * look like it shrank. So we also keep a small fingerprint of the bytes we last
 * consumed and re-check it before reading the delta.
 *
 * @param {string} file
 * @param {object} [options]
 * @param {number} [options.intervalMs] poll interval (default 250ms)
 * @param {number} [options.fromOffset] start byte; `-1` (default) means "start at end"
 * @param {(line:string)=>void} [options.onLine]
 * @returns {{stop:()=>void, offset:()=>number, seen:()=>number}}
 */
export function tailFile(file, { intervalMs = 250, fromOffset = -1, onLine } = {}) {
  let offset = fromOffset >= 0 ? fromOffset : Math.max(0, sizeOf(file) === -1 ? 0 : sizeOf(file));
  let stopped = false;
  let seen = 0;
  let carry = '';
  let timer = null;
  /** Trailing bytes we already consumed; empty means "no fingerprint yet". */
  let fingerprint = Buffer.alloc(0);

  const reset = () => {
    offset = 0;
    carry = '';
    fingerprint = Buffer.alloc(0);
  };

  const refreshFingerprint = () => {
    if (offset <= 0) {
      fingerprint = Buffer.alloc(0);
      return;
    }
    const length = Math.min(VERIFY_WINDOW, offset);
    fingerprint = readAt(file, offset - length, length);
  };

  const tick = () => {
    if (stopped) return;
    try {
      const size = sizeOf(file);
      if (size === -1) {
        // Not created yet, or rotated away entirely; wait for it to reappear.
        reset();
        return;
      }

      if (size < offset) {
        // Plain truncation (the server renames latest.log and starts a new one).
        reset();
      } else if (fingerprint.length > 0 && offset >= fingerprint.length) {
        // The bytes we thought we had consumed are no longer there: the file was
        // rewritten in place with content at least as long as before.
        const window = readAt(file, offset - fingerprint.length, fingerprint.length);
        if (!window.equals(fingerprint)) reset();
      }

      if (size > offset) {
        const bytes = readAt(file, offset, size - offset);
        offset += bytes.length;
        const text = carry + bytes.toString('utf8');
        const parts = text.split(/\r?\n/);
        carry = parts.pop() ?? '';
        for (const line of parts) {
          if (line === '') continue;
          seen += 1;
          onLine?.(line);
        }
        refreshFingerprint();
      }
    } catch {
      // Transient Windows sharing failures are normal while the server writes;
      // the next tick retries.
    }
  };

  timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    offset: () => offset,
    seen: () => seen,
  };
}

/**
 * Watch for a pattern to appear in a file, resolving with the match.
 * This is the readiness handshake: `Done (...)!` for Minecraft, or the frpc
 * "proxy is available now" line for a tunnel.
 *
 * 等待某个 pattern 出现 —— 就绪握手的实现。
 *
 * @returns {Promise<{match:RegExpMatchArray, line:string}>}
 */
export function waitForLine(file, pattern, { timeoutMs = 120_000, intervalMs = 200, fromOffset = -1, onLine } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const watch = tailFile(file, {
      intervalMs,
      fromOffset,
      onLine: line => {
        onLine?.(line);
        if (settled) return;
        const match = pattern.exec(line);
        if (match !== null) {
          settled = true;
          watch.stop();
          clearTimeout(timer);
          resolve({ match, line });
        }
      },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      watch.stop();
      reject(new Error(`等待 ${pattern} 超时（${timeoutMs}ms），最后读取到偏移 ${watch.offset()}，共 ${watch.seen()} 行`));
    }, timeoutMs);
    timer.unref?.();
  });
}

/**
 * Collect lines for a fixed duration and return them. Useful for "what just
 * happened?" without asking the human to copy a console window.
 *
 * 固定时长收集日志行。
 */
export function collectLines(file, { durationMs = 2000, intervalMs = 200, max = 500, fromOffset = -1 } = {}) {
  return new Promise(resolve => {
    const lines = [];
    const watch = tailFile(file, {
      intervalMs,
      fromOffset,
      onLine: line => {
        if (lines.length < max) lines.push(line);
      },
    });
    const timer = setTimeout(() => {
      watch.stop();
      resolve(lines);
    }, durationMs);
    timer.unref?.();
  });
}
