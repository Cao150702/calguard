import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PartialFetchError } from '../dist/sources/errors.js';
import { ReminderRunner, parseReminderOffset } from '../dist/scheduler/reminders.js';

const MINUTE = 60_000;
const at = (time) => new Date(`2026-11-05T${time}Z`);
function event(start = at('10:30:00'), extra = {}) {
  return { id: 'meeting', title: 'Synthetic meeting', start, end: new Date(start.getTime() + 3600000),
    attendees: [], source: 'fake', calendar: 'test', ...extra };
}
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'calguard-reminders-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let time = at('09:00:00');
  let events = [event()];
  const sent = [], queries = [];
  const statePath = join(dir, 'state.json');
  const source = { name: 'fake', async fetchEvents(from, to) {
    queries.push({ from, to });
    return events.filter((e) => e.end >= from && e.start < to);
  } };
  const config = {
    calendarSources: [source], notifiers: [{ name: 'fake', async send(params) { sent.push(params); } }],
    remindAt: ['1h'], statePath, now: () => new Date(time),
    prepareNotification: async (e, remindAt) => ({ title: e.title, event: e, remindAt, messages: [], brief: 'Synthetic' }),
    ...options,
  };
  return { dir, config, source, sent, queries, statePath,
    setTime: (value) => { time = typeof value === 'string' ? at(value) : value; },
    setEvents: (value) => { events = value; },
    runner: () => new ReminderRunner(config),
    records: () => JSON.parse(readFileSync(statePath, 'utf8')),
  };
}

for (const [label, minutes] of [['24h', 1440], ['12h', 720], ['2h', 120], ['1h', 60], ['30m', 30], ['15m', 15], ['48h', 2880], ['8760h', 525600]]) {
  test(`offset ${label} is interpreted exactly`, () => assert.equal(parseReminderOffset(label), minutes * MINUTE));
  test(`reminder fires at the exact ${label} boundary, not 1ms before`, async (t) => {
    const f = fixture(t, { remindAt: [label] });
    f.setEvents([event(new Date(at('09:30:00').getTime() + minutes * MINUTE))]);
    const runner = f.runner();
    f.setTime('09:29:59.999'); await runner.check(); assert.equal(f.sent.length, 0);
    f.setTime('09:30:00'); await runner.check(); assert.equal(f.sent.length, 1);
    await runner.check(); assert.equal(f.sent.length, 1);
  });
}
for (const label of ['', '0h', '-1h', '1.5h', '1d', ' 1h', '1h ', '01h', '5x', 'Infinityh', '999999999999999999h', '8761h']) {
  test(`invalid offset ${JSON.stringify(label)} is rejected`, (t) => {
    assert.equal(parseReminderOffset(label), undefined);
    const f = fixture(t, { remindAt: [label] });
    assert.throws(() => f.runner(), /无效提醒时间/);
  });
}

test('10:30 meeting is delivered at 09:30, with no repeat on later ticks', async (t) => {
  const f = fixture(t); const runner = f.runner();
  await runner.check(); assert.equal(f.sent.length, 0);
  f.setTime('09:30:00'); await runner.check();
  f.setTime('10:00:00'); await runner.check();
  assert.equal(f.sent.length, 1);
  assert.equal(f.records()[0].sentAt, at('09:30:00').toISOString());
});

test('delayed checks catch up beyond both old tolerance windows', async (t) => {
  const f = fixture(t); const runner = f.runner();
  await runner.check(); f.setTime('10:15:00'); await runner.check();
  assert.equal(f.sent.length, 1);
});

test('cold start sends overdue configured offsets, but never before they are due', async (t) => {
  const f = fixture(t, { remindAt: ['24h', '1h', '30m'] });
  f.setTime('09:45:00'); await f.runner().check();
  assert.deepEqual(f.sent.map((x) => x.remindAt), ['24h', '1h']);
});

for (const time of ['10:30:00', '10:30:00.001', '11:00:00']) {
  test(`reminders expire at meeting start (${time})`, async (t) => {
    const f = fixture(t); f.setTime(time); await f.runner().check(); assert.equal(f.sent.length, 0);
  });
}

