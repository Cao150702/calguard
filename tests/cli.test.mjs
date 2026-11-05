import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const [scenario, exitCode, deliveries] of [
  ['success', 0, 2], ['empty', 0, 0], ['all-notifiers-fail', 1, 0], ['combined', 1, 1], ['calendar-failure', 1, 0],
]) {
  test(`actual CLI one-shot process exits ${exitCode} for ${scenario} with entirely fake dependencies`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'calguard-cli-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const args = ['--loader', './tests/cli-loader.mjs', 'dist/cli/index.js', 'start', '--once'];
    const options = {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, CALGUARD_TEST_DIR: dir, CALGUARD_TEST_SCENARIO: scenario,
        CALGUARD_TEST_EVENT_START: new Date(Date.now() + 30 * 60000).toISOString() },
    };
    const result = spawnSync(process.execPath, args, options);
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, exitCode, result.stderr);
    const statePath = join(dir, '.calguard', 'state.json');
    assert.equal(existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')).length : 0, deliveries);
    assert.equal(existsSync(`${statePath}.lock`), false);
    if (exitCode === 1) {
      assert.match(result.stderr, /执行失败/); assert.doesNotMatch(result.stderr, /\[CalGuard\] 单次流程完成/);
    }
    if (scenario === 'combined') {
      assert.deepEqual(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n'), ['mail', 'calendar', 'feishu', 'workbuddy']);
      assert.match(result.stderr, /2 项失败/);
      const recovered = spawnSync(process.execPath, args, { ...options, env: { ...options.env, CALGUARD_TEST_SCENARIO: 'success' } });
      assert.equal(recovered.error, undefined); assert.equal(recovered.status, 0, recovered.stderr);
      assert.deepEqual(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n'),
        ['mail', 'calendar', 'feishu', 'workbuddy', 'mail', 'calendar', 'feishu']);
      assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).length, 2);
    }
  });
}

test('manual fetch preserves partial source results but exits nonzero', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'calguard-cli-fetch-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--loader', './tests/cli-loader.mjs', 'dist/cli/index.js', 'fetch'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, CALGUARD_TEST_DIR: dir, CALGUARD_TEST_SCENARIO: 'partial-mail' },
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'indexed'), 'utf8').trim()), ['partial']);
  assert.match(result.stderr, /已保留 1 条部分结果/); assert.match(result.stderr, /执行失败/);
  assert.deepEqual(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n'), ['mail']);
});

test('one-shot partial collection continues the existing delivery policy while reporting failure', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'calguard-cli-partial-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--loader', './tests/cli-loader.mjs', 'dist/cli/index.js', 'start', '--once'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, CALGUARD_TEST_DIR: dir, CALGUARD_TEST_SCENARIO: 'partial-mail',
      CALGUARD_TEST_EVENT_START: new Date(Date.now() + 30 * 60000).toISOString() },
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, '.calguard', 'state.json'), 'utf8')).length, 2);
  assert.match(result.stderr, /已保留 1 条部分结果/); assert.match(result.stderr, /执行失败/);
});
