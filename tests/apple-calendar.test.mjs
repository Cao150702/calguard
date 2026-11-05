import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { AppleCalendarSource } from '../dist/sources/calendar/apple.js';
import { PartialFetchError } from '../dist/sources/errors.js';

const from = new Date('2026-11-05T09:00:00Z'), to = new Date('2026-11-05T11:00:00Z');
const row = (changes = {}) => ({ title: '会议', start: '2026-11-05T10:00:00.000Z', end: '2026-11-05T11:00:00.000Z', attendees: ['fake@example.invalid'], location: '', description: '', ...changes });
function fixture(t, replies) {
  const calls = [];
  globalThis.__calguardFakeAppleCommand = (command, args, options) => {
    assert.equal(command, 'osascript'); assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e']); assert.equal(args.length, 4);
    assert.equal(options.encoding, 'utf-8'); assert.equal(options.shell, undefined);
    const reply = replies[calls.length]; calls.push({ command, args, options });
    assert.ok(reply !== undefined, 'Unexpected command; no subprocess is permitted');
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(args[3]) : reply;
  };
  t.after(() => { delete globalThis.__calguardFakeAppleCommand; });
  return { calls, source: new AppleCalendarSource({ skipCalendars: [], timeoutSeconds: 7 }) };
}
function runScript(calendars, script) {
  const lookup = () => calendars.map(c => ({ name: () => c.name }));
  lookup.byName = (name) => {
    const cal = calendars.find(c => c.name === name); assert.ok(cal, 'Name must be passed without interpolation damage');
    return { events: () => { if (cal.error) throw cal.error; return cal.events; } };
  };
  return vm.runInNewContext(script, { Application(name) { assert.equal(name, 'Calendar'); return { calendars: lookup }; } }, { timeout: 1000 });
}
function bridgeEvent(r = row()) {
  return { summary: () => r.title, startDate: () => new Date(r.start), endDate: () => new Date(r.end), location: () => r.location,
    description: () => r.description, attendees: () => r.attendees.map(email => ({ email: () => email })) };
}
async function partial(promise, ids = 1) {
  let error;
  try { await promise; } catch (err) { error = err; }
  assert.ok(error instanceof PartialFetchError); assert.equal(error.partialResults.length, ids); assert.ok(error.errors.length > 0); return error;
}

test('actual generated JXA preserves Chinese text and unsafe delimiters with locale-independent dates', async (t) => {
  const name = '项目|日历\t换行\n"单引号\'\\; throw new Error("injection") //';
  const r = row({ title: '评审\t会议|讨论\n"引号"', location: '上海\t会议室|二楼\n东侧', description: '中文说明\n\t含|分隔符和\\路径' });
  const calendars = [{ name, events: [bridgeEvent(r)] }];
  const execute = script => runScript(calendars, script);
  const f = fixture(t, [execute, execute]); const events = await f.source.fetchEvents(from, to);
  assert.equal(events.length, 1); const e = events[0];
  assert.equal(e.calendar, name); assert.equal(e.title, r.title); assert.equal(e.location, r.location); assert.equal(e.description, r.description);
  assert.equal(e.start.toISOString(), r.start); assert.equal(e.end.toISOString(), r.end); assert.deepEqual(e.attendees, r.attendees);
  assert.equal(e.id, `apple-${name}-${new Date(r.start).getTime()}`); assert.equal(f.calls[0].options.timeout, 15000); assert.equal(f.calls[1].options.timeout, 7000);
});

test('actual generated JXA reports one unreadable event while retaining valid events', async (t) => {
  const bad = bridgeEvent(); bad.startDate = () => new Date(NaN);
  const calendars = [{ name: '中文', events: [bridgeEvent(), bad] }]; const execute = script => runScript(calendars, script);
  const f = fixture(t, [execute, execute]); const error = await partial(f.source.fetchEvents(from, to));
  assert.equal(error.partialResults[0].title, '会议'); assert.equal(error.errors.length, 1);
});

