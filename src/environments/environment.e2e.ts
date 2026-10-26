// Playwright e2e build (`--configuration e2e`): like environment.ts, but without the
// mandatory login gate so tests start in the app; SuperSync tests log in explicitly.
import pkg from '../../package.json';

export const environment = {
  production: false,
  stage: false,
  version: pkg.version,
  isLoginRequired: false,
};
