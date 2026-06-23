'use strict';

/**
 * Shared request-scoped context for Loki logging.
 *
 * The loki-middleware wraps each incoming request in lokiRequestContext.run()
 * with the trace context forwarded by the API server (X-Trace-Id / X-Span-Id).
 * This lets console.* logs emitted while handling the request resolve the
 * originating traceId — so a single Grafana search by traceId surfaces both
 * the route log and any console output produced for that request.
 */

const { AsyncLocalStorage } = require('async_hooks');

const lokiRequestContext = new AsyncLocalStorage();

module.exports = lokiRequestContext;