test('restart retains successful delivery and catches an unsent reminder', async (t) => {
  const f = fixture(t); f.setTime('09:31:00'); await f.runner().check();
  f.setTime('09:45:00'); await f.runner().check(); assert.equal(f.sent.length, 1);
  f.setEvents([event(), event(at('10:40:00'), { id: 'another' })]);
  await f.runner().check(); assert.equal(f.sent.length, 2);
});

test('one occurrence returned twice and equivalent offsets are deduplicated', async (t) => {
  const f = fixture(t, { remindAt: ['1h', '1h', '60m'] });
  f.setEvents([event(), event()]); f.setTime('09:30:00'); await f.runner().check();
  assert.equal(f.sent.length, 1);
});

test('recurrence and rescheduling use start time as part of identity', async (t) => {
  const f = fixture(t); f.setTime('09:30:00'); await f.runner().check();
  f.setEvents([event(at('11:00:00'))]); f.setTime('10:00:00'); await f.runner().check();
  const tomorrow = new Date('2026-11-06T10:30:00Z');
  f.setEvents([event(tomorrow)]); f.setTime(new Date('2026-11-06T09:30:00Z')); await f.runner().check();
  assert.equal(f.sent.length, 3);
});

test('same event IDs in different sources or calendars are independent', async (t) => {
  const f = fixture(t); f.setTime('09:30:00');
  f.setEvents([event(), event(at('10:30:00'), { calendar: 'other' })]);
  f.config.calendarSources.push({ name: 'other-source', async fetchEvents() { return [event()]; } });
  await f.runner().check(); assert.equal(f.sent.length, 3);
});

test('partial delivery persists each success and retries only failed channels after restart', async (t) => {
  const f = fixture(t); const calls = []; let fail = true;
  f.config.notifiers = [
    { name: 'a', async send() { calls.push('a'); } },
    { name: 'b', async send() { calls.push('b'); if (fail) throw new Error('synthetic outage'); } },
  ];
  f.setTime('09:30:00'); await assert.rejects(f.runner().check(), AggregateError);
  assert.equal(f.records().length, 1);
  fail = false; await f.runner().check(); await f.runner().check();
  assert.deepEqual(calls, ['a', 'b', 'b']);
  assert.equal(f.records().length, 2);
});

test('two channels of the same type are each tracked', async (t) => {
  const f = fixture(t); const calls = [];
  f.config.notifiers = [0, 1].map((index) => ({ name: 'same', async send() { calls.push(index); } }));
  f.setTime('09:30:00'); await f.runner().check(); await f.runner().check();
  assert.deepEqual(calls, [0, 1]);
});

test('all failed channels remain retryable', async (t) => {
  const f = fixture(t); let attempts = 0;
  f.config.notifiers = [{ name: 'bad', async send() { attempts++; throw new Error('synthetic outage'); } }];
  f.setTime('09:30:00'); const runner = f.runner(); await assert.rejects(runner.check(), AggregateError); await assert.rejects(runner.check(), AggregateError);
  assert.equal(attempts, 2); assert.equal(runner.sentCount, 0);
});

test('overlapping checks share one in-flight delivery', async (t) => {
  const f = fixture(t); let release; let calls = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  f.config.notifiers = [{ name: 'slow', async send() { calls++; await blocked; } }];
  f.setTime('09:30:00'); const runner = f.runner();
  const first = runner.check(); const second = runner.check(); assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls, 1);
  release(); await Promise.all([first, second]); await runner.check(); assert.equal(calls, 1);
});

test('a failing calendar does not block other sources and is retried', async (t) => {
  const f = fixture(t); let failed = true;
  f.config.calendarSources.unshift({ name: 'flaky', async fetchEvents() {
    if (failed) throw new Error('synthetic outage'); return [event()];
  } });
  f.setTime('09:30:00'); const runner = f.runner(); await assert.rejects(runner.check(), AggregateError); assert.equal(f.sent.length, 1);
  failed = false; await runner.check(); assert.equal(f.sent.length, 2);
});

