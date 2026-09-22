#!/usr/bin/env node
// assetlinks.js — write /.well-known/assetlinks.json for the Android app.
//
// The Android wrapper in android/ is a Trusted Web Activity: Chrome renders
// relaaay.online full screen with no address bar, but only once it can prove
// that the site and the app belong to the same people. The proof is a Digital
// Asset Link, and it has two halves that must agree:
//
//   the app names the site   — asset_statements in android/app/build.gradle
//   the site names the app   — this file's output, served from the web root
//
// Get either half wrong and nothing breaks loudly; the app simply opens with a
// Chrome address bar across the top. That is the symptom to remember.
//
//   npm run assetlinks -- --keystore ../relay-release.jks --alias relay
//   npm run assetlinks -- --fingerprint AB:CD:...:EF
//   npm run assetlinks -- --keystore relay-release.jks --alias relay --check
//
// The fingerprint is the SHA-256 of the certificate the APK is signed with, so
// a debug build and a release build need different ones. Both may be listed;
// pass --fingerprint more than once, or --add to keep what is already there.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'public', '.well-known', 'assetlinks.json');

const DEFAULT_PACKAGE = 'online.relaaay.app';

/* ---------- fingerprints ---------- */

/**
 * Accept a fingerprint however it was copied: with or without colons, upper or
 * lower case, wrapped in the "SHA256: " label keytool prints.
 *
 * Returns the canonical form Google's verifier expects — 32 upper-case hex
 * pairs joined by colons — or throws saying what is wrong with it.
 */
export function normalizeFingerprint(input) {
  const raw = String(input ?? '').trim().replace(/^SHA-?256:?/i, '').trim();
  const hex = raw.replace(/[\s:]/g, '').toUpperCase();

  if (!hex) throw new Error('A fingerprint is empty.');
  if (!/^[0-9A-F]+$/.test(hex)) throw new Error(`Not a hex fingerprint: ${input}`);
  if (hex.length !== 64) {
    // The commonest mistake by far is pasting the SHA-1 line instead.
    const hint = hex.length === 40 ? ' — that looks like SHA-1; the SHA-256 line is the one below it' : '';
    throw new Error(`A SHA-256 fingerprint is 64 hex characters, got ${hex.length}${hint}.`);
  }
  return hex.match(/.{2}/g).join(':');
}

/** Ask keytool for the signing certificate's SHA-256 fingerprint. */
export function fingerprintFromKeystore({ keystore, alias, storepass }) {
  const args = ['-list', '-v', '-keystore', keystore];
  if (alias) args.push('-alias', alias);
  if (storepass) args.push('-storepass', storepass);

  let out;
  try {
    out = execFileSync('keytool', args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message).toString().trim().split('\n')[0];
    throw new Error(`keytool could not read ${keystore}: ${detail}`);
  }

  const match = out.match(/SHA256:\s*([0-9A-Fa-f:]+)/);
  if (!match) throw new Error(`No SHA-256 fingerprint in keytool's output for ${keystore}.`);
  return normalizeFingerprint(match[1]);
}

/* ---------- the statement ---------- */

/**
 * The document Google fetches from https://<host>/.well-known/assetlinks.json.
 *
 * One statement per app. Listing several fingerprints inside it is how a debug
 * build and a release build are both trusted without two deployments.
 */
export function assetLinks({ packageName = DEFAULT_PACKAGE, fingerprints = [] }) {
  const seen = [...new Set(fingerprints.map(normalizeFingerprint))];
  if (seen.length === 0) throw new Error('At least one fingerprint is required.');

  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: packageName,
      sha256_cert_fingerprints: seen,
    },
  }];
}

/** The fingerprints an existing document already trusts for this package. */
export function existingFingerprints(json, packageName = DEFAULT_PACKAGE) {
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s) => s?.target?.namespace === 'android_app' && s.target.package_name === packageName)
      .flatMap((s) => s.target.sha256_cert_fingerprints || []);
  } catch { return []; }
}

/* ---------- command line ---------- */

function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1] ?? '';
  };
  const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1] ?? ''] : []));
  const has = (name) => args.includes(name);

  if (has('--help') || has('-h')) {
    console.log(readFileSync(new URL(import.meta.url)).toString().split('\n')
      .filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return 0;
  }

  const packageName = flag('--package') || DEFAULT_PACKAGE;
  const fingerprints = all('--fingerprint');

  const keystore = flag('--keystore');
  if (keystore) {
    fingerprints.push(fingerprintFromKeystore({
      keystore,
      alias: flag('--alias'),
      storepass: flag('--storepass') || process.env.RELAY_KEYSTORE_PASSWORD,
    }));
  }

  if (fingerprints.length === 0) {
    console.error('Give a --keystore to read, or a --fingerprint to write. --help explains.');
    return 2;
  }

  let current = [];
  try { current = existingFingerprints(readFileSync(OUT, 'utf8'), packageName); } catch { /* none yet */ }

  const wanted = has('--add') ? [...current, ...fingerprints] : fingerprints;
  const body = `${JSON.stringify(assetLinks({ packageName, fingerprints: wanted }), null, 2)}\n`;

  if (has('--check')) {
    const missing = fingerprints
      .map(normalizeFingerprint)
      .filter((f) => !current.map(normalizeFingerprint).includes(f));
    if (missing.length) {
      console.error(`public/.well-known/assetlinks.json does not trust:\n  ${missing.join('\n  ')}`);
      return 1;
    }
    console.log(`public/.well-known/assetlinks.json trusts ${packageName} — the app will open without an address bar.`);
    return 0;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, body);
  console.log(`Wrote public/.well-known/assetlinks.json for ${packageName}:`);
  for (const f of assetLinks({ packageName, fingerprints: wanted })[0].target.sha256_cert_fingerprints) {
    console.log(`  ${f}`);
  }
  console.log('\nCommit it and deploy, then check https://<host>/.well-known/assetlinks.json is served as application/json.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
