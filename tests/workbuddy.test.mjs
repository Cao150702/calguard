import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import { WorkbuddyNotifier } from '../dist/notifiers/workbuddy.js';
const params = { title: 'Synthetic', event: { id: 'test', title: 'Synthetic', start: new Date('2026-11-05T10:30:00Z'), end: new Date('2026-11-05T11:30:00Z'), attendees: [], source: 'fake' }, brief: '', messages: [], remindAt: '1h' };

test('WorkBuddy waits for the output stream write callback', async () => {
  let complete; let content = ''; let settled = false;
  const output = new Writable({ write(chunk, encoding, callback) { content += chunk; complete = callback; } });
  const sending = new WorkbuddyNotifier('full', output).send(params).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(settled, false);
  complete(); await sending; assert.equal(settled, true); assert.match(content, /Synthetic/);
  assert.equal(output.listenerCount('error'), 0);
});

test('WorkBuddy rejects an asynchronous broken pipe without an unhandled error', async () => {
  const output = new Writable({ write(chunk, encoding, callback) { setImmediate(() => callback(new Error('synthetic EPIPE'))); } });
  await assert.rejects(new WorkbuddyNotifier('full', output).send(params), /synthetic EPIPE/);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(output.listenerCount('error'), 0);
});
