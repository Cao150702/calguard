import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { MacMailSource } from '../dist/sources/messages/mac_mail.js';
import { PartialFetchError } from '../dist/sources/errors.js';

const since = new Date('2026-11-05T09:00:00Z');
const dbPath = '/synthetic-only/MailData/Envelope Index';
const row = (changes = {}) => ({ ROWID: 42, msg_id: 'synthetic-message', subject: '会议',
  date_received: 815565600, sender_addr: 'fake@example.invalid', summary: '准备会议资料', ...changes });
function fixture(t, output = '[]', { exists = true, path = dbPath } = {}) {
  const commands = [], probes = [];
  const resolvedPath = resolve(path);
  globalThis.__calguardFakeMacMailExists = (pathArg) => {
    assert.equal(pathArg, resolvedPath, 'Unexpected filesystem probe'); probes.push(pathArg);
    if (exists instanceof Error) throw exists;
    return exists;
  };
  globalThis.__calguardFakeMacMailCommand = (command, args, options) => {
    assert.equal(command, 'sqlite3'); assert.equal(args.length, 4);
    assert.deepEqual(args.slice(0, 3), ['-readonly', '-json', resolvedPath]);
    assert.equal(options.shell, undefined); assert.equal(options.encoding, 'utf-8');
    assert.equal(options.timeout, 30000); assert.equal(options.maxBuffer, 50 * 1024 * 1024);
    commands.push({ command, args, options });
    if (output instanceof Error) throw output;
    return output;
  };
  t.after(() => { delete globalThis.__calguardFakeMacMailCommand; delete globalThis.__calguardFakeMacMailExists; });
  return { source: new MacMailSource(path), commands, probes };
}
async function partial(promise, expected = []) {
  let error;
  try { await promise; } catch (err) { error = err; }
  assert.ok(error instanceof PartialFetchError, 'Incomplete reads must not look successful');
  assert.deepEqual(error.partialResults.map(r => r.id), expected);
  assert.ok(error.errors.length > 0);
  return error;
}

test('missing database is a visible failure without invoking SQLite', async (t) => {
  const f = fixture(t, '[]', { exists: false }); await partial(f.source.fetchMessages(since));
  assert.equal(f.probes.length, 1); assert.equal(f.commands.length, 0);
});

test('filesystem probe failure remains visible without invoking SQLite', async (t) => {
  const failure = new Error('synthetic access failure'); const f = fixture(t, '[]', { exists: failure });
  const error = await partial(f.source.fetchMessages(since));
  assert.equal(error.errors[0], failure); assert.equal(f.commands.length, 0);
});

for (const output of ['', ' \n\t', '[]']) test(`true empty success ${JSON.stringify(output)}`, async (t) => {
  const f = fixture(t, output); assert.deepEqual(await f.source.fetchMessages(since), []);
  assert.equal(f.commands.length, 1);
});

for (const [label, output] of [
  ['command error', new Error('synthetic missing executable / permission / timeout')],
  ['malformed JSON', '[{'], ['null top level', 'null'], ['object top level', '{}'],
  ['string top level', '"[]"'], ['number top level', '3'], ['boolean top level', 'false'],
]) test(`${label} is a visible failure even without valid rows`, async (t) => {
  const f = fixture(t, output); await partial(f.source.fetchMessages(since)); assert.equal(f.commands.length, 1);
});

for (const [label, bad] of [
  ['null row', null], ['array row', []], ['primitive row', 'bad'], ['empty row', {}],
  ['missing ROWID', row({ ROWID: undefined })], ['string ROWID', row({ ROWID: '42' })],
  ['fractional ROWID', row({ ROWID: 4.2 })], ['unsafe ROWID', row({ ROWID: 9007199254740992 })],
  ['missing date', row({ date_received: undefined })], ['null date', row({ date_received: null })],
  ['string date', row({ date_received: '815565600' })], ['out of range date', row({ date_received: 1e20 })],
  ['boolean date', row({ date_received: false })],
  ['missing sender', row({ sender_addr: undefined })], ['null sender', row({ sender_addr: null })],
  ['object sender', row({ sender_addr: {} })], ['numeric subject', row({ subject: 1 })],
  ['missing subject', row({ subject: undefined })], ['null summary', row({ summary: null })],
  ['missing summary', row({ summary: undefined })], ['array summary', row({ summary: [] })],
]) test(`rejects ${label}, retaining valid preceding and subsequent rows`, async (t) => {
  const f = fixture(t, JSON.stringify([row(), bad, row({ ROWID: 43 })]));
  const error = await partial(f.source.fetchMessages(since), ['macmail-42', 'macmail-43']);
  assert.equal(error.errors.length, 1); assert.equal(error.partialResults[1].body, '准备会议资料');
});

