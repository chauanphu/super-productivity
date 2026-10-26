import pkg from '../../package.json';

export const environment = {
  production: true,
  stage: true,
  version: pkg.version,
  // Mandatory SuperSync login gate (off only in the e2e build, see environment.e2e.ts).
  isLoginRequired: true,
};