test('actual generated JXA retains valid events when optional location read fails', async (t) => {
  const bad = bridgeEvent(); bad.location = () => { throw new Error('fake bridge read failure'); };
  const calendars = [{ name: 'work', events: [bad, bridgeEvent()] }]; const execute = script => runScript(calendars, script);
  const f = fixture(t, [execute, execute]); const error = await partial(f.source.fetchEvents(from, to), 2);
  assert.equal(error.partialResults[0].location, undefined);
});

for (const [label, value] of [
  ['Chinese legacy date', '2026年11月5日 星期四 10:00:00'],
  ['timezone absent', '2026-11-05T10:00:00.000'],
  ['impossible date', '2026-02-30T10:00:00.000Z'],
  ['invalid timestamp', 'not a date'],
  ['missing timestamp', undefined],
  ['wrong timestamp type', 42],
]) test(`Apple Calendar rejects ${label} while retaining valid rows`, async (t) => {
  const f = fixture(t, ['["work"]', JSON.stringify({ events: [row(), row({ start: value })], errors: [] })]);
  await partial(f.source.fetchEvents(from, to));
});

for (const [label, bad] of [
  ['null row', null], ['missing title', { ...row(), title: undefined }], ['invalid title', row({ title: 1 })],
  ['invalid attendees', row({ attendees: ['valid', 2] })], ['missing attendees', { ...row(), attendees: undefined }],
  ['invalid location', row({ location: {} })], ['invalid description', row({ description: false })],
  ['end before start', row({ end: '2026-11-05T09:00:00.000Z' })],
]) test(`Apple Calendar rejects ${label} while retaining valid rows`, async (t) => {
  const f = fixture(t, ['["work"]', JSON.stringify({ events: [bad, row()], errors: [] })]); await partial(f.source.fetchEvents(from, to));
});

for (const [label, response] of [['command failure', new Error('synthetic timeout')], ['invalid JSON', '{'], ['wrong shape', '{}'], ['invalid names', '[null]']]) {
  test(`Apple Calendar list ${label} is visible`, async (t) => {
    const f = fixture(t, [response]); await partial(f.source.fetchEvents(from, to), 0); assert.equal(f.calls.length, 1);
  });
}

for (const [label, response] of [['command failure', new Error('synthetic timeout')], ['invalid JSON', '{'], ['wrong shape', '[]'], ['missing errors list', '{"events":[]}']]) {
  test(`Apple Calendar per-calendar ${label} preserves preceding and subsequent calendars`, async (t) => {
    const payload = JSON.stringify({ events: [row()], errors: [] });
    const f = fixture(t, ['["first","broken","last"]', payload, response, payload]);
    const error = await partial(f.source.fetchEvents(from, to), 2);
    assert.deepEqual(error.partialResults.map(e => e.calendar), ['first', 'last']); assert.equal(f.calls.length, 4);
  });
}

test('Apple Calendar bridge errors are visible even when all rows are empty', async (t) => {
  const f = fixture(t, ['["work"]', JSON.stringify({ events: [], errors: ['fake serialization failure'] })]);
  await partial(f.source.fetchEvents(from, to), 0);
});

test('Apple Calendar malformed bridge error entries are visible', async (t) => {
  const f = fixture(t, ['["work"]', JSON.stringify({ events: [row()], errors: [null] })]);
  await partial(f.source.fetchEvents(from, to));
});

test('Apple Calendar preserves true empty calendar list and true empty events', async (t) => {
  const f = fixture(t, ['[]', '["empty"]', '{"events":[],"errors":[]}']);
  assert.deepEqual(await f.source.fetchEvents(from, to), []);
  assert.deepEqual(await f.source.fetchEvents(from, to), []);
  assert.equal(f.calls.length, 3);
});

test('Apple Calendar skip list avoids per-calendar reads', async (t) => {
  const f = fixture(t, ['["skip"]']); const source = new AppleCalendarSource({ skipCalendars: ['skip'] });
  assert.deepEqual(await source.fetchEvents(from, to), []); assert.equal(f.calls.length, 1);
});