test('brief errors do not block another event and remain retryable', async (t) => {
  const f = fixture(t); const prepare = f.config.prepareNotification; let failed = true;
  f.setEvents([event(), event(at('10:30:00'), { id: 'next' })]);
  f.config.prepareNotification = async (e, label) => {
    if (e.id === 'meeting' && failed) throw new Error('synthetic brief failure'); return prepare(e, label);
  };
  f.setTime('09:30:00'); const runner = f.runner(); await assert.rejects(runner.check(), AggregateError); assert.equal(f.sent.length, 1);
  failed = false; await runner.check(); assert.equal(f.sent.length, 2);
});

test('skipped summaries are not falsely recorded as successful', async (t) => {
  const f = fixture(t); const prepare = f.config.prepareNotification; let matched = false;
  f.config.prepareNotification = async (...args) => matched ? prepare(...args) : undefined;
  f.setTime('09:30:00'); const runner = f.runner(); await runner.check(); assert.equal(runner.sentCount, 0);
  matched = true; await runner.check(); assert.equal(f.sent.length, 1);
});

test('calendar query covers offsets greater than the old 25-hour horizon', async (t) => {
  const f = fixture(t, { remindAt: ['48h'] }); const start = new Date('2026-11-07T09:30:00Z');
  f.setEvents([event(start)]); f.setTime('09:30:00'); await f.runner().check();
  assert.ok(f.queries[0].to > start); assert.equal(f.sent.length, 1);
});

test('state remains effective for offsets beyond seven days', async (t) => {
  const f = fixture(t, { remindAt: ['240h'] }); const start = new Date('2026-11-15T09:30:00Z');
  f.setEvents([event(start)]); f.setTime('09:30:00'); await f.runner().check();
  f.setTime(new Date('2026-11-13T09:30:00Z')); await f.runner().check(); assert.equal(f.sent.length, 1);
});

test('legacy records suppress their old occurrence without suppressing tomorrow', async (t) => {
  const f = fixture(t); writeFileSync(f.statePath, JSON.stringify([{ eventId: 'meeting', remindAt: '1h', sentAt: at('09:30:00').toISOString() }]));
  f.setTime('09:31:00'); await f.runner().check(); assert.equal(f.sent.length, 0);
  f.setEvents([event(new Date('2026-11-06T10:30:00Z'))]); f.setTime(new Date('2026-11-06T09:30:00Z'));
  await f.runner().check(); assert.equal(f.sent.length, 1);
});

test('a calendar read delay crossing the trigger is handled in the same check', async (t) => {
  const f = fixture(t); f.setTime('09:29:30');
  f.source.fetchEvents = async () => { f.setTime('09:30:15'); return [event()]; };
  await f.runner().check(); assert.equal(f.sent.length, 1);
});

test('slow preparation does not deliver after a meeting starts', async (t) => {
  const f = fixture(t); const prepare = f.config.prepareNotification;
  f.config.prepareNotification = async (...args) => { f.setTime('10:30:00'); return prepare(...args); };
  f.setTime('09:30:00'); await f.runner().check(); assert.equal(f.sent.length, 0);
});

test('backwards clock changes do not trigger early sends or resend success', async (t) => {
  const f = fixture(t); const prepare = f.config.prepareNotification; let rewind = true;
  f.config.prepareNotification = async (...args) => { if (rewind) f.setTime('09:29:00'); return prepare(...args); };
  f.setTime('09:30:00'); const runner = f.runner(); await runner.check(); assert.equal(f.sent.length, 0);
  rewind = false; f.setTime('09:30:00'); await runner.check();
  f.setTime('09:00:00'); await runner.check(); f.setTime('09:30:00'); await runner.check();
  assert.equal(f.sent.length, 1);
});

test('invalid event dates are ignored without blocking valid events', async (t) => {
  const f = fixture(t); f.source.fetchEvents = async () => [event(new Date(NaN)), event()];
  f.setTime('09:30:00'); await f.runner().check(); assert.equal(f.sent.length, 1);
});

