let logsFolder = (() => {
  let folder = './logs/';
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
    folder = './test_logs/'
  }
  folder = process.env.PARSE_SERVER_LOGS_FOLDER || folder;
  return folder;
})();

let { verbose, level } = (() => {
  let verbose = process.env.VERBOSE ? JSON.parse(process.env.VERBOSE.toString().toLowerCase()) : false;
  return { verbose, level: (verbose ? 'verbose' : 'info') };
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
  schemaCacheTTL: 5000, // in ms
  sendgridApiKey: process.env.SENDGRID_APIKEY
}
