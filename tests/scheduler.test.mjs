import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PartialFetchError } from '../dist/sources/errors.js';
import { MacMailSource } from '../dist/sources/messages/mac_mail.js';
import { CalGuardScheduler } from '../dist/scheduler/cron.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'calguard-scheduler-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = new Date('2026-11-05T09:00:00Z');
  const sent = [];
  const config = {
    sources: { calendars: [], messages: [] },
    engine: { fetch_interval_minutes: 30, lookback_days: 3, summary_mode: 'standard', skip_summary_if_no_match: false, correlation_threshold: 0.3 },
    notifications: { remind_at: ['1h'], channels: [] },
    llm: { provider: 'none', api_key: '', model: '', max_tokens: 1000 },
  };
  const event = { id: 'meeting', title: 'Synthetic meeting', start: new Date('2026-11-05T10:30:00Z'),
    end: new Date('2026-11-05T11:30:00Z'), attendees: [], source: 'fake' };
  const calendars = [{ name: 'fake', async fetchEvents() { return [event]; } }];
  const messages = [];
  const notifiers = [{ name: 'fake', async send(params) { sent.push(params); } }];
  globalThis.__calguardSchedules = [];
  globalThis.__calguardIndexedMessages = [];
  globalThis.__calguardIndexFailure = false;
  return { sent, config, notifiers, calendars, messages, setTime: (time) => { now = new Date(`2026-11-05T${time}Z`); },
    scheduler: () => new CalGuardScheduler(config, calendars, messages, notifiers, { now: () => now, statePath: join(dir, 'state.json') }) };
}

test('daemon registers minute reminder checks rather than hourly checks, with no real timers', async (t) => {
  const f = fixture(t); const scheduler = f.scheduler(); scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(globalThis.__calguardSchedules.map((x) => x.expression), ['*/30 * * * *', '* * * * *']);
  assert.equal(f.sent.length, 0);
  f.setTime('09:30:00'); globalThis.__calguardSchedules[1].callback();
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(f.sent.length, 1);
});

test('one-shot execution uses the same due-only boundary and restart deduplication', async (t) => {
  const f = fixture(t); f.setTime('09:29:59.999'); await f.scheduler().runOnce(); assert.equal(f.sent.length, 0);
  f.setTime('09:30:00'); await f.scheduler().runOnce(); assert.equal(f.sent.length, 1);
  f.setTime('09:31:00'); await f.scheduler().runOnce(); assert.equal(f.sent.length, 1);
});

test('one-shot mode catches up late and does not claim the event is still one hour away', async (t) => {
  const f = fixture(t); f.setTime('10:15:00'); await f.scheduler().runOnce();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].title, '日程提醒 (1h): Synthetic meeting');
});

test('skip_summary_if_no_match remains respected', async (t) => {
  const f = fixture(t); f.config.engine.skip_summary_if_no_match = true;
  f.setTime('09:30:00'); const scheduler = f.scheduler(); await scheduler.runOnce();
  assert.equal(f.sent.length, 0); assert.equal(scheduler.getStatus().sentCount, 0);
});


test('graceful stop waits for active delivery and removes its lock before exit', async (t) => {
  const f = fixture(t); let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  f.notifiers[0].send = async (params) => { f.sent.push(params); await blocked; };
  f.setTime('09:30:00'); const scheduler = f.scheduler(); scheduler.start();
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(f.sent.length, 1);
  let stopped = false; const stopping = scheduler.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(stopped, false);
  release(); await stopping; assert.equal(stopped, true);
  await f.scheduler().runOnce(); assert.equal(f.sent.length, 1);
});

test('one-shot aggregates failures across stages and continues independent work', async (t) => {
  const f = fixture(t); const attempted = [];
  f.messages.push(
    { name: 'mail-one', async fetchMessages() { attempted.push('mail-one'); throw new Error('first outage'); } },
    { name: 'mail-two', async fetchMessages() { attempted.push('mail-two'); throw new Error('second outage'); } },
    { name: 'mail-good', async fetchMessages() { attempted.push('mail-good'); return []; } },
  );
  f.calendars.unshift({ name: 'calendar-bad', async fetchEvents() { attempted.push('calendar-bad'); throw new Error('calendar outage'); } });
  f.notifiers.unshift({ name: 'notifier-bad', async send() { attempted.push('notifier-bad'); throw new Error('notification outage'); } });
  f.setTime('09:30:00');
  await assert.rejects(f.scheduler().runOnce(), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 4);
    assert.match(error.message, /4 项失败/); return true;
  });
  assert.deepEqual(attempted, ['mail-one', 'mail-two', 'mail-good', 'calendar-bad', 'notifier-bad']);
  assert.equal(f.sent.length, 1);
  f.messages.length = 0; f.calendars.shift(); f.notifiers.shift();
  await f.scheduler().runOnce(); assert.equal(f.sent.length, 1);
});

