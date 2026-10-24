import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError } from '../src/config.js';

const base = {
  line: { url: 'ws://127.0.0.1:3789/api/ws', token: 't', chats: { c0123456789abcdef: ' 貓咪群 ' } },
  claude: { apiKey: 'k' },
};

test('chats map IDs to display names and the model defaults to claude-haiku-5-5', () => {
  const config = parseConfig(base, '/srv/nekobrief');
  assert.deepEqual([...config.line.chats], [['c0123456789abcdef', '貓咪群']]);
  assert.equal(config.claude.model, 'claude-haiku-5-5');
  assert.equal(config.database, '/srv/nekobrief/chatlog.db');
});

test('rejects a chat list without names, a bad ID, or a blank name', () => {
  for (const chats of [['c0123456789abcdef'], { 'bad id': '名稱' }, { c0123456789abcdef: ' ' }, {}]) {
    assert.throws(() => parseConfig({ ...base, line: { ...base.line, chats } }, '/'), ConfigError);
  }
});
