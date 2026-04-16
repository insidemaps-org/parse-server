/**
 * Loki Logger for Parse Server — pushes structured logs to Grafana Loki.
 *
 * Adapted from web-legacy-api-server's loki-logger.js.
 * Sends logs to the Alloy sidecar at localhost:3100 which forwards to Loki.
 *
 * Label strategy (Loki stream labels):
 *   Static:
 *     - application  = "legacy-website"
 *     - service      = "parse-server"
 *     - environment  = from LOKI_ENVIRONMENT env var
 *   Per-entry:
 *     - level        = "info" | "warn" | "error" | "fatal"
 *     - source       = "routes" | "console" | "system"
 *
 * All other metadata is stored as structured JSON in the log line body
 * and is queryable via LogQL:  | json | fieldName = "value"
 *
 * Configuration via environment variables:
 *   LOKI_ENABLED          — "true" to enable (default: false)
 *   LOKI_HOST             — push endpoint (default: http://127.0.0.1:3100)
 *   LOKI_ENVIRONMENT      — e.g. "production", "stage"
 *   LOKI_BATCH_SIZE       — entries per flush (default: 100)
 *   LOKI_FLUSH_INTERVAL   — ms between flushes (default: 5000)
 *   LOKI_MAX_QUEUE_SIZE   — max queued entries (default: 1000)
 *   LOKI_MAX_RETRIES      — retries before dropping a batch (default: 5)
 */

'use strict';

/** Initial backoff delay in ms — doubles on each consecutive failure. */
const BASE_BACKOFF_MS = 1000;
/** Ceiling for backoff delay. */
const MAX_BACKOFF_MS = 30000;
/** Maximum serialized size (chars) for a single metadata value. */
const MAX_FIELD_JSON_LENGTH = 10000;

class LokiLogger {
  constructor() {
    const enabled = (process.env.LOKI_ENABLED || '').toLowerCase() === 'true';
    if (!enabled) {
      this.enabled = false;
      return;
    }

    this.enabled = true;
    this.host = (process.env.LOKI_HOST || 'http://127.0.0.1:3100').replace(/\/+$/, '');

    this.staticLabels = {
      service: 'parse-server',
      environment: process.env.LOKI_ENVIRONMENT || process.env.NODE_ENV || 'unknown',
      application: 'legacy-website',
    };

    this.batchSize = parseInt(process.env.LOKI_BATCH_SIZE, 10) || 100;
    this.flushIntervalMs = parseInt(process.env.LOKI_FLUSH_INTERVAL, 10) || 5000;
    this.timeout = parseInt(process.env.LOKI_TIMEOUT, 10) || 10000;
    this.maxQueueSize = parseInt(process.env.LOKI_MAX_QUEUE_SIZE, 10) || 1000;
    this.maxRetries = parseInt(process.env.LOKI_MAX_RETRIES, 10) || 5;

    this.batch = [];
    this.isFlushing = false;

    // Backoff state
    this._consecutiveFailures = 0;
    this._nextFlushAfter = 0;

    // Nanosecond-precision timestamp state
    this._lastMs = 0;
    this._nanoOffset = BigInt(0);

    // Re-entrancy guard for console interception
    this._inLogConsole = false;

    // Periodic flush timer
    this._timer = setInterval(() => this._flush(), this.flushIntervalMs);
    if (this._timer.unref) this._timer.unref();

    console.log(`[LokiLogger] Enabled → pushing to ${this.host} (labels: ${JSON.stringify(this.staticLabels)})`);
  }

  /**
   * Enqueue a structured route/request log entry.
   * @param {'info'|'warn'|'error'} level
   * @param {object} meta — request/response metadata from the middleware
   */
  log(level, meta) {
    if (!this.enabled) return;

    try {
      const entryLabels = { level, source: 'routes' };

      const entry = {
        level,
        timestamp: new Date().toISOString(),
        source: 'routes',
        ...this._sanitize(meta),
      };

      this._enqueue(entryLabels, entry);
    } catch (err) {
      console.error('[LokiLogger] Error enqueuing log:', err.message);
    }
  }

  /**
   * Enqueue a console-originated log entry (console.log/info/warn/error).
   * @param {'info'|'warn'|'error'|'debug'} level
   * @param {string} message
   * @param {string} [stackTrace]
   */
  logConsole(level, message, stackTrace) {
    if (!this.enabled) return;
    // Guard against re-entrancy
    if (this._inLogConsole) return;
    this._inLogConsole = true;

    try {
      const normalizedLevel = level === 'debug' ? 'info' : level;
      const entryLabels = { level: normalizedLevel, source: 'console' };

      const entry = {
        level: normalizedLevel,
        timestamp: new Date().toISOString(),
        source: 'console',
        message,
      };

      if (stackTrace) entry.stackTrace = stackTrace;

      this._enqueue(entryLabels, entry);
    } catch (e) {
      // Silently swallow to prevent loops
    } finally {
      this._inLogConsole = false;
    }
  }

