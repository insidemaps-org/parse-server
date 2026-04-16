/**
 * ValkeyCacheAdapter — Parse Server cache adapter backed by AWS ElastiCache (Valkey/Redis).
 *
 * WHY THIS EXISTS:
 * ────────────────
 * The default InMemoryCacheAdapter creates a per-process LRU cache. When running
 * Parse Server with clustering (PARSE_SERVER_CLUSTER=2), each worker has its own
 * isolated cache. Session tokens, schemas, roles cached by worker A are invisible
 * to worker B — causing redundant MongoDB queries on every request that lands on
 * the "wrong" worker.
 *
 * By using ElastiCache (Valkey, Redis-compatible), all Parse workers (and even
 * all ECS tasks) share a single distributed cache. A session validated once is
 * cached for ALL workers across ALL tasks.
 *
 * WHAT PARSE SERVER CACHES:
 * ─────────────────────────
 * - Session tokens (validated per request → huge savings)
 * - Schema (the _SCHEMA collection — with enableSingleSchemaCache this is less
 *   of an issue, but still benefits from cross-task sharing)
 * - Roles / ACL lookups
 * - User objects for auth
 *
 * CONFIGURATION:
 * ──────────────
 * Pass as env vars to parse-server (or in databaseOptions):
 *
 *   PARSE_SERVER_CACHE_ADAPTER='./Adapters/Cache/ValkeyCacheAdapter.js'
 *   VALKEY_HOST='your-elasticache-endpoint.cache.amazonaws.com'
 *   VALKEY_PORT=6379
 *   VALKEY_TLS=true
 *   VALKEY_KEY_PREFIX='parse:'
 *
 * Or via the constructor options when using ParseServer programmatically:
 *
 *   cacheAdapter: {
 *     module: './Adapters/Cache/ValkeyCacheAdapter.js',
 *     options: {
 *       host: 'your-elasticache-endpoint',
 *       port: 6379,
 *       tls: true,
 *       keyPrefix: 'parse:',
 *     }
 *   }
 */

import { CacheAdapter } from './CacheAdapter';
import logger from '../../logger';

let Redis;
try {
  Redis = require('ioredis');
} catch (e) {
  // ioredis not installed — will fail at construction time with a clear message
}

const DEFAULT_TTL = 30 * 1000; // 30 seconds in milliseconds (Parse uses ms)

function debug(...args) {
  logger.debug.apply(logger, ['ValkeyCacheAdapter', ...args]);
}

