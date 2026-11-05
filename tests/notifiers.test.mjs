import test from 'node:test';
import assert from 'node:assert/strict';
import { DingtalkNotifier } from '../dist/notifiers/dingtalk.js';
import { FeishuNotifier } from '../dist/notifiers/feishu.js';
import { WecomNotifier } from '../dist/notifiers/wecom.js';

const params = {
  title: 'Offline test', brief: '', messages: [], remindAt: '1h',
  event: { id: 'fake', title: 'Offline test', start: new Date('2026-11-05T09:30:00Z'),
    end: new Date('2026-11-05T10:00:00Z'), attendees: [], source: 'fake' },
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const token = () => json({ errcode: 0, access_token: 'fake-token', expires_in: 7200 });
const makeWecom = () => new WecomNotifier({ corp_id: 'fake', agent_id: '1', secret: 'fake' });
function fakeFetch(t, responses) {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    assert.ok(calls < responses.length, 'Unexpected fetch; real network is never used');
    const response = responses[calls++];
    if (response instanceof Error) throw response;
    return response;
  });
  return () => calls;
}

for (const [name, create, success, failure] of [
  ['DingTalk', () => new DingtalkNotifier({ webhook: 'https://offline.invalid/fake' }), { errcode: 0 }, { errcode: 310000 }],
  ['Feishu', () => new FeishuNotifier({ webhook: 'https://offline.invalid/fake' }), { code: 0 }, { code: 19021 }],
]) {
  for (const [label, response] of [
    ['non-2xx', () => json(success, 503)],
    ['API error', () => json(failure)],
    ['missing status', () => json({})],
    ['null body', () => json(null)],
    ['string status', () => json(name === 'Feishu' ? { code: '0' } : { errcode: '0' })],
    ['malformed JSON', () => new Response('not JSON')],
    ['network rejection', () => new Error('fake connection failure')],
  ]) {
    test(`${name} rejects ${label}`, async (t) => {
      fakeFetch(t, [response()]);
      await assert.rejects(create().send(params));
    });
  }
  test(`${name} succeeds only with explicit success`, async (t) => {
    const calls = fakeFetch(t, [json(success)]);
    await create().send(params);
    assert.equal(calls(), 1);
  });
  test(`${name} can retry after provider rejection`, async (t) => {
    const calls = fakeFetch(t, [json(failure), json(success)]);
    const notifier = create();
    await assert.rejects(notifier.send(params));
    await notifier.send(params);
    assert.equal(calls(), 2);
  });
}
test('Feishu accepts legacy explicit success', async (t) => {
  fakeFetch(t, [json({ StatusCode: 0 })]);
  await new FeishuNotifier({ webhook: 'https://offline.invalid/fake' }).send(params);
});
test('Feishu rejects contradictory response statuses', async (t) => {
  fakeFetch(t, [json({ code: 0, StatusCode: 1 })]);
  await assert.rejects(new FeishuNotifier({ webhook: 'https://offline.invalid/fake' }).send(params));
});

