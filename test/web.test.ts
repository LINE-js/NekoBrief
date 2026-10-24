import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ChatLog } from '../src/store.js';
import { createWebServer } from '../src/web.js';

const CHAT = 'c0123456789abcdef';
const OTHER = 'c9999999999abcdef';

test('serves summaries by chat and date, original messages per topic, and the page for path routes', async t => {
  const log = new ChatLog(':memory:');
  const add = (chatId: string, sentAt: string, senderId: string, text: string) =>
    log.record({ sentAt, chatId, senderId, text, messageId: `${chatId}-${sentAt}` });
  add(CHAT, '2026-10-23 23:40:00', 'uAlice', '還醒著？');
  add(CHAT, '2026-10-23 23:41:00', 'uBob', '在看動畫');
  add(CHAT, '2026-10-24 00:20:00', 'uAlice', '晚安');
  add(OTHER, '2026-10-24 08:00:00', 'uEve', '別的聊天室');
  log.applySummary(CHAT, [], [], [
    { title: '跨日話題', points: ['重點'], startAt: '2026-10-23 23:40:00', endAt: '2026-10-24 00:20:00', messageIds: [1, 2, 3] },
    { title: '早餐', points: ['吃什麼'], startAt: '2026-10-24 08:05:00', endAt: '2026-10-24 08:30:00', messageIds: [] },
  ]);
  log.applySummary(OTHER, [], [], [
    { title: '別處', points: ['x'], startAt: '2026-10-24 08:00:00', endAt: '2026-10-24 08:00:00', messageIds: [4] },
  ]);
  const server = createWebServer({
    chats: new Map([[CHAT, '貓咪群']]), log, timezone: 'Asia/Taipei', now: () => Date.parse('2026-10-24T03:00:00Z'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string) => fetch(base + path);

  assert.deepEqual(await (await get(`/api/chats/${CHAT}`)).json(),
    { name: '貓咪群', today: '2026-10-24', days: ['2026-10-23', '2026-10-24'] });
  // The cross-midnight topic belongs to the day and hour it started.
  assert.deepEqual(await (await get(`/api/chats/${CHAT}/days/20261023`)).json(), {
    date: '2026-10-23',
    topics: [{
      id: 1, hour: '23', title: '跨日話題', points: ['重點'],
      start: '2026-10-23 23:40', end: '2026-10-24 00:20', messageCount: 3,
    }],
  });
  const day = await (await get(`/api/chats/${CHAT}/days/20261024`)).json() as { topics: { title: string }[] };
  assert.deepEqual(day.topics.map(topic => topic.title), ['早餐']);

  // Original messages come without sender IDs; speakers are ordinals within the topic.
  const chat = await (await get(`/api/chats/${CHAT}/topics/1`)).text();
  assert.ok(!chat.includes('uAlice') && !chat.includes('uBob'));
  assert.deepEqual(JSON.parse(chat), { messages: [
    { time: '2026-10-23 23:40', speaker: 0, text: '還醒著？' },
    { time: '2026-10-23 23:41', speaker: 1, text: '在看動畫' },
    { time: '2026-10-24 00:20', speaker: 0, text: '晚安' },
  ] });
  // A topic of another (unconfigured) chat cannot be read through a configured chat ID.
  assert.deepEqual(await (await get(`/api/chats/${CHAT}/topics/3`)).json(), { messages: [] });
  assert.equal((await get(`/api/chats/${OTHER}/topics/3`)).status, 404);

  assert.equal((await get(`/api/chats/${CHAT}/days/20261332`)).status, 404);
  assert.equal((await get(`/api/chats/${OTHER}`)).status, 404);
  const file = await get(`/${CHAT}/20261023.json`);
  assert.match(file.headers.get('content-disposition') ?? '', /filename="c0123456789abcdef-20261023\.json"/);
  assert.equal(file.headers.get('access-control-allow-origin'), '*');
  const exported = await file.text();
  assert.ok(!exported.includes('uAlice'));
  assert.deepEqual(JSON.parse(exported), { chat: '貓咪群', date: '2026-10-23', topics: [{
    hour: '23', title: '跨日話題', points: ['重點'], start: '2026-10-23 23:40', end: '2026-10-24 00:20',
    messages: [
      { time: '2026-10-23 23:40', speaker: 0, text: '還醒著？' },
      { time: '2026-10-23 23:41', speaker: 1, text: '在看動畫' },
      { time: '2026-10-24 00:20', speaker: 0, text: '晚安' },
    ],
  }] });
  assert.equal((await get(`/${OTHER}/20261024.json`)).status, 404);
  for (const path of [`/${CHAT}`, `/${CHAT}/20261024`]) {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /\/assets\/app\.js/);
  }
  assert.equal((await get(`/${CHAT}/2026-10-24`)).status, 404);
});