export class ValkeyCacheAdapter extends CacheAdapter {
  /**
   * @param {Object} options
   * @param {string}  [options.host='127.0.0.1']   - Valkey/Redis host
   * @param {number}  [options.port=6379]           - Valkey/Redis port
   * @param {string}  [options.password]            - Auth password (if any)
   * @param {boolean} [options.tls=false]           - Enable TLS (required for AWS ElastiCache)
   * @param {number}  [options.db=0]                - Redis DB index
   * @param {string}  [options.keyPrefix='parse:']  - Key prefix to namespace Parse cache keys
   * @param {number}  [options.connectTimeout=10000] - Connection timeout in ms
   * @param {number}  [options.commandTimeout=5000]  - Per-command timeout in ms
   * @param {number}  [options.ttl=30000]           - Default TTL in milliseconds (Parse convention)
   * @param {string}  [options.appId]               - Parse appId (passed by loadAdapter, used for key namespacing)
   * @param {number}  [options.maxSize]              - Ignored (no LRU eviction in Redis, kept for API compat)
   */
  constructor(options = {}) {
    super();
    if (!Redis) {
      throw new Error(
        'ValkeyCacheAdapter requires the "ioredis" package. ' +
        'Install it with: npm install ioredis'
      );
    }

    // Parse Server passes {appId, ttl, maxSize} via loadAdapter
    this.ttl = options.ttl || DEFAULT_TTL;
    this._connected = false;

    // Track ENOBUFS errors to implement cooldown and avoid reconnect storms.
    // When the kernel socket buffer is full (ENOBUFS), hammering reconnect
    // only makes things worse. We back off and let the buffer drain.
    this._enobufsCount = 0;
    this._enobufsBackoff = false;
    this._enobufsBackoffTimer = null;

    const redisOptions = {
      host: options.host || process.env.VALKEY_HOST || '127.0.0.1',
      port: options.port || parseInt(process.env.VALKEY_PORT) || 6379,
      password: options.password || process.env.VALKEY_PASSWORD || undefined,
      db: options.db || parseInt(process.env.VALKEY_DB) || 0,
      keyPrefix: options.keyPrefix || process.env.VALKEY_KEY_PREFIX || 'parse:',
      connectTimeout: options.connectTimeout || 10000,
      // Per-command timeout: if Valkey can't respond in 500ms, it's faster to
      // fall through to MongoDB than to wait. A cache should be near-instant.
      commandTimeout: options.commandTimeout || 500,
      retryStrategy: (times) => {
        if (times > 5) {
          logger.error('[Parse:ValkeyCacheAdapter] Max retry attempts reached, giving up — falling back to DB');
          return null;
        }
        // Linear backoff capped at 500ms.
        const delay = Math.min(100 * times, 500);
        logger.info(`[Parse:ValkeyCacheAdapter] Reconnecting in ${delay}ms (attempt ${times})`);
        return delay;
      },
      lazyConnect: false,
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      // Prevent ioredis from buffering commands while disconnected.
      // Without this, thousands of commands pile up in memory during outages
      // and flood the server on reconnect, triggering ENOBUFS again.
      enableOfflineQueue: false,
    };

    // Enable TLS for AWS ElastiCache
    const useTls = options.tls === true || process.env.VALKEY_TLS === 'true';
    if (useTls) {
      redisOptions.tls = {};
    }

    this.client = new Redis(redisOptions);

    this.client.on('connect', () => {
      logger.info(`[Parse:ValkeyCacheAdapter] Connected to ${redisOptions.host}:${redisOptions.port}`);
    });

    this.client.on('ready', () => {
      this._connected = true;
      this._enobufsCount = 0; // Reset on successful reconnect
      logger.info('[Parse:ValkeyCacheAdapter] Ready');
    });

    this.client.on('error', (err) => {
      // ENOBUFS = kernel send buffer is full — the network can't keep up.
      // Hammering reconnects makes it worse. Enter a cooldown period where we
      // treat the cache as unavailable, letting the buffer drain before retrying.
      if (err.message && err.message.includes('ENOBUFS')) {
        this._enobufsCount++;
        this._connected = false;

        if (!this._enobufsBackoff) {
          this._enobufsBackoff = true;
          // Exponential cooldown: 5s, 10s, 20s, capped at 30s
          const cooldown = Math.min(5000 * Math.pow(2, Math.min(this._enobufsCount - 1, 3)), 30000);
          logger.error(`[Parse:ValkeyCacheAdapter] ENOBUFS #${this._enobufsCount} — cache disabled for ${cooldown}ms to let buffer drain`);
          clearTimeout(this._enobufsBackoffTimer);
          this._enobufsBackoffTimer = setTimeout(() => {
            this._enobufsBackoff = false;
            // _connected will be set to true by the 'ready' event if ioredis reconnects
            logger.info('[Parse:ValkeyCacheAdapter] ENOBUFS cooldown ended, allowing reconnect');
          }, cooldown);
          if (this._enobufsBackoffTimer.unref) this._enobufsBackoffTimer.unref();
        }
      } else {
        logger.error('[Parse:ValkeyCacheAdapter] Error:', err.message);
      }
      this._connected = false;
    });

    this.client.on('close', () => {
      this._connected = false;
    });
  }

  /**
   * Check if the cache is available for operations.
   * Returns false during ENOBUFS cooldown even if ioredis reconnects,
   * to avoid immediately re-saturating the buffer.
   */
  _isAvailable() {
    return this._connected && !this._enobufsBackoff;
  }

