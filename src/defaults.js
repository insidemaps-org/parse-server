import {nullParser} from './cli/utils/parsers';

const logsFolder = (() => {
  let folder = './logs/';
  if (typeof process !== 'undefined' && process.env.TESTING === '1') {
    folder = './test_logs/'
  }
  if (process.env.PARSE_SERVER_LOGS_FOLDER) {
    folder = nullParser(process.env.PARSE_SERVER_LOGS_FOLDER);
  }
  return folder;
})();

const { verbose, level } = (() => {
  const verbose = process.env.VERBOSE ? true : false;
  return { verbose, level: verbose ? 'verbose' : undefined }
})();

export default {
  DefaultMongoURI: 'mongodb://localhost:27017/parse',
  jsonLogs: process.env.JSON_LOGS || false,
  logsFolder,
  verbose,
  level,
  silent: !verbose,
  enableAnonymousUsers: true,
  allowClientClassCreation: true,
  maxUploadSize: '20mb',
  verifyUserEmails: false,
  preventLoginWithUnverifiedEmail: false,
  sessionLength: 31536000,
  expireInactiveSessions: true,
  revokeSessionOnPasswordReset: true,
  // Schema cache TTL. 60s reduces _SCHEMA queries while keeping field additions
  // visible within 1 minute — no restart needed when adding new fields.
  schemaCacheTTL: 60000, // 1 minute (was 5000ms / 5s)
  sendgridApiKey: process.env.SENDGRID_APIKEY,
  // General session/role cache TTL.
  // WHAT IS CACHED: session tokens (keyed by token → user object) and role memberships.
  // WHAT IS NOT CACHED: general object query results — those always hit MongoDB directly.
  //
  // Cache invalidation on writes:
  //   - Sessions: explicitly invalidated on logout/delete (rest.js calls cacheAdapter.user.del).
  //   - Roles: NOT explicitly invalidated — a role membership change takes up to 30s to
  //     propagate to in-flight requests. This is acceptable for our access patterns.
  //
  // Saving a user object or any other Parse object does NOT serve stale data to
  // callers that do a direct query — only the session-token → user lookup uses this cache.
  cacheTTL: 30000, // 30 seconds (was 5000ms / 5s)
  // Larger cache = fewer evictions under load. 10k entries was tight for a
  // production workload with thousands of sessions + roles + schemas.
  cacheMaxSize: 50000, // (was 10000)
  userSensitiveFields: [],
  objectIdSize: 10,
  masterKeyIps: []
}