for (const options of [{ remindAt: [] }, { notifiers: [] }]) {
  test(`disabled reminders do no calendar work: ${JSON.stringify(options)}`, async (t) => {
    const f = fixture(t, options); await f.runner().check(); assert.equal(f.queries.length, 0);
  });
}

for (const contents of ['broken json', '{}', '[{}]', '[{"eventId":"x","remindAt":"1h","sentAt":"invalid"}]']) {
  test(`invalid persisted state fails closed: ${contents}`, (t) => {
    const f = fixture(t); writeFileSync(f.statePath, contents); assert.throws(() => f.runner());
    assert.equal(f.sent.length, 0); assert.equal(readFileSync(f.statePath, 'utf8'), contents);
  });
}

test('state-save failure stops further sends and preserves a reconciliation lock', async (t) => {
  const f = fixture(t); f.setTime('09:30:00'); const runner = f.runner();
  f.config.notifiers[0].send = async (params) => { f.sent.push(params); mkdirSync(f.statePath); };
  await assert.rejects(runner.check()); assert.equal(f.sent.length, 1);
  await assert.rejects(runner.check()); assert.equal(f.sent.length, 1);
  assert.deepEqual(readdirSync(f.dir).sort(), ['state.json', 'state.json.lock']);
  rmSync(f.statePath, { recursive: true });
  await assert.rejects(f.runner().check(), /先核对发送状态/);
  assert.equal(f.sent.length, 1);
});

test('successful state files are valid JSON with no temporary files left behind', async (t) => {
  const f = fixture(t); f.setTime('09:30:00'); await f.runner().check();
  assert.deepEqual(readdirSync(f.dir), ['state.json']); assert.equal(f.records().length, 1);
});


test('separately constructed runners reload persisted deliveries before checking', async (t) => {
  const f = fixture(t); f.setTime('09:30:00'); const a = f.runner(); const b = f.runner();
  await a.check(); await b.check(); assert.equal(f.sent.length, 1);
});

test('independent overlapping runners cannot deliver against the same state concurrently', async (t) => {
  const f = fixture(t); let release; const blocked = new Promise((resolve) => { release = resolve; });
  f.config.notifiers[0].send = async (params) => { f.sent.push(params); await blocked; };
  f.setTime('09:30:00'); const a = f.runner(); const b = f.runner(); const first = a.check();
  await assert.rejects(b.check(), /检查锁已存在/);
  release(); await first; await b.check(); assert.equal(f.sent.length, 1);
  assert.deepEqual(readdirSync(f.dir), ['state.json']);
});

test('an interrupted-check lock fails closed and is not silently removed', async (t) => {
  const f = fixture(t); writeFileSync(`${f.statePath}.lock`, '{"pid":99999999}');
  f.setTime('09:30:00'); await assert.rejects(f.runner().check(), /先核对发送状态/);
  assert.equal(f.sent.length, 0); assert.deepEqual(readdirSync(f.dir), ['state.json.lock']);
});

test('channel identity survives reordering and credential-independent reconstruction', async (t) => {
  const f = fixture(t); const calls = []; let fail = true;
  const a = { name: 'email', deliveryId: 'destination-a', async send() { calls.push('a'); } };
  const b = { name: 'email', deliveryId: 'destination-b', async send() { calls.push('b'); if (fail) throw new Error('synthetic outage'); } };
  f.config.notifiers = [a, b]; f.setTime('09:30:00'); await assert.rejects(f.runner().check(), AggregateError);
  fail = false; f.config.notifiers = [b, a]; await f.runner().check();
  assert.deepEqual(calls, ['a', 'b', 'b']);
});

test('duplicate notifier destination configurations do not double-send', async (t) => {
  const f = fixture(t); f.config.notifiers[0].deliveryId = 'same-destination';
  f.config.notifiers.push(f.config.notifiers[0]); f.setTime('09:30:00'); await f.runner().check();
  assert.equal(f.sent.length, 1);
});