  /**
   * Get a value from cache.
   * Parse Server expects: resolve(null) on miss, resolve(value) on hit.
   */
  get(key) {
    debug('get', key);
    if (!this._isAvailable()) {
      return Promise.resolve(null);
    }
    return this.client.get(key).then((res) => {
      if (res === null) {
        return null;
      }
      try {
        return JSON.parse(res);
      } catch (e) {
        return res;
      }
    }).catch((err) => {
      logger.error(`[Parse:ValkeyCacheAdapter] get error for "${key}":`, err.message);
      return null; // Graceful degradation — treat as cache miss
    });
  }

  /**
   * Put a value into cache.
   * @param {string} key
   * @param {*} value
   * @param {number} [ttl] - TTL in milliseconds (Parse convention)
   */
  put(key, value, ttl = this.ttl) {
    debug('put', key, ttl);
    if (!this._isAvailable()) {
      return Promise.resolve();
    }
    if (ttl === 0) {
      return Promise.resolve(); // TTL of zero = no-op
    }
    if (ttl < 0 || isNaN(ttl)) {
      ttl = DEFAULT_TTL;
    }

    const serialized = JSON.stringify(value);

    if (ttl === Infinity) {
      return this.client.set(key, serialized).catch((err) => {
        logger.error(`[Parse:ValkeyCacheAdapter] put error for "${key}":`, err.message);
      });
    }

    // psetex = SET with TTL in milliseconds (Parse uses ms for cache TTL)
    return this.client.psetex(key, ttl, serialized).catch((err) => {
      logger.error(`[Parse:ValkeyCacheAdapter] put error for "${key}":`, err.message);
    });
  }

  /**
   * Delete a key from cache.
   */
  del(key) {
    debug('del', key);
    if (!this._isAvailable()) {
      return Promise.resolve();
    }
    return this.client.del(key).catch((err) => {
      logger.error(`[Parse:ValkeyCacheAdapter] del error for "${key}":`, err.message);
    });
  }

  /**
   * Clear all Parse cache keys.
   * Uses SCAN + DEL instead of FLUSHDB to avoid nuking other data in the same
   * ElastiCache instance (e.g., your Node API server's Valkey cache).
   */
  clear() {
    debug('clear');
    if (!this._isAvailable()) {
      return Promise.resolve();
    }
    // We need to get the keyPrefix to scan for our keys only
    const prefix = this.client.options.keyPrefix || 'parse:';
    return this._deleteByPattern(`${prefix}*`).catch((err) => {
      logger.error('[Parse:ValkeyCacheAdapter] clear error:', err.message);
    });
  }

  /**
   * Delete all keys matching a pattern using SCAN (non-blocking).
   * Uses recursive Promises instead of async/await because this Parse Server's
   * Babel config transpiles async to regeneratorRuntime which is not polyfilled.
   */
  _deleteByPattern(pattern) {
    const prefix = this.client.options.keyPrefix || '';
    const self = this;

    function scanAndDelete(cursor) {
      return self.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200).then(function (result) {
        const newCursor = result[0];
        const keys = result[1];
        let delPromise = Promise.resolve();
        if (keys.length > 0) {
          // Strip the keyPrefix for deletion since ioredis auto-prepends it
          const strippedKeys = keys.map(function (k) {
            return k.indexOf(prefix) === 0 ? k.slice(prefix.length) : k;
          });
          // Delete keys individually via a pipeline to avoid CROSSSLOT errors
          // in Redis Cluster mode. A multi-key DEL requires all keys to hash to
          // the same slot — that is never guaranteed across arbitrary cache keys.
          // A pipeline sends all commands in one round-trip but executes each
          // DEL independently, so slot placement doesn't matter.
          const pipeline = self.client.pipeline();
          strippedKeys.forEach(function (k) { pipeline.del(k); });
          delPromise = pipeline.exec();
        }
        return delPromise.then(function () {
          if (newCursor !== '0') {
            return scanAndDelete(newCursor);
          }
        });
      });
    }

    return scanAndDelete('0');
  }
}

export default ValkeyCacheAdapter;