test('daemon message cron catches aggregated failures rather than creating an unhandled rejection', async (t) => {
  const f = fixture(t); f.messages.push({ name: 'bad-mail', async fetchMessages() { throw new Error('synthetic'); } });
  const scheduler = f.scheduler(); scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.doesNotReject(globalThis.__calguardSchedules[0].callback());
  await scheduler.stop();
});

test('a null message-source rejection is aggregated without aborting another source or reminder', async (t) => {
  const f = fixture(t); let continued = false;
  f.messages.push({ name: 'bad', async fetchMessages() { throw null; } },
    { name: 'good', async fetchMessages() { continued = true; return []; } });
  f.setTime('09:30:00');
  await assert.rejects(f.scheduler().runOnce(), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 1); return true;
  });
  assert.equal(continued, true); assert.equal(f.sent.length, 1);
});

test('partial source messages are indexed and remain usable without hiding collection failure', async (t) => {
  const f = fixture(t);
  const partial = { id: 'partial-mail', from: 'synthetic', to: [], subject: 'Synthetic', body: 'Synthetic context', timestamp: new Date('2026-11-05T09:00:00Z'), source: 'email' };
  f.messages.push({ name: 'partial', async fetchMessages() { throw new PartialFetchError('partial folder failure', [new Error('synthetic')], [partial]); } });
  f.config.engine.skip_summary_if_no_match = true; f.setTime('09:30:00');
  await assert.rejects(f.scheduler().runOnce(), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 1); return true;
  });
  assert.deepEqual(globalThis.__calguardIndexedMessages, [partial]);
  assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0].messages, [partial]);
  assert.match(f.sent[0].brief, /synthetic: Synthetic/);
});

test('partial indexing errors are reported separately and do not suppress other safe work', async (t) => {
  const f = fixture(t); let nextSource = false;
  globalThis.__calguardIndexFailure = true;
  f.messages.push({ name: 'partial', async fetchMessages() { throw new PartialFetchError('partial', [new Error('fetch')], [{ id: 'synthetic' }]); } },
    { name: 'next', async fetchMessages() { nextSource = true; return []; } });
  f.setTime('09:30:00');
  await assert.rejects(f.scheduler().runOnce(), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.match(error.errors[1].message, /部分结果索引失败/); return true;
  });
  assert.equal(nextSource, true); assert.equal(f.sent.length, 1);
});

function fakeMacMail(t, output, exists = true) {
  globalThis.__calguardFakeMacMailExists = () => exists;
  globalThis.__calguardFakeMacMailCommand = () => output;
  t.after(() => {
    delete globalThis.__calguardFakeMacMailExists;
    delete globalThis.__calguardFakeMacMailCommand;
  });
  return new MacMailSource('/synthetic/mail/Envelope Index');
}

function macMailRow(id, overrides = {}) {
  return { ROWID: id, msg_id: `synthetic-${id}`, subject: 'Synthetic meeting',
    sender_addr: 'synthetic@example.test', summary: `Synthetic context ${id}`,
    date_received: Date.parse('2026-11-05T09:00:00Z') / 1000 - 978307200, ...overrides };
}

test('actual Mac Mail adapter retains valid partial rows for reminders while one-shot still fails', async (t) => {
  const f = fixture(t);
  f.messages.push(fakeMacMail(t, JSON.stringify([macMailRow(1), macMailRow(2, { date_received: 'invalid' }), macMailRow(3)])));
  f.config.engine.skip_summary_if_no_match = true; f.setTime('09:30:00');
  await assert.rejects(f.scheduler().runOnce(), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 1);
    assert.ok(error.errors[0].cause instanceof PartialFetchError); return true;
  });
  assert.deepEqual(globalThis.__calguardIndexedMessages.map((m) => m.id), ['macmail-1', 'macmail-3']);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].messages.map((m) => m.id), ['macmail-1', 'macmail-3']);
});

test('all invalid Mac Mail rows never enter the index and do not change existing reminder policy', async (t) => {
  const f = fixture(t);
  f.messages.push(fakeMacMail(t, JSON.stringify([null, macMailRow(1, { summary: {} })])));
  f.setTime('09:30:00');
  await assert.rejects(f.scheduler().runOnce(), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 1);
    assert.deepEqual(error.errors[0].cause.partialResults, []); return true;
  });
  assert.deepEqual(globalThis.__calguardIndexedMessages, []);
  assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0].messages, []);
});

test('missing Mac Mail database is a visible failure without blocking independent message sources', async (t) => {
  const f = fixture(t); let continued = false;
  f.messages.push(fakeMacMail(t, '[]', false),
    { name: 'other-mail', async fetchMessages() { continued = true; return []; } });
  f.setTime('09:30:00');
  await assert.rejects(f.scheduler().runOnce(), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 1); return true;
  });
  assert.equal(continued, true); assert.deepEqual(globalThis.__calguardIndexedMessages, []);
  assert.equal(f.sent.length, 1);
});
