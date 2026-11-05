import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EmailSource } from '../dist/sources/messages/email.js';
import { PartialFetchError } from '../dist/sources/errors.js';

const mail = (id) => ({ messageId: id, from: { text: 'fake' }, to: { value: [] }, text: `body-${id}`, date: new Date('2026-11-05T08:00:00Z'), attachments: [] });
function fixture(t, plans = [{}]) {
  const clients = [], parsers = [], timers = new Map();
  let timerId = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => { assert.equal(ms, 60000); const id = ++timerId; timers.set(id, callback); return id; });
  t.mock.method(globalThis, 'clearTimeout', (id) => timers.delete(id));
  globalThis.__calguardFakeParser = (stream, callback) => { parsers.push({ stream, callback }); };
  globalThis.__calguardFakeImap = () => {
    const plan = plans[clients.length] || {};
    const imap = new EventEmitter();
    Object.assign(imap, {
      batches: [], closed: 0,
      connect() { if (plan.connectThrow) throw new Error('connect'); queueMicrotask(() => imap.emit('ready')); },
      end() { imap.closed++; imap.emit('end'); imap.emit('close'); },
      destroy() { imap.destroyed = true; imap.closed++; imap.emit('close'); },
      openBox(folder, readOnly, callback) { imap.folder = folder; assert.equal(readOnly, true); if (plan.openStall) return; callback(plan.openError ? new Error('open') : null); },
      search(criteria, callback) { if (plan.searchThrow) throw new Error('search'); callback(plan.searchError ? new Error('search') : null, plan.uids ?? [1]); },
      fetch(uids, options) { assert.equal(options.markSeen, false); if (plan.fetchThrow) throw new Error('fetch'); const fetch = new EventEmitter(); imap.batches.push({ uids, fetch }); return fetch; },
    });
    clients.push(imap);
    return imap;
  };
  t.after(() => { delete globalThis.__calguardFakeImap; delete globalThis.__calguardFakeParser; });
  const source = new EmailSource({ host: 'offline.invalid', user: 'fake', password: 'fake', folders: plans.map((_, i) => `folder-${i}`) });
  const start = () => {
    const promise = source.fetchMessages(new Date('2026-11-01T00:00:00Z'));
    // Attach a rejection handler immediately while events are driven manually.
    const outcome = promise.then((value) => ({ value }), (error) => ({ error }));
    return { promise, outcome };
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const message = (fetch, id = 'fake') => { const msg = new EventEmitter(); fetch.emit('message', msg); msg.emit('body', { id }); msg.emit('end'); return msg; };
  return { clients, parsers, timers, start, tick, message };
}

test('IMAP waits for asynchronous parsing after fetch end', async (t) => {
  const f = fixture(t); const run = f.start(); let done = false; run.outcome.then(() => { done = true; }); await f.tick();
  const fetch = f.clients[0].batches[0].fetch; f.message(fetch); fetch.emit('end'); await f.tick();
  assert.equal(done, false); f.parsers[0].callback(null, mail('a'));
  assert.deepEqual((await run.outcome).value.map(m => m.id), ['a']); assert.equal(f.timers.size, 0); assert.equal(f.clients[0].closed, 1);
});

test('IMAP waits for parsers before advancing a 51-message result to next batch', async (t) => {
  const f = fixture(t, [{ uids: Array.from({ length: 51 }, (_, i) => i + 1) }]); const run = f.start(); await f.tick();
  const first = f.clients[0].batches[0]; assert.equal(first.uids.length, 50);
  for (let i = 0; i < 50; i++) f.message(first.fetch, i);
  first.fetch.emit('end'); assert.equal(f.clients[0].batches.length, 1);
  for (let i = 0; i < 50; i++) f.parsers[i].callback(null, mail(`${i}`));
  assert.equal(f.clients[0].batches.length, 2); const second = f.clients[0].batches[1]; assert.deepEqual(second.uids, [51]);
  f.message(second.fetch); second.fetch.emit('end'); f.parsers[50].callback(null, mail('50'));
  assert.equal((await run.outcome).value.length, 51); assert.equal(f.timers.size, 0);
});

for (const withEnd of [false, true]) test(`IMAP fetch error retains completed and pending successful parses (end=${withEnd})`, async (t) => {
  const f = fixture(t); const run = f.start(); await f.tick(); const fetch = f.clients[0].batches[0].fetch;
  f.message(fetch); f.parsers[0].callback(null, mail('a')); f.message(fetch);
  fetch.emit('error', new Error('fetch failed')); if (withEnd) fetch.emit('end');
  f.parsers[1].callback(null, mail('b')); const { error } = await run.outcome;
  assert.ok(error instanceof PartialFetchError); assert.deepEqual(error.partialResults.map(m => m.id), ['a', 'b']); assert.equal(f.timers.size, 0);
});

for (const kind of ['error', 'missing', 'invalid-date', 'throw']) test(`IMAP parse ${kind} rejects with successful partial messages`, async (t) => {
  const f = fixture(t); const run = f.start(); await f.tick(); const fetch = f.clients[0].batches[0].fetch;
  f.message(fetch); f.parsers[0].callback(null, mail('good'));
  if (kind === 'throw') globalThis.__calguardFakeParser = () => { throw new Error('parser threw'); };
  f.message(fetch);
  if (kind === 'error') f.parsers[1].callback(new Error('parse failed'));
  if (kind === 'missing') f.parsers[1].callback(null, undefined);
  if (kind === 'invalid-date') f.parsers[1].callback(null, { ...mail('bad'), date: new Date(NaN) });
  fetch.emit('end'); const { error } = await run.outcome;
  assert.ok(error instanceof PartialFetchError); assert.deepEqual(error.partialResults.map(m => m.id), ['good']); assert.equal(f.timers.size, 0);
});

