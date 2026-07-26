// preflight.js — checked before anything else loads.
//
// Imported first by server/index.js so it runs ahead of db.js. Without it, an
// older Node fails on `import 'node:sqlite'` with ERR_UNKNOWN_BUILTIN_MODULE,
// which tells a first-time installer nothing useful.

const REQUIRED = [22, 5, 0];

function parseVersion(v) {
  return String(v).replace(/^v/, '').split('.').slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
}

export function isSupported(version) {
  const [major, minor, patch] = parseVersion(version);
  const [rMajor, rMinor, rPatch] = REQUIRED;
  if (major !== rMajor) return major > rMajor;
  if (minor !== rMinor) return minor > rMinor;
  return patch >= rPatch;
}

export const requiredVersion = REQUIRED.join('.');

if (!isSupported(process.version)) {
  console.error(`
Relay needs Node ${requiredVersion} or newer, but this is ${process.version}.

Node's built-in SQLite (node:sqlite) arrived in 22.5.0, and Relay uses it so
that the project has no runtime dependencies to install.

  nvm install 22 && nvm use 22     # if you use nvm
  https://nodejs.org/en/download   # otherwise
`);
  process.exit(1);
}