  /**
   * Log a fatal / critical error to Loki.
   * @param {Error|string} error
   * @param {string} source — e.g. "UncaughtException"
   * @param {object} [extra]
   */
  logFatal(error, source, extra = {}) {
    if (!this.enabled) return;

    const errorObj = error instanceof Error ? error : new Error(String(error));
    const entryLabels = { level: 'fatal', source: 'system' };

    const entry = {
      level: 'fatal',
      timestamp: new Date().toISOString(),
      source,
      message: errorObj.message,
      stack: errorObj.stack || '',
      errorName: errorObj.name || 'Error',
      ...this._sanitize(extra),
    };

    try {
      this._enqueue(entryLabels, entry);
    } catch (err) {
      console.error('[LokiLogger] Error enqueuing fatal log:', err.message);
    }
  }

  /**
   * Log a fatal error and immediately flush.
   * Designed for crash handlers where the process is about to exit.
   */
  async logFatalAndFlush(error, source, extra = {}) {
    this.logFatal(error, source, extra);
    this._nextFlushAfter = 0;
    this._consecutiveFailures = 0;

    if (this.isFlushing) {
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (!this.isFlushing) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      });
    }

    await this._flush();
  }

  /**
   * Force-flush remaining entries. Call from graceful shutdown handlers.
   */
  async shutdown() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._nextFlushAfter = 0;
    this._consecutiveFailures = 0;
    await this._flush();
  }

  // ── Internal ──────────────────────────────────────────────────────

  _enqueue(entryLabels, entry) {
    const now = Date.now();
    if (now === this._lastMs) {
      this._nanoOffset++;
    } else {
      this._lastMs = now;
      this._nanoOffset = BigInt(0);
    }
    const nowNs = (BigInt(now) * BigInt(1000000) + BigInt(this._nanoOffset)).toString();

    // Hard-cap on queue size
    if (this.batch.length >= this.maxQueueSize) {
      const toDrop = Math.max(1, Math.floor(this.maxQueueSize * 0.1));
      this.batch.splice(0, toDrop);
    }

    this.batch.push({ labels: entryLabels, ts: nowNs, line: JSON.stringify(entry) });

    if (this.batch.length >= this.batchSize) {
      this._flush();
    }
  }

  async _flush() {
    if (this.batch.length === 0 || this.isFlushing) return;
    if (Date.now() < this._nextFlushAfter) return;

    this.isFlushing = true;
    const entries = this.batch.splice(0);

    // Group entries by full label set → separate Loki streams
    const streamMap = new Map();
    for (const { labels: entryLabels, ts, line } of entries) {
      const fullLabels = { ...this.staticLabels, ...entryLabels };
      const key = JSON.stringify(fullLabels);
      if (!streamMap.has(key)) {
        streamMap.set(key, { stream: fullLabels, values: [] });
      }
      streamMap.get(key).values.push([ts, line]);
    }

    const body = { streams: Array.from(streamMap.values()) };

    try {
      const url = `${this.host}/loki/api/v1/push`;
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(tid);

        if (response.ok) {
          this._consecutiveFailures = 0;
          this._nextFlushAfter = 0;
        } else {
          const text = await response.text().catch(() => '');
          console.error(
            `[LokiLogger] Push failed: ${response.status} ${response.statusText}` +
            ` (batch=${entries.length}, queue=${this.batch.length})` +
            (text ? ` - ${text.slice(0, 500)}` : '')
          );
          if (response.status >= 500 || response.status === 429) {
            const wasDropped = this._requeue(entries);
            if (!wasDropped) this._applyBackoff();
          }
        }
      } finally {
        clearTimeout(tid);
      }
    } catch (err) {
      console.error(
        `[LokiLogger] Network error: ${err.message}` +
        ` (batch=${entries.length}, queue=${this.batch.length})`
      );
      const wasDropped = this._requeue(entries);
      if (!wasDropped) this._applyBackoff();
    } finally {
      this.isFlushing = false;
    }
  }

  _requeue(entries) {
    if (this._consecutiveFailures >= this.maxRetries) {
      console.warn(
        `[LokiLogger] Max retries (${this.maxRetries}) reached — dropping ${entries.length} entries`
      );
      this._consecutiveFailures = 0;
      this._nextFlushAfter = 0;
      return true;
    }

    this.batch = entries.concat(this.batch);
    if (this.batch.length > this.maxQueueSize) {
      const dropped = this.batch.length - this.maxQueueSize;
      this.batch = this.batch.slice(dropped);
    }
    return false;
  }

  _applyBackoff() {
    this._consecutiveFailures++;
    const delay = Math.min(
      BASE_BACKOFF_MS * Math.pow(2, this._consecutiveFailures - 1),
      MAX_BACKOFF_MS
    );
    this._nextFlushAfter = Date.now() + delay;
    console.warn(`[LokiLogger] Backing off for ${delay}ms (failure #${this._consecutiveFailures})`);
  }

  _sanitize(meta) {
    if (!meta || typeof meta !== 'object') return {};
    const clean = {};
    for (const [key, value] of Object.entries(meta)) {
      if (typeof value === 'function') continue;
      if (value instanceof Date) {
        clean[key] = value.toISOString();
      } else if (typeof value === 'object' && value !== null) {
        try {
          const str = JSON.stringify(value);
          if (str.length < MAX_FIELD_JSON_LENGTH) {
            clean[key] = value;
          }
        } catch (e) {
          // non-serializable — drop
        }
      } else {
        clean[key] = value;
      }
    }
    return clean;
  }
}

module.exports = LokiLogger;
