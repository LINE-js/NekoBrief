import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { ChatLog, ChatMessage } from './store.js';
import { localDateTime } from './time.js';

const PUBLIC = new URL('../../public/', import.meta.url);
const ASSETS: Record<string, { type: string; body: Buffer }> = {
  '/assets/app.js': { type: 'text/javascript; charset=utf-8', body: readFileSync(new URL('app.js', PUBLIC)) },
  '/assets/style.css': { type: 'text/css; charset=utf-8', body: readFileSync(new URL('style.css', PUBLIC)) },
  '/favicon.ico': { type: 'image/x-icon', body: readFileSync(new URL('favicon.ico', PUBLIC)) },
};
const INDEX = readFileSync(new URL('index.html', PUBLIC), 'utf8');
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, char => ESCAPES[char]!);
const HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:]+\](?::\d{1,5})?$/;

/** Link previews are built by crawlers that do not run the page's script, so the tags are written by the server. */
function metaTags(title: string, description: string, url: string | undefined): string {
  const tags = [
    ['og:type', 'website'], ['og:site_name', 'NekoBrief'], ['og:locale', 'zh_TW'],
    ['og:title', title], ['og:description', description],
  ];
  if (url) tags.push(['og:url', url]);
  return [
    `<meta name="description" content="${escapeHtml(description)}">`,
    ...tags.map(([property, content]) => `<meta property="${property}" content="${escapeHtml(content!)}">`),
    '<meta name="twitter:card" content="summary">',
  ].join('\n  ');
}

/** Front-end routes: `/`, `/{chatId}`, `/{chatId}/{YYYYMMDD}`. */
const PAGE = /^\/(?:([A-Za-z0-9]+)(?:\/(\d{8}))?\/?)?$/;
const API = /^\/api\/chats\/([A-Za-z0-9]+)(?:\/days\/(\d{8})|\/topics\/([1-9]\d{0,14}))?$/;
/** `/{chatId}/{YYYYMMDD}.json`: the day's summary with original chats as a JSON file. */
const EXPORT = /^\/([A-Za-z0-9]+)\/(\d{8})\.json$/;
const HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    + "img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  // Chat IDs are part of every URL; keep them out of other sites' logs.
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

function reply(response: ServerResponse, status: number, type: string, body: Buffer | string, head: boolean,
  cache = 'no-cache'): void {
  response.writeHead(status, {
    ...HEADERS, 'content-type': type, 'cache-control': cache,
    // JSON is public data: any site may read it, not only pages served from this origin.
    ...(type.startsWith('application/json') ? { 'access-control-allow-origin': '*' } : {}),
  });
  response.end(head ? undefined : body);
}

function json(response: ServerResponse, status: number, value: unknown, head: boolean): void {
  reply(response, status, 'application/json; charset=utf-8', JSON.stringify(value), head, 'no-store');
}

/** Whether `YYYYMMDD` names a real calendar date. */
function validDate(compact: string): boolean {
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(iso);
}

/** Sender IDs never leave the server: speakers become ordinals in order of appearance. */
function anonymousMessages(messages: ChatMessage[]): { time: string; speaker: number; text: string }[] {
  const speakers = new Map<string, number>();
  return messages.map(message => {
    let speaker = speakers.get(message.senderId);
    if (speaker === undefined) {
      speaker = speakers.size;
      speakers.set(message.senderId, speaker);
    }
    return { time: message.sentAt.slice(0, 16), speaker, text: message.text };
  });
}

export function createWebServer({ chats, log, timezone, now = Date.now }: {
  /** Chat ID → display name. */
  chats: Map<string, string>; log: ChatLog; timezone: string; now?: () => number;
}): Server {
  return createServer((request, response) => {
    const head = request.method === 'HEAD';
    if (request.method !== 'GET' && !head) {
      response.setHeader('allow', 'GET, HEAD');
      json(response, 405, { error: 'method_not_allowed' }, head);
      return;
    }
    let path: string;
    try {
      path = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      json(response, 400, { error: 'bad_request' }, head);
      return;
    }
    const asset = ASSETS[path];
    if (asset) {
      reply(response, 200, asset.type, asset.body, head);
      return;
    }
    if (path === '/api/chats') {
      const today = localDateTime(now(), timezone).slice(0, 10);
      json(response, 200, {
        today,
        chats: [...chats].map(([chatId, name]) => ({ chatId, name, todayTopics: log.topicsOn(chatId, today).length })),
      }, head);
      return;
    }
    const exported = EXPORT.exec(path);
    const api = exported ? undefined : API.exec(path);
    if (exported || api) {
      const [, chatId = '', compact, topicId] = exported ?? api!;
      const name = chats.get(chatId);
      // Only configured chats are served; others are indistinguishable from nonexistent IDs.
      if (name === undefined) {
        json(response, 404, { error: 'unknown_chat' }, head);
        return;
      }
      if (topicId !== undefined) {
        json(response, 200, { messages: anonymousMessages(log.topicMessages(chatId, Number(topicId))) }, head);
        return;
      }
      if (compact === undefined) {
        json(response, 200, {
          name, today: localDateTime(now(), timezone).slice(0, 10), days: log.days(chatId),
        }, head);
        return;
      }
      if (!validDate(compact)) {
        json(response, 404, { error: 'invalid_date' }, head);
        return;
      }
      const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
      const topics = log.topicsOn(chatId, date).map(topic => ({
        id: topic.id, hour: topic.hour.slice(11, 13), title: topic.title, points: topic.points,
        start: topic.startAt.slice(0, 16), end: topic.endAt.slice(0, 16), messageCount: topic.messageCount,
      }));
      if (exported) {
        // The whole day with original chats, pretty-printed as a file.
        response.setHeader('content-disposition', `inline; filename="${chatId}-${compact}.json"`);
        reply(response, 200, 'application/json; charset=utf-8', `${JSON.stringify({
          chat: name, date,
          topics: topics.map(({ id, messageCount: _count, ...topic }) => ({
            ...topic, messages: anonymousMessages(log.topicMessages(chatId, id)),
          })),
        }, null, 2)}\n`, head, 'no-store');
        return;
      }
      json(response, 200, { date, topics }, head);
      return;
    }
    const page = PAGE.exec(path);
    if (page) {
      const [, chatId, compact] = page;
      const host = request.headers.host;
      const proto = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const origin = host && HOST.test(host) ? `${proto}://${host}` : undefined;
      let title = 'NekoBrief';
      let description = '聊天室的每小時話題摘要。';
      const name = chatId === undefined ? undefined : chats.get(chatId);
      if (chatId !== undefined && name !== undefined) {
        const date = compact !== undefined && validDate(compact)
          ? `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
          : localDateTime(now(), timezone).slice(0, 10);
        const topics = log.topicsOn(chatId, date);
        title = `${name} · ${date} · NekoBrief`;
        description = topics.length === 0
          ? `${name} 在 ${date} 沒有摘要。`
          : `${name} 在 ${date} 的 ${topics.length} 個話題：${topics.slice(0, 5).map(topic => topic.title).join('、')}${topics.length > 5 ? '…' : ''}`;
      }
      const meta = metaTags(title, description, origin && `${origin}${path}`);
      reply(response, 200, 'text/html; charset=utf-8', INDEX.replace('<!--meta-->', () => meta), head);
      return;
    }
    json(response, 404, { error: 'not_found' }, head);
  });
}