test('nonfinite JSON numeric values and wholly malformed rows cannot pollute index', async (t) => {
  const numericOverflow = JSON.stringify(row()).replace('815565600', '1e400');
  const f = fixture(t, `[null,{},${numericOverflow}]`);
  const error = await partial(f.source.fetchMessages(since)); assert.equal(error.errors.length, 3);
});

test('Unicode and quoting survive while database path remains a single shell-free argument', async (t) => {
  const path = '/synthetic/单引号\' 双引号"; $(touch DO_NOT_RUN) `never`\\\nEnvelope Index';
  const r = row({ subject: '评审\t会议|讨论\n"引号"', summary: '中文说明\n\t含|分隔符和\\路径', sender_addr: '"中文名字" <fake@example.invalid>' });
  const f = fixture(t, JSON.stringify([r]), { path }); const [message] = await f.source.fetchMessages(since);
  assert.equal(message.subject, r.subject); assert.equal(message.body, r.summary); assert.equal(message.from, r.sender_addr);
  assert.deepEqual(message.to, []); assert.equal(message.source, 'mac_mail'); assert.equal(message.id, 'macmail-42');
  const sql = f.commands[0].args[3];
  assert.ok(!sql.includes(path)); assert.match(sql, /WHERE m.date_received >= 815562000\s+ORDER BY m.date_received DESC\s+LIMIT 500/);
});

test('preserves existing Core Data conversion and stable ROWID IDs, not message_id', async (t) => {
  const f = fixture(t, JSON.stringify([row(), row({ ROWID: 43, date_received: 0, msg_id: 'different' }),
    row({ ROWID: 44, date_received: -1 }), row({ ROWID: 45, date_received: 0.125 })]));
  const messages = await f.source.fetchMessages(since);
  assert.deepEqual(messages.map(m => m.timestamp.toISOString()), [
    '2026-11-05T10:00:00.000Z', '2001-01-01T00:00:00.000Z', '2000-12-31T23:59:59.000Z', '2001-01-01T00:00:00.125Z',
  ]);
  assert.deepEqual(messages.map(m => m.id), ['macmail-42', 'macmail-43', 'macmail-44', 'macmail-45']);
});

test('empty optional text remains valid', async (t) => {
  const f = fixture(t, JSON.stringify([row({ subject: '', sender_addr: '', summary: '' })]));
  const [message] = await f.source.fetchMessages(since); assert.equal(message.body, ''); assert.equal(message.subject, '');
});

test('invalid query date fails before any filesystem probe or command', async (t) => {
  const f = fixture(t); await partial(f.source.fetchMessages(new Date(NaN)));
  assert.equal(f.probes.length, 0); assert.equal(f.commands.length, 0);
});

test('test loader fails closed when filesystem fake is absent', async () => {
  const error = await partial(new MacMailSource(dbPath).fetchMessages(since));
  assert.match(error.errors[0].message, /filesystem fake not installed/);
});

test('test loader fails closed when command fake is absent', async (t) => {
  const f = fixture(t); delete globalThis.__calguardFakeMacMailCommand;
  const error = await partial(f.source.fetchMessages(since)); assert.match(error.errors[0].message, /command fake not installed/);
});

for (const path of ['-cmd', '-init malicious.sql', 'relative/Envelope Index']) test(`database path ${JSON.stringify(path)} cannot become a SQLite option`, async (t) => {
  const f = fixture(t, '[]', { path }); assert.deepEqual(await f.source.fetchMessages(since), []);
  assert.equal(f.commands[0].args[2], resolve(path)); assert.ok(f.commands[0].args[2].startsWith('/'));
});
