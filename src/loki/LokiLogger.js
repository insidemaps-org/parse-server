/**
 * Loki Logger for Parse Server — pushes structured logs to Grafana Loki.
 *
 * Sends logs to the Alloy sidecar at localhost:3100 which forwards to Loki.
 *
 * NOTE: Uses plain Promises instead of async/await because this Parse
 * Server's Babel config (targeting Node 4.6) transpiles async to
 * regeneratorRuntime which is not polyfilled — same pattern as
 * ValkeyCacheAdapter.js in this codebase.
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

var BASE_BACKOFF_MS       = 1000;
var MAX_BACKOFF_MS        = 30000;
var MAX_FIELD_JSON_LENGTH = 10000;

function LokiLogger() {
  var enabled = (process.env.LOKI_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) {
    this.enabled = false;
    return;
  }

  this.enabled = true;
  this.host = (process.env.LOKI_HOST || 'http://127.0.0.1:3100').replace(/\/+$/, '');

  this.staticLabels = {
    service:     'parse-server',
    environment: process.env.LOKI_ENVIRONMENT || process.env.NODE_ENV || 'unknown',
    application: 'legacy-website',
  };

  this.batchSize       = parseInt(process.env.LOKI_BATCH_SIZE,    10) || 100;
  this.flushIntervalMs = parseInt(process.env.LOKI_FLUSH_INTERVAL, 10) || 5000;
  this.timeout         = parseInt(process.env.LOKI_TIMEOUT,        10) || 10000;
  this.maxQueueSize    = parseInt(process.env.LOKI_MAX_QUEUE_SIZE,  10) || 1000;
  this.maxRetries      = parseInt(process.env.LOKI_MAX_RETRIES,     10) || 5;

  this.batch      = [];
  this.isFlushing = false;

  this._consecutiveFailures = 0;
  this._nextFlushAfter      = 0;
  this._lastMs              = 0;
  this._nanoOffset          = BigInt(0);
  this._inLogConsole        = false;

  var self = this;
  this._timer = setInterval(function() { self._flush(); }, this.flushIntervalMs);
  if (this._timer.unref) this._timer.unref();

  console.log('[LokiLogger] Enabled → pushing to ' + this.host +
    ' (labels: ' + JSON.stringify(this.staticLabels) + ')');
}

LokiLogger.prototype.log = function(level, meta) {
  if (!this.enabled) return;
  try {
    var entry = Object.assign(
      { level: level, timestamp: new Date().toISOString(), source: 'routes' },
      this._sanitize(meta)
    );
    this._enqueue({ level: level, source: 'routes' }, entry);
  } catch (err) {
    console.error('[LokiLogger] Error enqueuing log:', err.message);
  }
};

LokiLogger.prototype.logConsole = function(level, message, stackTrace) {
  if (!this.enabled) return;
  if (this._inLogConsole) return;
  this._inLogConsole = true;
  try {
    var normalizedLevel = level === 'debug' ? 'info' : level;
    var entry = {
      level:     normalizedLevel,
      timestamp: new Date().toISOString(),
      source:    'console',
      message:   message,
    };
    if (stackTrace) entry.stackTrace = stackTrace;
    this._enqueue({ level: normalizedLevel, source: 'console' }, entry);
  } catch (e) {
    // swallow — prevent loops
  } finally {
    this._inLogConsole = false;
  }
};

/**
 * Synchronously enqueue a fatal entry. Safe to call from uncaughtException
 * handlers — no async I/O, just an array push.
 */
LokiLogger.prototype.logFatal = function(error, source, extra) {
  if (!this.enabled) return;
  extra = extra || {};
  var errorObj = error instanceof Error ? error : new Error(String(error));
  var entry = Object.assign(
    {
      level:     'fatal',
      timestamp: new Date().toISOString(),
      source:    source,
      message:   errorObj.message,
      stack:     errorObj.stack || '',
      errorName: errorObj.name || 'Error',
    },
    this._sanitize(extra)
  );
  try {
    this._enqueue({ level: 'fatal', source: 'system' }, entry);
  } catch (err) {
    console.error('[LokiLogger] Error enqueuing fatal log:', err.message);
  }
};

/**
 * Flush remaining entries and return a Promise.
 * Call from graceful shutdown handlers (SIGTERM).
 */
LokiLogger.prototype.shutdown = function() {
  if (this._timer) {
    clearInterval(this._timer);
    this._timer = null;
  }
  this._nextFlushAfter      = 0;
  this._consecutiveFailures = 0;
  return this._flush();
};

// ── Internal ──────────────────────────────────────────────────────

