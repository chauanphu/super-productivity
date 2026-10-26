// This file is the default environment configuration for development
import pkg from '../../package.json';

export const environment = {
  production: false,
  stage: false,
  version: pkg.version,
  // Mandatory SuperSync login gate (off only in the e2e build, see environment.e2e.ts).
  isLoginRequired: true,
};
