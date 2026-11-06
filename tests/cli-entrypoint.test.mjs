import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = join(root, 'dist/cli/index.js');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);
const scripts = {
  start: ['start'], fetch: ['fetch'], events: ['events'], preview: ['preview'],
  status: ['status'], 'config:validate': ['config', 'validate'],
};
let commander;
let missingCommander;
try {
  // Do not silently substitute an unrelated global installation. An explicit
  // override may point to an already installed package directory or entry file.
  commander = require.resolve(process.env.CALGUARD_TEST_COMMANDER_PATH
    ? resolve(process.env.CALGUARD_TEST_COMMANDER_PATH)
    : join(root, 'node_modules/commander'));
} catch (error) {
  if (process.env.CALGUARD_TEST_COMMANDER_PATH) throw error;
  missingCommander = 'Real repository Commander is not installed; set CALGUARD_TEST_COMMANDER_PATH to an existing package for explicit compatibility testing';
}

function run(command, args, env, cwd) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', timeout: 15000, shell: false,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Unexpected signal: ${result.stderr}`);
  return result;
}
function assertHelp(result, command = '') {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`Usage: calguard${command ? ` ${command}` : ''} `));
  assert.match(result.stdout, /--help/);
}

test('package CLI scripts target emitted JavaScript and only supported commands', () => {
  assert.equal(manifest.bin.calguard, './dist/cli/index.js');
  assert.equal(manifest.scripts.setup, undefined, 'There is no implemented setup command');
  for (const [name, args] of Object.entries(scripts)) {
    assert.equal(manifest.scripts[name], `node dist/cli/index.js ${args.join(' ')}`);
  }
});

test('emitted CLI retains the executable Node shebang', () => {
  assert.equal(readFileSync(entry, 'utf8').split('\n')[0], '#!/usr/bin/env node');
});

test('real Commander parses offline CLI help and rejects unsupported setup', { skip: missingCommander }, async (t) => {
  t.diagnostic(`Real Commander entry: ${commander}${process.env.CALGUARD_TEST_COMMANDER_PATH ? ' (explicit compatibility override; may differ from declared dependency)' : ''}`);
  const temp = mkdtempSync(join(tmpdir(), 'calguard-cli-entry-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const calls = join(temp, 'forbidden-calls');
  const env = {
    ...process.env,
    // Do not inherit the parent test runner's synthetic Commander or loaders.
    NODE_OPTIONS: `--loader ${new URL('./cli-entrypoint-loader.mjs', import.meta.url).href}`,
    NODE_NO_WARNINGS: '1',
    CALGUARD_TEST_COMMANDER_ENTRY: commander,
    CALGUARD_TEST_ENTRY_URL: pathToFileURL(entry).href,
    CALGUARD_TEST_CALLS: calls,
  };
  for (const args of [[], ['start'], ['fetch'], ['events'], ['preview'], ['status'], ['config'], ['config', 'validate']]) {
    await t.test(`${args.join(' ') || 'top-level'} --help has no application initialization`, () => {
      assertHelp(run(process.execPath, [entry, ...args, '--help'], env, temp), args.join(' '));
      assert.equal(existsSync(calls), false, 'Help initialized application dependencies');
    });
  }
  await t.test('setup is rejected rather than pretending a wizard exists', () => {
    const result = run(process.execPath, [entry, 'setup'], env, temp);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown command ['"]setup['"]/);
    assert.equal(existsSync(calls), false);
  });
  await t.test('npm scripts forward help to each supported command without executing it', () => {
    for (const [name, args] of Object.entries(scripts)) {
      const npm = process.env.npm_execpath;
      const result = npm
        ? run(process.execPath, [npm, 'run', name, '--', '--help'], env, root)
        : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', name, '--', '--help'], env, root);
      assertHelp(result, args.join(' '));
      assert.equal(existsSync(calls), false);
    }
  });
  await t.test('installed-bin style symlink directly executes emitted JS without a shell', { skip: process.platform === 'win32' ? 'POSIX executable/shebang regression' : false }, () => {
    const packageDir = join(temp, 'package');
    const emitted = join(packageDir, 'dist/cli/index.js');
    mkdirSync(dirname(emitted), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ type: 'module' }));
    copyFileSync(entry, emitted);
    chmodSync(emitted, 0o755);
    const bin = join(temp, 'calguard');
    symlinkSync(emitted, bin);
    assertHelp(run(bin, ['--help'], { ...env, CALGUARD_TEST_ENTRY_URL: pathToFileURL(emitted).href }, temp));
    assert.equal(existsSync(calls), false);
  });
});
