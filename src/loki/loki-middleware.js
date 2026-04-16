/**
 * Loki Middleware for Parse Server — captures structured request/response
 * metadata and sends it to Grafana Loki via LokiLogger.
 *
 * Also intercepts console.log/info/warn/error so ALL output from the parse
 * process is available in Grafana.
 *
 * Parse-specific metadata captured per request:
 *   - className      — the Parse class being operated on (e.g. "_User", "Project")
 *   - operation      — CRUD operation (find, get, create, update, delete, run)
 *   - parseUserId    — the requesting user's objectId (if authenticated)
 *   - isMasterKey    — whether the request used the master key
 *   - clientSDK      — SDK version string (e.g. "js1.11.1")
 *   - installationId — client installation ID
 *   - functionName   — cloud function name (for /functions routes)
 *   - statusCode     — HTTP response status
 *   - responseTimeMs — request duration
 *   - contentLength  — response body size
 *   - method         — HTTP method
 *   - url            — request URL path
 *   - ip             — client IP
 */

'use strict';

const LokiLogger = require('./LokiLogger');

let lokiLogger;
let _initialized = false;

// Paths to skip logging (health checks)
const SKIP_PATHS = ['/health', '/healthz'];

/**
 * Initialize the Loki logger, console interception, and crash handlers.
 * Call once at startup. Returns the express middleware function.
 * Safe to call multiple times — only the first call initializes.
 */
function initLokiMiddleware() {
  if (!_initialized) {
    _initialized = true;
    try {
      lokiLogger = new LokiLogger();
      if (lokiLogger.enabled) {
        global.PARSE_LOKI_LOGGER = lokiLogger;
        _interceptConsole();
      }
    } catch (err) {
      console.error('[loki-middleware] Init failed:', err.message);
    }
  }

  return lokiMiddleware;
}

/**
 * Express middleware — attaches to res.on('finish') to log request/response metadata.
 */
function lokiMiddleware(req, res, next) {
  if (!lokiLogger || !lokiLogger.enabled) return next();

  // Skip health checks
  const urlPath = req.path || req.url;
  if (SKIP_PATHS.some(p => urlPath === p || urlPath.startsWith(p + '?'))) {
    return next();
  }

  const startTime = Date.now();

  res.on('finish', () => {
    try {
      const responseTimeMs = Date.now() - startTime;

      // ── Extract Parse-specific metadata ────────────────────────
      const meta = {
        method: req.method,
        url: req.originalUrl || req.url,
        ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress,
        statusCode: res.statusCode,
        responseTimeMs,
        contentLength: res.getHeader('content-length') || 0,
        userAgent: req.headers['user-agent'],
      };

      // Parse attaches config/auth to req via handleParseHeaders middleware
      if (req.config) {
        meta.appId = req.config.applicationId;
      }
      if (req.auth) {
        if (req.auth.user) {
          meta.parseUserId = req.auth.user.id;
        }
        meta.isMasterKey = !!req.auth.isMaster;
      }
      if (req.info) {
        meta.clientSDK = req.info.clientVersion || (req.info.clientSDK && JSON.stringify(req.info.clientSDK));
        meta.installationId = req.info.installationId;
      }

      // Extract className and operation from the URL
      // Parse URLs look like: /parse/1/classes/ClassName, /parse/1/functions/funcName, etc.
      const parsedRoute = _parseRoute(req.method, req.originalUrl || req.url);
      if (parsedRoute.className) meta.className = parsedRoute.className;
      if (parsedRoute.operation) meta.operation = parsedRoute.operation;
      if (parsedRoute.functionName) meta.functionName = parsedRoute.functionName;
      if (parsedRoute.objectId) meta.objectId = parsedRoute.objectId;

      // Determine log level from status code
      const level = res.statusCode >= 500 ? 'error'
                   : res.statusCode >= 400 ? 'warn'
                   : 'info';

      lokiLogger.log(level, meta);
    } catch (err) {
      // Don't let logging errors surface
    }
  });

  next();
}

/**
 * Parse the route URL to extract className, operation, functionName, objectId.
 */
function _parseRoute(method, url) {
  const result = {};

  // Remove query string
  const path = url.split('?')[0];

  // Match /classes/ClassName/objectId?
  const classMatch = path.match(/\/classes\/([^/]+)(?:\/([^/]+))?/);
  if (classMatch) {
    result.className = classMatch[1];
    result.objectId = classMatch[2];
    switch (method) {
      case 'GET':    result.operation = classMatch[2] ? 'get' : 'find'; break;
      case 'POST':   result.operation = 'create'; break;
      case 'PUT':    result.operation = 'update'; break;
      case 'DELETE':  result.operation = 'delete'; break;
    }
    return result;
  }

  // Match /functions/functionName
  const funcMatch = path.match(/\/functions\/([^/]+)/);
  if (funcMatch) {
    result.functionName = funcMatch[1];
    result.operation = 'run';
    return result;
  }

  // Match /users, /sessions, /roles, /installations, /schemas, etc.
  const builtinMatch = path.match(/\/(users|sessions|roles|installations|schemas|push|login|logout|requestPasswordReset|verifyEmail|batch)(?:\/([^/]+))?/);
  if (builtinMatch) {
    result.className = '_' + builtinMatch[1].charAt(0).toUpperCase() + builtinMatch[1].slice(1);
    result.objectId = builtinMatch[2];

    if (builtinMatch[1] === 'login') {
      result.className = '_User';
      result.operation = 'login';
    } else if (builtinMatch[1] === 'logout') {
      result.className = '_Session';
      result.operation = 'logout';
    } else if (builtinMatch[1] === 'requestPasswordReset') {
      result.className = '_User';
      result.operation = 'requestPasswordReset';
    } else if (builtinMatch[1] === 'batch') {
      result.operation = 'batch';
      result.className = undefined;
    } else {
      switch (method) {
        case 'GET':    result.operation = builtinMatch[2] ? 'get' : 'find'; break;
        case 'POST':   result.operation = 'create'; break;
        case 'PUT':    result.operation = 'update'; break;
        case 'DELETE':  result.operation = 'delete'; break;
      }
    }
    return result;
  }

  return result;
}

/**
 * Monkey-patch console methods to also push to Loki.
 */
function _interceptConsole() {
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const levelMap = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };

  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = function (...args) {
      // Always call original first
      original(...args);

      try {
        const message = args.map(a => {
          if (a instanceof Error) return a.stack || a.message;
          if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch (e) { return String(a); }
          }
          return String(a);
        }).join(' ');

        // Extract stack trace if any arg is an Error
        let stackTrace;
        for (const a of args) {
          if (a instanceof Error && a.stack) { stackTrace = a.stack; break; }
        }

        lokiLogger.logConsole(levelMap[method], message, stackTrace);
      } catch (e) {
        // Swallow — can't risk infinite loops
      }
    };
  }
}

/**
 * Get the current Loki logger instance (for shutdown handlers).
 */
function getLokiLogger() {
  return lokiLogger;
}

module.exports = { initLokiMiddleware, getLokiLogger };
