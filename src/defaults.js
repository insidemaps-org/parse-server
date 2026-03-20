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
  // Schema rarely changes at runtime – cache it for 5 minutes instead of 5 seconds.
  // This eliminates ~96 unnecessary _SCHEMA queries/minute across Parse workers.
  // If you deploy schema changes, restart Parse or wait ≤5 min for propagation.
  schemaCacheTTL: 300000, // 5 minutes (was 5000ms / 5s)
  sendgridApiKey: process.env.SENDGRID_APIKEY,
  // General object/session/role cache TTL. 30s is safe for production reads –
  // objects updated within 30s will still be consistent on the next cache miss.
  // Reduces repeated DB lookups for the same session token, user, role, etc.
  cacheTTL: 30000, // 30 seconds (was 5000ms / 5s)
  // Larger cache = fewer evictions under load. 10k entries was tight for a
  // production workload with thousands of sessions + roles + schemas.
  cacheMaxSize: 50000, // (was 10000)
  userSensitiveFields: [],
  objectIdSize: 10,
  masterKeyIps: []
}
