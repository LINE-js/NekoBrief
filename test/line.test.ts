import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatLog } from '../src/store.js';
import { LineRecorder } from '../src/line.js';

const CHAT = 'c0123456789abcdef';
const OTHER = 'c9999999999abcdef';

function setup() {
  const log = new ChatLog(':memory:');
  const recorder = new LineRecorder({
    config: { url: 'ws://127.0.0.1:3789/api/ws', token: 't', chats: new Map([[CHAT, '測試群']]) }, log, timezone: 'Asia/Taipei',
  });
  recorder.receive({ type: 'hello', protocol: 2 });
  const rows = () => log.db.prepare('SELECT sent_at, chat_id, sender_id, text FROM messages ORDER BY rowid').all()
    .map(row => ({ ...row }));
  return { recorder, rows };
}

const message = (fields: Record<string, unknown>) => ({
  type: 'message',
  message: {
    channelId: CHAT, messageId: 'm1', senderId: 'uA', text: '早安', contentType: 'NONE',
    createdAt: Date.parse('2026-10-24T00:59:59.500Z'), ...fields,
  },
});

test('records configured chat text with local date-time, chat ID, sender ID and content', () => {
  const { recorder, rows } = setup();
  recorder.receive(message({}));
  recorder.receive(message({}));
  recorder.receive(message({ messageId: 'm2', channelId: OTHER }));
  recorder.receive(message({ messageId: 'm3', contentType: 'STICKER', text: '' }));
  assert.deepEqual(rows(), [{ sent_at: '2026-10-24 08:59:59', chat_id: CHAT, sender_id: 'uA', text: '早安' }]);
});

test('edits replace the text and withdrawn messages are removed', () => {
  const { recorder, rows } = setup();
  recorder.receive(message({}));
  recorder.receive(message({ messageId: 'm2', text: '午安' }));
  recorder.receive({ type: 'message:edit', message: { channelId: CHAT, messageId: 'm1', contentType: 'NONE', text: '早安啊' } });
  recorder.receive({ type: 'message:unsend', chatId: CHAT, messageId: 'm2' });
  assert.deepEqual(rows().map(row => row.text), ['早安啊']);
});

test('ignores messages before the protocol handshake', () => {
  const log = new ChatLog(':memory:');
  const recorder = new LineRecorder({
    config: { url: 'ws://127.0.0.1:3789/api/ws', token: 't', chats: new Map([[CHAT, '測試群']]) }, log, timezone: 'Asia/Taipei',
  });
  recorder.receive(message({}));
  assert.equal(log.pending(CHAT, '9999', 10).length, 0);
});