for (const event of ['end', 'close', 'error']) test(`IMAP premature ${event} rejects and ignores late events/parser callbacks`, async (t) => {
  const f = fixture(t); const run = f.start(); await f.tick(); const imap = f.clients[0], fetch = imap.batches[0].fetch;
  f.message(fetch); f.parsers[0].callback(null, mail('good')); f.message(fetch);
  imap.emit(event, new Error('transport')); const { error } = await run.outcome;
  assert.ok(error instanceof PartialFetchError); assert.deepEqual(error.partialResults.map(m => m.id), ['good']);
  f.parsers[1].callback(null, mail('late')); fetch.emit('end'); fetch.emit('error', new Error('late')); imap.emit('error', new Error('late'));
  assert.deepEqual(error.partialResults.map(m => m.id), ['good']); assert.equal(imap.batches.length, 1); assert.equal(f.timers.size, 0);
});

test('IMAP folder deadline rejects, cleans up, and still attempts next folder', async (t) => {
  const f = fixture(t, [{ openStall: true }, { uids: [] }]); const run = f.start(); await f.tick();
  [...f.timers.values()][0](); const { error } = await run.outcome;
  assert.ok(error instanceof PartialFetchError); assert.equal(f.clients.length, 2); assert.equal(f.timers.size, 0); assert.equal(f.clients[0].closed, 1); assert.equal(f.clients[0].destroyed, true);
});

test('IMAP aggregates failed folders and preserves successes before and after failure', async (t) => {
  const f = fixture(t, [{}, { openError: true }, {}]); const run = f.start(); await f.tick();
  const first = f.clients[0].batches[0].fetch; f.message(first); f.parsers[0].callback(null, mail('first')); first.emit('end');
  await f.tick(); const third = f.clients[2].batches[0].fetch; f.message(third); f.parsers[1].callback(null, mail('third')); third.emit('end');
  const { error } = await run.outcome; assert.ok(error instanceof PartialFetchError); assert.equal(error.errors.length, 1);
  assert.deepEqual(error.partialResults.map(m => m.id), ['first', 'third']); assert.equal(f.timers.size, 0);
});

for (const plan of [{ connectThrow: true }, { searchThrow: true }, { searchError: true }, { fetchThrow: true }]) test(`IMAP handles synchronous or callback failure ${Object.keys(plan)[0]}`, async (t) => {
  const f = fixture(t, [plan]); const { error } = await f.start().outcome;
  assert.ok(error instanceof PartialFetchError); assert.equal(f.timers.size, 0); assert.equal(f.clients[0].closed, 1);
});

test('IMAP empty results complete successfully and clear deadline', async (t) => {
  const f = fixture(t, [{ uids: [] }]); assert.deepEqual((await f.start().outcome).value, []); assert.equal(f.timers.size, 0);
});

test('IMAP missing body is a reported failure, not an empty success', async (t) => {
  const f = fixture(t); const run = f.start(); await f.tick(); const fetch = f.clients[0].batches[0].fetch;
  const msg = new EventEmitter(); fetch.emit('message', msg); msg.emit('end'); fetch.emit('end');
  const { error } = await run.outcome; assert.ok(error instanceof PartialFetchError); assert.equal(error.partialResults.length, 0); assert.equal(f.timers.size, 0);
});

test('IMAP parser stall expires with successful partial messages and cannot mutate the result later', async (t) => {
  const f = fixture(t); const run = f.start(); await f.tick(); const fetch = f.clients[0].batches[0].fetch;
  f.message(fetch); f.parsers[0].callback(null, mail('good')); f.message(fetch); fetch.emit('end');
  [...f.timers.values()][0](); const { error } = await run.outcome;
  assert.ok(error instanceof PartialFetchError); assert.deepEqual(error.partialResults.map(m => m.id), ['good']);
  f.parsers[1].callback(null, mail('late')); assert.deepEqual(error.partialResults.map(m => m.id), ['good']);
  assert.equal(f.clients[0].destroyed, true); assert.equal(f.timers.size, 0);
});

test('IMAP ignores duplicate parser callbacks and does not advance batches twice', async (t) => {
  const f = fixture(t); const run = f.start(); await f.tick(); const fetch = f.clients[0].batches[0].fetch;
  f.message(fetch); f.parsers[0].callback(null, mail('good')); f.parsers[0].callback(null, mail('duplicate')); fetch.emit('end');
  assert.deepEqual((await run.outcome).value.map(m => m.id), ['good']); assert.equal(f.clients[0].closed, 1);
});

for (const finish of ['body', 'missing-body']) test(`IMAP waits for a known message after fetch end (${finish})`, async (t) => {
  const f = fixture(t); const run = f.start(); let done = false; run.outcome.then(() => { done = true; }); await f.tick();
  const fetch = f.clients[0].batches[0].fetch; const msg = new EventEmitter();
  fetch.emit('message', msg); fetch.emit('end'); await f.tick(); assert.equal(done, false);
  if (finish === 'body') {
    msg.emit('body', { id: 'late-body' }); msg.emit('body', { id: 'duplicate-body' }); msg.emit('end'); msg.emit('end');
    assert.equal(f.parsers.length, 1); await f.tick(); assert.equal(done, false);
    f.parsers[0].callback(null, mail('good'));
    assert.deepEqual((await run.outcome).value.map(m => m.id), ['good']);
  } else {
    msg.emit('end'); msg.emit('end'); msg.emit('body', { id: 'too-late' });
    const { error } = await run.outcome; assert.ok(error instanceof PartialFetchError); assert.equal(error.errors.length, 1); assert.equal(f.parsers.length, 0);
  }
  assert.equal(f.timers.size, 0); assert.equal(f.clients[0].closed, 1);
});
