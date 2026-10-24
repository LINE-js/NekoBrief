import WebSocket from 'ws';
import type { LineConfig } from './config.js';
import { isRecord } from './guards.js';
import type { ChatLog } from './store.js';
import { localDateTime } from './time.js';

const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 10_000;
const RECONNECT_DELAY = 10_000;

/** Records live messages of the configured chats from the LINE.js bot API (`/api/ws`). */
export class LineRecorder {
  readonly #config: LineConfig;
  readonly #log: ChatLog;
  readonly #timezone: string;
  readonly #print: (code: string) => void;
  readonly #allowed: Set<string>;
  #socket: WebSocket | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #heartbeatDeadline: NodeJS.Timeout | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #protocolReady = false;
  #stopped = false;
  #started = false;
  readonly closed: Promise<void>;
  readonly #resolveClosed: () => void;

  constructor({ config, log, timezone, print = () => {} }: {
    config: LineConfig; log: ChatLog; timezone: string; print?: (code: string) => void;
  }) {
    this.#config = config;
    this.#log = log;
    this.#timezone = timezone;
    this.#print = print;
    this.#allowed = new Set(config.chats.keys());
    const { promise, resolve } = Promise.withResolvers<void>();
    this.closed = promise;
    this.#resolveClosed = resolve;
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#connect();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#cleanup();
    this.#print('stopped');
    this.#resolveClosed();
  }

  #connect(): void {
    if (this.#stopped) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#config.url, {
        headers: { Authorization: `Bearer ${this.#config.token}` },
        maxPayload: 1024 * 1024,
        handshakeTimeout: 10_000,
      });
    } catch {
      this.#disconnect('connection_error');
      return;
    }
    this.#socket = socket;
    const current = () => !this.#stopped && this.#socket === socket;
    socket.on('open', () => {
      if (!current()) return;
      this.#print('connected');
      this.#heartbeat = setInterval(() => this.#ping(), HEARTBEAT_INTERVAL);
    });
    socket.on('message', data => {
      if (!current()) return;
      let event: unknown;
      try {
        event = JSON.parse(data.toString());
      } catch {
        this.#print('invalid_frame');
        return;
      }
      try {
        this.receive(event);
      } catch {
        this.#print('record_failed');
      }
    });
    socket.on('error', () => {
      if (current()) this.#disconnect('connection_error');
    });
    socket.on('close', () => {
      if (current()) this.#disconnect('disconnected');
    });
  }

  #disconnect(code: string): void {
    if (this.#stopped) return;
    this.#print(code);
    this.#cleanup();
    if (this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, RECONNECT_DELAY);
  }

  #cleanup(): void {
    clearInterval(this.#heartbeat);
    clearTimeout(this.#heartbeatDeadline);
    this.#heartbeat = undefined;
    this.#heartbeatDeadline = undefined;
    this.#protocolReady = false;
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  #send(event: { type: 'ping' | 'pong' }): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) throw new Error('disconnected');
    this.#socket.send(JSON.stringify(event));
  }

  #ping(): void {
    if (this.#stopped || this.#heartbeatDeadline) return;
    try {
      this.#send({ type: 'ping' });
      this.#heartbeatDeadline = setTimeout(() => this.#disconnect('heartbeat_timeout'), HEARTBEAT_TIMEOUT);
    } catch {
      this.#disconnect('connection_error');
    }
  }

  /** Handle one decoded `/api/ws` frame. */
  receive(event: unknown): void {
    if (this.#stopped || !isRecord(event)) return;
    switch (event.type) {
      case 'pong':
        clearTimeout(this.#heartbeatDeadline);
        this.#heartbeatDeadline = undefined;
        return;
      case 'ping':
        this.#send({ type: 'pong' });
        return;
      case 'hello':
        if (event.protocol !== 2) {
          this.#disconnect('unsupported_protocol');
          return;
        }
        this.#protocolReady = true;
        return;
      case 'auth:state':
        if (event.state !== 'ready') this.#print('authentication_not_ready');
        return;
      case 'auth:ready':
        this.#print('ready');
        return;
    }
    if (!this.#protocolReady) return;

    if (event.type === 'message:unsend') {
      if (typeof event.chatId === 'string' && this.#allowed.has(event.chatId) && typeof event.messageId === 'string') {
        this.#log.remove(event.chatId, event.messageId);
      }
      return;
    }
    if (event.type !== 'message' && event.type !== 'message:edit') return;
    const message = event.message;
    if (!isRecord(message) || typeof message.channelId !== 'string' || !this.#allowed.has(message.channelId) ||
        typeof message.messageId !== 'string' || !message.messageId) return;
    // Withdrawn content must not stay in the log or reach a later summary.
    if (message.unsent) {
      this.#log.remove(message.channelId, message.messageId);
      return;
    }
    // LINE.js normalizes text content type 0 to NONE; other types carry no summarizable text.
    if (message.contentType !== 'NONE' || typeof message.text !== 'string' || !message.text.trim() ||
        message.decryptFailed) return;
    if (event.type === 'message:edit') {
      this.#log.edit(message.channelId, message.messageId, message.text);
      return;
    }
    if (typeof message.senderId !== 'string' || !message.senderId) return;
    const createdAt = typeof message.createdAt === 'number' && Number.isFinite(message.createdAt)
      ? message.createdAt : Date.now();
    this.#log.record({
      sentAt: localDateTime(createdAt, this.#timezone),
      chatId: message.channelId,
      senderId: message.senderId,
      text: message.text,
      messageId: message.messageId,
    });
  }
}
