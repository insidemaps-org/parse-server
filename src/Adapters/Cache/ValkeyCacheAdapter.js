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

export class ValkeyCacheAdapter {
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
    if (!Redis) {
      throw new Error(
        'ValkeyCacheAdapter requires the "ioredis" package. ' +
        'Install it with: npm install ioredis'
      );
    }

    // Parse Server passes {appId, ttl, maxSize} via loadAdapter
    this.ttl = options.ttl || DEFAULT_TTL;
    this._connected = false;

    const redisOptions = {
      host: options.host || process.env.VALKEY_HOST || '127.0.0.1',
      port: options.port || parseInt(process.env.VALKEY_PORT) || 6379,
      password: options.password || process.env.VALKEY_PASSWORD || undefined,
      db: options.db || parseInt(process.env.VALKEY_DB) || 0,
      keyPrefix: options.keyPrefix || process.env.VALKEY_KEY_PREFIX || 'parse:',
      connectTimeout: options.connectTimeout || 10000,
      commandTimeout: options.commandTimeout || 5000,
      retryStrategy: (times) => {
        if (times > 10) {
          console.error('[Parse:ValkeyCacheAdapter] Max retry attempts reached');
          return null;
        }
        const delay = Math.min(times * 500, 5000);
        return delay;
      },
      lazyConnect: false,
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
    };

    // Enable TLS for AWS ElastiCache
    const useTls = options.tls === true || process.env.VALKEY_TLS === 'true';
    if (useTls) {
      redisOptions.tls = {};
    }

    this.client = new Redis(redisOptions);

    this.client.on('connect', () => {
      console.log(`[Parse:ValkeyCacheAdapter] Connected to ${redisOptions.host}:${redisOptions.port}`);
    });

    this.client.on('ready', () => {
      this._connected = true;
      console.log('[Parse:ValkeyCacheAdapter] Ready');
    });

    this.client.on('error', (err) => {
      console.error('[Parse:ValkeyCacheAdapter] Error:', err.message);
      this._connected = false;
    });

    this.client.on('close', () => {
      this._connected = false;
    });
  }

  /**
   * Get a value from cache.
   * Parse Server expects: resolve(null) on miss, resolve(value) on hit.
   */
  get(key) {
    debug('get', key);
    if (!this._connected) {
      return Promise.resolve(null);
    }
    return this.client.get(key).then((res) => {
      if (res === null) {
        return null;
      }
      try {
        return JSON.parse(res);
      } catch {
        return res;
      }
    }).catch((err) => {
      console.error(`[Parse:ValkeyCacheAdapter] get error for "${key}":`, err.message);
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
    if (!this._connected) {
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
        console.error(`[Parse:ValkeyCacheAdapter] put error for "${key}":`, err.message);
      });
    }

    // psetex = SET with TTL in milliseconds (Parse uses ms for cache TTL)
    return this.client.psetex(key, ttl, serialized).catch((err) => {
      console.error(`[Parse:ValkeyCacheAdapter] put error for "${key}":`, err.message);
    });
  }

  /**
   * Delete a key from cache.
   */
  del(key) {
    debug('del', key);
    if (!this._connected) {
      return Promise.resolve();
    }
    return this.client.del(key).catch((err) => {
      console.error(`[Parse:ValkeyCacheAdapter] del error for "${key}":`, err.message);
    });
  }

  /**
   * Clear all Parse cache keys.
   * Uses SCAN + DEL instead of FLUSHDB to avoid nuking other data in the same
   * ElastiCache instance (e.g., your Node API server's Valkey cache).
   */
  clear() {
    debug('clear');
    if (!this._connected) {
      return Promise.resolve();
    }
    // We need to get the keyPrefix to scan for our keys only
    const prefix = this.client.options.keyPrefix || 'parse:';
    return this._deleteByPattern(`${prefix}*`).catch((err) => {
      console.error('[Parse:ValkeyCacheAdapter] clear error:', err.message);
    });
  }

  /**
   * Delete all keys matching a pattern using SCAN (non-blocking).
   */
  async _deleteByPattern(pattern) {
    let cursor = '0';
    do {
      // Note: SCAN returns keys WITH the prefix when using ioredis keyPrefix,
      // but DEL needs keys WITHOUT the prefix. We handle this by creating a
      // raw (no-prefix) pipeline for deletion.
      const [newCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = newCursor;
      if (keys.length > 0) {
        // Strip the keyPrefix for deletion since ioredis auto-prepends it
        const prefix = this.client.options.keyPrefix || '';
        const strippedKeys = keys.map(k => k.startsWith(prefix) ? k.slice(prefix.length) : k);
        await this.client.del(...strippedKeys);
      }
    } while (cursor !== '0');
  }
}

export default ValkeyCacheAdapter;