LokiLogger.prototype._enqueue = function(entryLabels, entry) {
  var now = Date.now();
  if (now === this._lastMs) {
    this._nanoOffset = this._nanoOffset + BigInt(1);
  } else {
    this._lastMs     = now;
    this._nanoOffset = BigInt(0);
  }
  var nowNs = (BigInt(now) * BigInt(1000000) + this._nanoOffset).toString();

  if (this.batch.length >= this.maxQueueSize) {
    var toDrop = Math.max(1, Math.floor(this.maxQueueSize * 0.1));
    this.batch.splice(0, toDrop);
  }

  this.batch.push({ labels: entryLabels, ts: nowNs, line: JSON.stringify(entry) });

  if (this.batch.length >= this.batchSize) {
    this._flush();
  }
};

LokiLogger.prototype._flush = function() {
  var self = this;

  if (this.batch.length === 0 || this.isFlushing) return Promise.resolve();
  if (Date.now() < this._nextFlushAfter)            return Promise.resolve();

  this.isFlushing = true;
  var entries = this.batch.splice(0);

  // Group entries by full label set → separate Loki streams
  var streamMap = {};
  for (var i = 0; i < entries.length; i++) {
    var e         = entries[i];
    var fullLabels = Object.assign({}, this.staticLabels, e.labels);
    var key       = JSON.stringify(fullLabels);
    if (!streamMap[key]) streamMap[key] = { stream: fullLabels, values: [] };
    streamMap[key].values.push([e.ts, e.line]);
  }

  var streams = Object.keys(streamMap).map(function(k) { return streamMap[k]; });
  var body    = JSON.stringify({ streams: streams });
  var url     = this.host + '/loki/api/v1/push';

  var controller = new AbortController();
  var tid = setTimeout(function() { controller.abort(); }, this.timeout);

  return fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    body,
    signal:  controller.signal,
  })
  .then(function(response) {
    clearTimeout(tid);
    if (response.ok) {
      self._consecutiveFailures = 0;
      self._nextFlushAfter      = 0;
      return;
    }
    return response.text().catch(function() { return ''; }).then(function(text) {
      console.error('[LokiLogger] Push failed: ' + response.status + ' ' + response.statusText +
        ' (batch=' + entries.length + ', queue=' + self.batch.length + ')' +
        (text ? ' - ' + text.slice(0, 500) : ''));
      if (response.status >= 500 || response.status === 429) {
        if (!self._requeue(entries)) self._applyBackoff();
      }
    });
  })
  .catch(function(err) {
    clearTimeout(tid);
    console.error('[LokiLogger] Network error: ' + err.message +
      ' (batch=' + entries.length + ', queue=' + self.batch.length + ')');
    if (!self._requeue(entries)) self._applyBackoff();
  })
  .then(function() {
    self.isFlushing = false;
  });
};

LokiLogger.prototype._requeue = function(entries) {
  if (this._consecutiveFailures >= this.maxRetries) {
    console.warn('[LokiLogger] Max retries (' + this.maxRetries + ') reached — dropping ' + entries.length + ' entries');
    this._consecutiveFailures = 0;
    this._nextFlushAfter      = 0;
    return true;
  }
  this.batch = entries.concat(this.batch);
  if (this.batch.length > this.maxQueueSize) {
    this.batch = this.batch.slice(this.batch.length - this.maxQueueSize);
  }
  return false;
};

LokiLogger.prototype._applyBackoff = function() {
  this._consecutiveFailures++;
  var delay = Math.min(
    BASE_BACKOFF_MS * Math.pow(2, this._consecutiveFailures - 1),
    MAX_BACKOFF_MS
  );
  this._nextFlushAfter = Date.now() + delay;
  console.warn('[LokiLogger] Backing off for ' + delay + 'ms (failure #' + this._consecutiveFailures + ')');
};

LokiLogger.prototype._sanitize = function(meta) {
  if (!meta || typeof meta !== 'object') return {};
  var clean = {};
  var keys  = Object.keys(meta);
  for (var i = 0; i < keys.length; i++) {
    var key   = keys[i];
    var value = meta[key];
    if (typeof value === 'function') continue;
    if (value instanceof Date) {
      clean[key] = value.toISOString();
    } else if (typeof value === 'object' && value !== null) {
      try {
        if (JSON.stringify(value).length < MAX_FIELD_JSON_LENGTH) clean[key] = value;
      } catch (e) { /* non-serializable — drop */ }
    } else {
      clean[key] = value;
    }
  }
  return clean;
};

module.exports = LokiLogger;
