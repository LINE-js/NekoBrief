import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatLog } from '../src/store.js';
import { Summarizer, type SummaryFetch } from '../src/summarizer.js';

const CHAT = 'c0123456789abcdef';
const claude = { apiKey: 'key', model: 'claude-haiku-5-5', maxOutputTokens: 4096, timeoutMs: 5000 };
const at = (time: string) => Date.parse(`${time.replace(' ', 'T')}+08:00`);

function setup(replies: unknown[], now: string) {
  const log = new ChatLog(':memory:');
  const requests: { model: string; activeTopics: { id: number }[]; messages: { index: number; time: string; speaker: string; text: string }[] }[] = [];
  const fetchImpl: SummaryFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ model: body.model, ...JSON.parse(body.messages[0].content) });
    const input = replies.shift();
    return {
      ok: true, status: 200,
      json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'record_summary', input }] }),
    };
  };
  const summarizer = new Summarizer({ claude, log, chats: [CHAT], timezone: 'Asia/Taipei', fetchImpl, now: () => at(now) });
  const add = (sentAt: string, senderId: string, text: string) =>
    log.record({ sentAt, chatId: CHAT, senderId, text, messageId: `${sentAt}-${senderId}` });
  return { log, summarizer, requests, add };
}

test('a topic that runs past the hour boundary stays in the hour it started', async () => {
  const { log, summarizer, requests, add } = setup([
    { continued: [], topics: [{ title: '週末爬山', points: ['討論週六去爬山'], messages: [0, 1] }] },
    {
      continued: [{ topicId: 1, messages: [0], points: ['討論週六去爬山', '決定早上七點集合'] }],
      topics: [{ title: '新顯示卡', points: ['有人買了新顯示卡'], messages: [1, 2] }],
    },
  ], '2026-10-24 17:00:30');
  add('2026-10-24 14:50:00', 'uA', '週六要不要去爬山');
  add('2026-10-24 14:58:00', 'uB', '好啊');
  add('2026-10-24 15:05:00', 'uA', '那七點集合');
  add('2026-10-24 15:20:00', 'uC', '我買了新顯卡');
  add('2026-10-24 15:21:00', 'uA', '哪一張');
  add('2026-10-24 16:00:10', 'uA', '還在進行中的小時');

  await summarizer.runOnce();

  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.model, 'claude-haiku-5-5');
  // Batches never span hours, and hours that ended less than an hour ago are left alone.
  assert.deepEqual(requests[0]!.messages.map(message => message.time), ['14:50', '14:58']);
  assert.deepEqual(requests[1]!.messages.map(message => message.time), ['15:05', '15:20', '15:21']);
  assert.deepEqual(requests[1]!.activeTopics.map(topic => topic.id), [1]);
  // Speakers are pseudonymous; sender IDs never reach the model.
  assert.ok(!JSON.stringify(requests).includes('uA'));

  const topics = log.topicsOn(CHAT, '2026-10-24');
  assert.deepEqual(topics.map(topic => [topic.hour, topic.title, topic.startAt, topic.endAt, topic.points]), [
    ['2026-10-24 14', '週末爬山', '2026-10-24 14:50:00', '2026-10-24 15:05:00', ['討論週六去爬山', '決定早上七點集合']],
    ['2026-10-24 15', '新顯示卡', '2026-10-24 15:20:00', '2026-10-24 15:21:00', ['有人買了新顯示卡']],
  ]);
  // The continuation across 15:00 is part of the 14:00 topic's original chat.
  assert.deepEqual(log.topicMessages(CHAT, topics[0]!.id).map(message => message.text), ['週六要不要去爬山', '好啊', '那七點集合']);
  assert.deepEqual(log.topicMessages(CHAT, topics[1]!.id).map(message => message.text), ['我買了新顯卡', '哪一張']);
  assert.deepEqual(log.pending(CHAT, '9999', 10).map(message => message.text), ['還在進行中的小時']);
  // Every batch is recorded per chat and hour, with its time range and the messages it consumed.
  assert.deepEqual(log.db.prepare(`SELECT chat_id AS chatId, hour, start_at AS startAt, end_at AS endAt,
    message_count AS messageCount, model, summarized_at AS summarizedAt FROM summaries ORDER BY id`).all().map(row => ({ ...row })), [
    { chatId: CHAT, hour: '2026-10-24 14', startAt: '2026-10-24 14:50:00', endAt: '2026-10-24 14:58:00',
      messageCount: 2, model: 'claude-haiku-5-5', summarizedAt: '2026-10-24 17:00:30' },
    { chatId: CHAT, hour: '2026-10-24 15', startAt: '2026-10-24 15:05:00', endAt: '2026-10-24 15:21:00',
      messageCount: 3, model: 'claude-haiku-5-5', summarizedAt: '2026-10-24 17:00:30' },
  ]);
});

test('an hour is summarized two hours after it started, not right after it ends', async () => {
  const { log, summarizer, requests, add } = setup([
    { continued: [], topics: [{ title: '早餐', points: ['吃什麼'], messages: [0] }] },
  ], '2026-10-24 16:00:30');
  add('2026-10-24 14:50:00', 'uA', '早餐吃什麼');
  add('2026-10-24 15:50:00', 'uA', '剛結束的小時');

  await summarizer.runOnce();

  assert.deepEqual(requests.map(request => request.messages.map(message => message.text)), [['早餐吃什麼']]);
  assert.deepEqual(log.pending(CHAT, '9999', 10).map(message => message.text), ['剛結束的小時']);
});

test('an unusable reply leaves the hour pending and stops later hours', async () => {
  const { log, summarizer, requests, add } = setup([null], '2026-10-24 17:00:30');
  add('2026-10-24 14:50:00', 'uA', '一');
  add('2026-10-24 15:50:00', 'uA', '二');

  await summarizer.runOnce();

  assert.equal(requests.length, 1);
  assert.deepEqual(log.topicsOn(CHAT, '2026-10-24'), []);
  assert.equal(log.pending(CHAT, '9999', 10).length, 2);
});

test('grouping mistakes drop the bad part instead of failing the hour', async () => {
  const { log, summarizer, add } = setup([
    { continued: [{ topicId: 99, points: ['不存在的主題'], messages: [2] }], topics: [
      { title: 'a', points: ['a'], messages: [0, 7, 1.5] },
      // Message 0 already belongs to topic a.
      { title: 'b', points: ['b'], messages: [0, 1] },
      { title: 'c', points: [' '], messages: [2] },
    ] },
  ], '2026-10-24 16:00:30');
  add('2026-10-24 14:50:00', 'uA', '一');
  add('2026-10-24 14:51:00', 'uB', '二');
  add('2026-10-24 14:52:00', 'uA', '三');

  await summarizer.runOnce();

  const topics = log.topicsOn(CHAT, '2026-10-24');
  assert.deepEqual(topics.map(topic => [topic.title, log.topicMessages(CHAT, topic.id).map(message => message.text)]), [
    ['a', ['一']],
    ['b', ['二']],
  ]);
  assert.equal(log.pending(CHAT, '9999', 10).length, 0);
});