for (const [label, response] of [
  ['non-2xx', () => json({ errcode: 0, access_token: 'fake' }, 503)],
  ['API error', () => json({ errcode: 40013 })],
  ['missing status', () => json({ access_token: 'fake' })],
  ['missing token', () => json({ errcode: 0 })],
  ['empty token', () => json({ errcode: 0, access_token: '' })],
  ['blank token', () => json({ errcode: 0, access_token: ' ' })],
  ['non-string token', () => json({ errcode: 0, access_token: 123 })],
  ['null body', () => json(null)],
  ['malformed JSON', () => new Response('not JSON')],
]) {
  test(`WeCom rejects token ${label} before sending`, async (t) => {
    const calls = fakeFetch(t, [response()]);
    await assert.rejects(makeWecom().send(params));
    assert.equal(calls(), 1);
  });
}
for (const [label, response] of [
  ['non-2xx', () => json({ errcode: 0 }, 503)],
  ['API error', () => json({ errcode: 40014 })],
  ['missing status', () => json({})],
  ['null body', () => json(null)],
  ['string status', () => json({ errcode: '0' })],
  ['malformed JSON', () => new Response('not JSON')],
]) {
  test(`WeCom rejects message ${label}`, async (t) => {
    const calls = fakeFetch(t, [token(), response()]);
    await assert.rejects(makeWecom().send(params));
    assert.equal(calls(), 2);
  });
}
test('WeCom succeeds and preserves token cache', async (t) => {
  const calls = fakeFetch(t, [token(), json({ errcode: 0 }), json({ errcode: 0 })]);
  const notifier = makeWecom();
  await notifier.send(params);
  await notifier.send(params);
  assert.equal(calls(), 3);
});
test('WeCom retries after token failure', async (t) => {
  const calls = fakeFetch(t, [json({ errcode: 40013 }), token(), json({ errcode: 0 })]);
  const notifier = makeWecom();
  await assert.rejects(notifier.send(params));
  await notifier.send(params);
  assert.equal(calls(), 3);
});
test('WeCom retries message failure without refetching valid cached token', async (t) => {
  const calls = fakeFetch(t, [token(), json({ errcode: 45009 }), json({ errcode: 0 })]);
  const notifier = makeWecom();
  await assert.rejects(notifier.send(params));
  await notifier.send(params);
  assert.equal(calls(), 3);
});

for (const [name, create] of [
  ['DingTalk', (opts) => new DingtalkNotifier(opts)],
  ['Feishu', (opts) => new FeishuNotifier(opts)],
]) {
  test(`${name} delivery identity tracks destination, not secret or template`, () => {
    const a = create({ webhook: 'https://offline.invalid/a', secret: 'fake-a', template: 'full' });
    const b = create({ webhook: 'https://offline.invalid/a', secret: 'fake-b', template: 'checklist' });
    const c = create({ webhook: 'https://offline.invalid/b', secret: 'fake-a', template: 'full' });
    assert.match(a.deliveryId, /^[a-f0-9]{64}$/);
    assert.equal(a.deliveryId, b.deliveryId);
    assert.notEqual(a.deliveryId, c.deliveryId);
  });
}
test('WeCom delivery identity tracks corp, agent and recipients, not secret', () => {
  const base = { corp_id: 'fake-corp', agent_id: '1', secret: 'fake-a' };
  const a = new WecomNotifier(base);
  const b = new WecomNotifier({ ...base, secret: 'fake-b', to_user: '@all' });
  assert.match(a.deliveryId, /^[a-f0-9]{64}$/);
  assert.equal(a.deliveryId, b.deliveryId);
  for (const change of [{ corp_id: 'other' }, { agent_id: '2' }, { to_user: 'fake-user' }]) {
    assert.notEqual(a.deliveryId, new WecomNotifier({ ...base, ...change }).deliveryId);
  }
});

for (const errcode of [40001, 40014, 42001]) {
  test(`WeCom invalidates rejected token ${errcode} only for the next attempt`, async (t) => {
    const urls = [];
    const responses = [
      json({ errcode: 0, access_token: 'fake-old-token', expires_in: 7200 }),
      json({ errcode }),
      json({ errcode: 0, access_token: 'fake-new-token', expires_in: 7200 }),
      json({ errcode: 0 }),
    ];
    t.mock.method(globalThis, 'fetch', async (url) => {
      assert.ok(urls.length < responses.length, 'Unexpected fetch; real network is never used');
      urls.push(url);
      return responses[urls.length - 1];
    });
    const notifier = makeWecom();
    await assert.rejects(notifier.send(params));
    assert.equal(urls.length, 2, 'Do not retry automatically within a failed send');
    await notifier.send(params);
    assert.equal(urls.length, 4);
    assert.match(urls[0], /\/gettoken\?/);
    assert.match(urls[1], /access_token=fake-old-token$/);
    assert.match(urls[2], /\/gettoken\?/);
    assert.match(urls[3], /access_token=fake-new-token$/);
  });
}