test('delivery IDs are namespaced by notifier type', async (t) => {
  const f = fixture(t); f.config.notifiers[0].deliveryId = 'shared-id';
  f.config.notifiers.push({ name: 'different-provider', deliveryId: 'shared-id', async send(params) { f.sent.push(params); } });
  f.setTime('09:30:00'); await f.runner().check(); await f.runner().check(); assert.equal(f.sent.length, 2);
});

test('calendar, brief and channel failures aggregate after independent deliveries finish', async (t) => {
  const f = fixture(t); const prepare = f.config.prepareNotification; const calls = [];
  f.config.calendarSources.unshift({ name: 'bad-calendar', async fetchEvents() { throw new Error('calendar outage'); } });
  f.setEvents([event(at('10:30:00'), { id: 'bad-brief' }), event()]);
  f.config.prepareNotification = async (e, label) => {
    if (e.id === 'bad-brief') throw new Error('brief outage'); return prepare(e, label);
  };
  f.config.notifiers.unshift({ name: 'bad-channel', async send() { calls.push('failed'); throw new Error('channel outage'); } });
  f.setTime('09:30:00');
  await assert.rejects(f.runner().check(), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 3);
    assert.match(error.errors[0].message, /bad-calendar/);
    assert.match(error.errors[1].message, /简报失败/);
    assert.match(error.errors[2].message, /bad-channel/);
    return true;
  });
  assert.deepEqual(calls, ['failed']); assert.equal(f.sent.length, 1); assert.equal(f.records().length, 1);
  assert.deepEqual(readdirSync(f.dir), ['state.json']);
});

test('unsafe state failure aborts later channels while preserving earlier failure details', async (t) => {
  const f = fixture(t); let later = false;
  f.config.notifiers = [
    { name: 'outage', async send() { throw new Error('channel outage'); } },
    { name: 'delivered', async send(params) { f.sent.push(params); mkdirSync(f.statePath); } },
    { name: 'later', async send() { later = true; } },
  ];
  f.setTime('09:30:00');
  await assert.rejects(f.runner().check(), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /outage/); assert.match(error.errors[1].message, /状态保存失败/); return true;
  });
  assert.equal(f.sent.length, 1); assert.equal(later, false);
  assert.deepEqual(readdirSync(f.dir).sort(), ['state.json', 'state.json.lock']);
});

for (const thrown of [undefined, null, 'string rejection']) {
  test(`non-Error failure ${String(thrown)} does not abort other calendars, briefs or channels`, async (t) => {
    const f = fixture(t); const prepare = f.config.prepareNotification;
    f.config.calendarSources.unshift({ name: 'bad-calendar', async fetchEvents() { throw thrown; } });
    f.setEvents([event(at('10:30:00'), { id: 'bad-brief' }), event()]);
    f.config.prepareNotification = async (e, label) => { if (e.id === 'bad-brief') throw thrown; return prepare(e, label); };
    f.config.notifiers.unshift({ name: 'bad-notifier', async send() { throw thrown; } });
    f.setTime('09:30:00');
    await assert.rejects(f.runner().check(), (error) => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 3); return true;
    });
    assert.equal(f.sent.length, 1); assert.equal(f.records().length, 1);
  });
}

test('partial calendar failures retain valid reminders and do not block another source', async (t) => {
  const f = fixture(t); f.source.fetchEvents = async () => {
    throw new PartialFetchError('one calendar failed', [new Error('synthetic')], [event()]);
  };
  f.config.calendarSources.push({ name: 'other', async fetchEvents() { return [event(at('10:30:00'), { id: 'another' })]; } });
  f.setTime('09:30:00');
  await assert.rejects(f.runner().check(), (error) => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 1); return true;
  });
  assert.equal(f.sent.length, 2); assert.equal(f.records().length, 2);
  f.source.fetchEvents = async () => [event()]; await f.runner().check(); assert.equal(f.sent.length, 2);
});

test('a failed calendar with zero partial events is not a successful empty read', async (t) => {
  const f = fixture(t); f.source.fetchEvents = async () => { throw new PartialFetchError('failed', [new Error('synthetic')], []); };
  f.setTime('09:30:00'); await assert.rejects(f.runner().check(), AggregateError); assert.equal(f.sent.length, 0);
});
