// Digital Asset Links.
//
// The Android app in android/ is Chrome without an address bar, and the only
// thing standing between those two states is this document being right. It is
// generated rather than hand-written because every failure mode is silent: a
// SHA-1 pasted where a SHA-256 belongs, a stray space, the wrong package name —
// none of them error, they just leave the address bar showing.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeFingerprint, assetLinks, existingFingerprints,
} from '../scripts/assetlinks.js';

const SHA256 = '20:21:E0:1A:66:6E:7F:EC:FD:4A:78:80:68:C3:D5:3D:72:5C:C6:AB:51:A3:2D:8F:B9:C2:7B:84:BB:66:78:02';
const OTHER = SHA256.replace(/^20/, '21');

describe('reading a fingerprint', () => {
  test('accepts it however it was copied out of keytool', () => {
    assert.equal(normalizeFingerprint(SHA256), SHA256);
    assert.equal(normalizeFingerprint(SHA256.toLowerCase()), SHA256);
    assert.equal(normalizeFingerprint(`  SHA256: ${SHA256}  `), SHA256);
    assert.equal(normalizeFingerprint(SHA256.replace(/:/g, '')), SHA256);
  });

  test('names the mistake rather than writing something that will not verify', () => {
    // Pasting the SHA-1 line is the commonest way to get this wrong, and the
    // symptom on the device says nothing about which line was copied.
    const sha1 = `${'AB:'.repeat(19)}CD`;
    assert.throws(() => normalizeFingerprint(sha1), /that looks like SHA-1/);

    assert.throws(() => normalizeFingerprint(''), /empty/);
    assert.throws(() => normalizeFingerprint('not a fingerprint'), /hex/);
    assert.throws(() => normalizeFingerprint(`${SHA256}:00`), /64 hex characters/);
  });
});

describe('the statement', () => {
  test('is the shape Google fetches', () => {
    const [statement] = assetLinks({ fingerprints: [SHA256] });
    assert.deepEqual(statement.relation, ['delegate_permission/common.handle_all_urls']);
    assert.equal(statement.target.namespace, 'android_app');
    assert.equal(statement.target.package_name, 'online.relaaay.app');
    assert.deepEqual(statement.target.sha256_cert_fingerprints, [SHA256]);
  });

  test('carries every key that should be trusted, once', () => {
    // A debug build and a release build are signed differently; both belong in
    // the same statement, and listing one twice is not an error worth failing.
    const [statement] = assetLinks({ fingerprints: [SHA256, OTHER, SHA256.toLowerCase()] });
    assert.deepEqual(statement.target.sha256_cert_fingerprints, [SHA256, OTHER]);
  });

  test('refuses to write a document that trusts nobody', () => {
    assert.throws(() => assetLinks({ fingerprints: [] }), /At least one fingerprint/);
  });
});

describe('reading a document that is already deployed', () => {
  const deployed = JSON.stringify(assetLinks({ fingerprints: [SHA256] }));

  test('finds what the site currently trusts', () => {
    assert.deepEqual(existingFingerprints(deployed), [SHA256]);
  });

  test('ignores statements about a different app', () => {
    assert.deepEqual(existingFingerprints(deployed, 'online.relaaay.other'), []);
    const web = JSON.stringify([{ relation: [], target: { namespace: 'web', site: 'https://relaaay.online' } }]);
    assert.deepEqual(existingFingerprints(web), []);
  });

  test('treats an unreadable document as trusting nothing, rather than throwing', () => {
    // --check runs against whatever is on disk, including nothing at all.
    assert.deepEqual(existingFingerprints('{ not json'), []);
    assert.deepEqual(existingFingerprints('{}'), []);
  });
});
