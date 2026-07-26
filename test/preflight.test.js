import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isSupported, requiredVersion } from '../server/preflight.js';

describe('Node version gate', () => {
  test('accepts 22.5.0 and anything newer', () => {
    for (const v of ['v22.5.0', 'v22.5.1', 'v22.23.1', 'v23.0.0', 'v24.1.0']) {
      assert.equal(isSupported(v), true, `${v} should be accepted`);
    }
  });

  test('rejects anything older, including 22.4', () => {
    for (const v of ['v18.20.0', 'v20.11.0', 'v22.0.0', 'v22.4.9']) {
      assert.equal(isSupported(v), false, `${v} should be rejected`);
    }
  });

  test('tolerates version strings without a leading v', () => {
    assert.equal(isSupported('22.5.0'), true);
    assert.equal(isSupported('20.0.0'), false);
  });

  test('the version it advertises matches what package.json requires', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.engines.node, `>=${requiredVersion}`);
  });

  test('the running Node satisfies it, or these tests could not have run', () => {
    assert.equal(isSupported(process.version), true);
  });
});

describe('the install has nothing to install', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  test('no runtime or dev dependencies', () => {
    assert.equal(pkg.dependencies, undefined, 'a dependency would break "clone and run"');
    assert.equal(pkg.devDependencies, undefined);
  });

  test('the documented scripts exist', () => {
    for (const script of ['start', 'dev', 'test']) {
      assert.ok(pkg.scripts[script], `README documents "npm run ${script}"`);
    }
  });

  test('the startup file the instructions name is the real one', () => {
    assert.match(pkg.scripts.start, /server\/index\.js/);
  });
});