test('Apple Calendar filtering preserves overlapping/boundary events and default untitled label', async (t) => {
  const f = fixture(t, ['["work"]', JSON.stringify({ events: [
    row({ title: '' }), row({ start: '2026-11-05T08:00:00.000Z', end: from.toISOString() }),
    row({ start: to.toISOString(), end: '2026-11-05T12:00:00.000Z' }),
    row({ start: '2026-11-05T12:00:00.000Z', end: '2026-11-05T13:00:00.000Z' }),
  ], errors: [] })]);
  const events = await f.source.fetchEvents(from, to); assert.equal(events.length, 3); assert.equal(events[0].title, '(无标题)');
});

test('Apple Calendar rejects invalid query range without commands', async (t) => {
  const f = fixture(t, []); await partial(f.source.fetchEvents(new Date(NaN), to), 0); await partial(f.source.fetchEvents(to, from), 0); assert.equal(f.calls.length, 0);
});

for (const field of ['description', 'attendees']) test(`actual generated JXA retains events when optional ${field} fails`, async (t) => {
  const event = bridgeEvent(); event[field] = () => { throw new Error('fake optional read failure'); };
  const calendars = [{ name: 'work', events: [event, bridgeEvent()] }]; const execute = script => runScript(calendars, script);
  const f = fixture(t, [execute, execute]); const error = await partial(f.source.fetchEvents(from, to), 2);
  assert.equal(error.errors.length, 1);
  if (field === 'attendees') assert.deepEqual(error.partialResults[0].attendees, []);
  else assert.equal(error.partialResults[0].description, undefined);
});

test('actual generated JXA keeps other attendees when one email getter fails', async (t) => {
  const event = bridgeEvent(); event.attendees = () => [
    { email: () => 'first@example.invalid' }, { email: () => { throw new Error('fake email read failure'); } },
    { email: () => 'last@example.invalid' },
  ];
  const calendars = [{ name: 'work', events: [event] }]; const execute = script => runScript(calendars, script);
  const f = fixture(t, [execute, execute]); const error = await partial(f.source.fetchEvents(from, to));
  assert.deepEqual(error.partialResults[0].attendees, ['first@example.invalid', 'last@example.invalid']); assert.equal(error.errors.length, 1);
});

test('actual generated JXA converts explicit +08:00 dates to UTC without changing ID formula', async (t) => {
  const r = row({ start: '2026-11-05T18:00:00+08:00', end: '2026-11-05T19:00:00+08:00' });
  const calendars = [{ name: '上海', events: [bridgeEvent(r)] }]; const execute = script => runScript(calendars, script);
  const f = fixture(t, [execute, execute]); const [event] = await f.source.fetchEvents(from, to);
  assert.equal(event.start.toISOString(), '2026-11-05T10:00:00.000Z'); assert.equal(event.end.toISOString(), '2026-11-05T11:00:00.000Z');
  assert.equal(event.id, `apple-上海-${Date.parse(r.start)}`);
});

test('actual generated JXA distinguishes repeated DST hour offsets and occurrence IDs', async (t) => {
  const a = row({ start: '2026-11-01T01:30:00-04:00', end: '2026-11-01T01:45:00-04:00' });
  const b = row({ start: '2026-11-01T01:30:00-05:00', end: '2026-11-01T01:45:00-05:00' });
  const calendars = [{ name: 'DST', events: [bridgeEvent(a), bridgeEvent(b)] }]; const execute = script => runScript(calendars, script);
  const f = fixture(t, [execute, execute]); const events = await f.source.fetchEvents(new Date('2026-11-01T04:00:00Z'), new Date('2026-11-01T08:00:00Z'));
  assert.deepEqual(events.map(e => e.start.toISOString()), ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  assert.deepEqual(events.map(e => e.id), [`apple-DST-${Date.parse(a.start)}`, `apple-DST-${Date.parse(b.start)}`]);
  assert.notEqual(events[0].id, events[1].id);
});
