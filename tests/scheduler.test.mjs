import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
  const notifiers = [{ name: 'fake', async send(params) { sent.push(params); } }];
  globalThis.__calguardSchedules = [];
  return { sent, config, notifiers, setTime: (time) => { now = new Date(`2026-11-05T${time}Z`); },
    scheduler: () => new CalGuardScheduler(config, calendars, [], notifiers, { now: () => now, statePath: join(dir, 'state.json') }) };
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
