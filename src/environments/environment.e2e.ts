// Playwright e2e build (`--configuration e2e`): like environment.ts, but without the
// mandatory login gate so tests start in the app; SuperSync tests log in explicitly.
import pkg from '../../package.json';

export const environment = {
  production: false,
  stage: false,
  version: pkg.version,
  isLoginRequired: false,
  // The e2e SuperSync server (e2e/utils/supersync-helpers.ts SUPERSYNC_BASE_URL); the app is served elsewhere.
  superSyncBaseUrl: 'http://localhost:1901',
};
