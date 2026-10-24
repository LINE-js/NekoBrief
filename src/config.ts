import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { parse } from 'yaml';
import { isRecord } from './guards.js';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const CHAT_ID = /^[ucrsm][A-Za-z0-9]{10,64}$/;

export interface LineConfig {
  url: string;
  token: string;
  /** Chat ID → display name, in configuration order. */
  chats: Map<string, string>;
}

export interface ClaudeConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface WebConfig {
  host: string;
  port: number;
}

export interface Config {
  line: LineConfig;
  claude: ClaudeConfig;
  web: WebConfig;
  timezone: string;
  /** Always `chatlog.db` beside the configuration file. */
  database: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConfigError(message);
}

function integer(value: unknown, min: number, max: number, field: string): asserts value is number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max,
    `${field} 必須是 ${min}～${max} 的整數。`);
}

export async function loadConfig(filename = 'config.yaml'): Promise<Config> {
  const path = resolve(filename);
  let file;
  let raw: unknown;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    requireValue(stat.isFile(), '設定檔必須是一般檔案。');
    requireValue(process.platform === 'win32' || (stat.mode & 0o077) === 0,
      '設定檔包含金鑰，請先執行 chmod 600 config.yaml（自訂路徑請替換檔名）。');
    const text = await file.readFile('utf8');
    raw = ['.yaml', '.yml'].includes(extname(path).toLowerCase())
      ? parse(text, { maxAliasCount: 0 })
      : JSON.parse(text);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('無法讀取設定檔：請確認檔案存在、不是符號連結，且為有效 JSON 或 YAML。');
  } finally {
    await file?.close();
  }
  return parseConfig(raw, dirname(path));
}

export function parseConfig(raw: unknown, baseDir: string): Config {
  requireValue(isRecord(raw), '設定必須是鍵值物件。');
  const { line, claude } = raw;
  const web = raw.web ?? {};
  requireValue(isRecord(line) && isRecord(claude), '缺少 line 或 claude 設定。');
  requireValue(isRecord(web), 'web 必須是鍵值物件。');

  const { url: lineUrl, token, chats } = line;
  let url: URL;
  try {
    if (typeof lineUrl !== 'string') throw new Error();
    url = new URL(lineUrl);
  } catch { throw new ConfigError('line.url 必須是有效的 /api/ws WebSocket URL。'); }
  requireValue(['ws:', 'wss:'].includes(url.protocol) && url.pathname === '/api/ws'
    && !url.username && !url.password && !url.search && !url.hash, 'line.url 必須使用 ws/wss 的 /api/ws，不能夾帶帳密或查詢參數。');
  requireValue(url.protocol === 'wss:' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    '非本機 LINE.js 連線必須使用 wss，以免洩漏 Bearer Token。');
  requireValue(typeof token === 'string' && /^[\x21-\x7e]+$/.test(token), '請填入 line.token：由 LINE.js 的 npm run cli -- token 產生。');
  requireValue(isRecord(chats) && Object.keys(chats).length > 0,
    'line.chats 必須是「聊天室ID: 顯示名稱」的對應，不能留空。');
  const chatNames = new Map<string, string>();
  for (const [id, name] of Object.entries(chats)) {
    requireValue(CHAT_ID.test(id), `line.chats 的聊天室 ID 格式不正確：${id}`);
    requireValue(typeof name === 'string' && name.trim().length > 0, `line.chats.${id} 必須填入顯示名稱。`);
    chatNames.set(id, name.trim());
  }

  const { apiKey } = claude;
  const model = claude.model ?? DEFAULT_MODEL;
  const maxOutputTokens = claude.maxOutputTokens ?? 4096;
  const timeoutMs = claude.timeoutMs ?? 120_000;
  requireValue(typeof apiKey === 'string' && /^[\x21-\x7e]+$/.test(apiKey), '請填入 claude.apiKey。');
  requireValue(typeof model === 'string' && model.trim().length > 0, 'claude.model 必須是非空字串（省略時為 claude-haiku-5-5）。');
  integer(maxOutputTokens, 256, 64_000, 'claude.maxOutputTokens');
  integer(timeoutMs, 1000, 600_000, 'claude.timeoutMs');

  const host = web.host ?? '127.0.0.1';
  const port = web.port ?? 6181;
  requireValue(typeof host === 'string' && host.trim().length > 0, 'web.host 必須是非空字串。');
  integer(port, 1, 65_535, 'web.port');

  const timezone = raw.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  requireValue(typeof timezone === 'string', 'timezone 必須是 IANA 時區名稱，例如 Asia/Taipei。');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
  catch { throw new ConfigError('timezone 必須是 IANA 時區名稱，例如 Asia/Taipei。'); }

  return {
    line: { url: lineUrl, token, chats: chatNames },
    claude: { apiKey, model: model.trim(), maxOutputTokens, timeoutMs },
    web: { host, port },
    timezone,
    database: resolve(baseDir, 'chatlog.db'),
  };
}
