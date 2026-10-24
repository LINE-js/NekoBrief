import { DatabaseSync, type StatementSync } from 'node:sqlite';

export interface LoggedMessage {
  /** 日期時間：設定時區的 `YYYY-MM-DD HH:MM:SS`。 */
  sentAt: string;
  chatId: string;
  senderId: string;
  text: string;
  messageId: string;
}

export interface PendingMessage {
  id: number;
  sentAt: string;
  senderId: string;
  text: string;
}

export interface ChatMessage {
  sentAt: string;
  senderId: string;
  text: string;
}

export interface Topic {
  id: number;
  /** Hour in which the topic started, `YYYY-MM-DD HH`. */
  hour: string;
  title: string;
  points: string[];
  startAt: string;
  endAt: string;
  messageCount: number;
}

export interface NewTopic {
  title: string;
  points: string[];
  startAt: string;
  endAt: string;
  /** Row IDs of the messages that make up the topic. */
  messageIds: number[];
}

export interface TopicUpdate {
  id: number;
  points: string[];
  endAt: string;
  /** Row IDs of the messages that continue the topic. */
  messageIds: number[];
}

/** One summarization run of a chat: the messages of one hour (or one slice of a busy hour). */
export interface SummaryBatch {
  /** Row IDs of every message the run consumed, including small talk that joined no topic. */
  messageIds: number[];
  /** Hour the messages were sent in, `YYYY-MM-DD HH`. */
  hour: string;
  /** Time of the first and last message in the run. */
  startAt: string;
  endAt: string;
  model: string;
  /** When the run finished, in the configured timezone. */
  summarizedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  sent_at    TEXT NOT NULL,
  chat_id    TEXT NOT NULL,
  sender_id  TEXT NOT NULL,
  text       TEXT NOT NULL,
  message_id TEXT NOT NULL,
  summary_id INTEGER,
  topic_id   INTEGER,
  UNIQUE (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS messages_pending ON messages (chat_id, summary_id, sent_at);
CREATE INDEX IF NOT EXISTS messages_by_topic ON messages (topic_id);
CREATE INDEX IF NOT EXISTS messages_by_summary ON messages (summary_id);
CREATE TABLE IF NOT EXISTS summaries (
  id            INTEGER PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  hour          TEXT NOT NULL,
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  model         TEXT NOT NULL,
  summarized_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS summaries_by_hour ON summaries (chat_id, hour);
CREATE TABLE IF NOT EXISTS topics (
  id       INTEGER PRIMARY KEY,
  chat_id  TEXT NOT NULL,
  hour     TEXT NOT NULL,
  title    TEXT NOT NULL,
  points   TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS topics_by_hour ON topics (chat_id, hour);
CREATE INDEX IF NOT EXISTS topics_by_end ON topics (chat_id, end_at);
`;

interface TopicRow {
  id: number;
  hour: string;
  title: string;
  points: string;
  start_at: string;
  end_at: string;
  message_count: number;
}

const TOPIC_COLUMNS = `id, hour, title, points, start_at, end_at,
  (SELECT count(*) FROM messages WHERE topic_id = topics.id) AS message_count`;

function toTopic(row: TopicRow): Topic {
  return {
    id: row.id, hour: row.hour, title: row.title, points: JSON.parse(row.points) as string[],
    startAt: row.start_at, endAt: row.end_at, messageCount: row.message_count,
  };
}

export class ChatLog {
  readonly db: DatabaseSync;
  readonly #insert: StatementSync;
  readonly #edit: StatementSync;
  readonly #remove: StatementSync;
  readonly #pending: StatementSync;
  readonly #active: StatementSync;
  readonly #updateTopic: StatementSync;
  readonly #insertTopic: StatementSync;
  readonly #insertSummary: StatementSync;
  readonly #linkSummary: StatementSync;
  readonly #assignTopic: StatementSync;
  readonly #days: StatementSync;
  readonly #topicsOn: StatementSync;
  readonly #topicMessages: StatementSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.#insert = this.db.prepare(`INSERT OR IGNORE INTO messages (sent_at, chat_id, sender_id, text, message_id)
      VALUES (?, ?, ?, ?, ?)`);
    this.#edit = this.db.prepare('UPDATE messages SET text = ? WHERE chat_id = ? AND message_id = ?');
    this.#remove = this.db.prepare('DELETE FROM messages WHERE chat_id = ? AND message_id = ?');
    this.#pending = this.db.prepare(`SELECT rowid AS id, sent_at AS sentAt, sender_id AS senderId, text FROM messages
      WHERE chat_id = ? AND summary_id IS NULL AND sent_at < ? ORDER BY sent_at, rowid LIMIT ?`);
    this.#active = this.db.prepare(`SELECT ${TOPIC_COLUMNS} FROM topics
      WHERE chat_id = ? AND end_at >= ? ORDER BY end_at DESC, id DESC LIMIT ?`);
    this.#updateTopic = this.db.prepare(`UPDATE topics SET points = ?, end_at = max(end_at, ?)
      WHERE id = ? AND chat_id = ?`);
    this.#insertTopic = this.db.prepare(`INSERT INTO topics (chat_id, hour, title, points, start_at, end_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    this.#insertSummary = this.db.prepare(`INSERT INTO summaries
      (chat_id, hour, start_at, end_at, message_count, model, summarized_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.#linkSummary = this.db.prepare('UPDATE messages SET summary_id = ? WHERE rowid = ? AND chat_id = ?');
    this.#assignTopic = this.db.prepare('UPDATE messages SET topic_id = ? WHERE rowid = ? AND chat_id = ?');
    this.#days = this.db.prepare(`SELECT DISTINCT substr(hour, 1, 10) AS day FROM topics
      WHERE chat_id = ? ORDER BY day`);
    this.#topicsOn = this.db.prepare(`SELECT ${TOPIC_COLUMNS} FROM topics
      WHERE chat_id = ? AND hour >= ? AND hour < ? ORDER BY start_at, id`);
    this.#topicMessages = this.db.prepare(`SELECT sent_at AS sentAt, sender_id AS senderId, text FROM messages
      WHERE topic_id = ? AND chat_id = ? ORDER BY sent_at, rowid`);
  }

  record(message: LoggedMessage): void {
    this.#insert.run(message.sentAt, message.chatId, message.senderId, message.text, message.messageId);
  }

  edit(chatId: string, messageId: string, text: string): void {
    this.#edit.run(text, chatId, messageId);
  }

  remove(chatId: string, messageId: string): void {
    this.#remove.run(chatId, messageId);
  }

  /** Oldest unsummarized messages sent strictly before `before`. */
  pending(chatId: string, before: string, limit: number): PendingMessage[] {
    return this.#pending.all(chatId, before, limit) as unknown as PendingMessage[];
  }

  /** Topics still active at or after `since`, newest first. */
  activeTopics(chatId: string, since: string, limit: number): Topic[] {
    return (this.#active.all(chatId, since, limit) as unknown as TopicRow[]).map(toTopic);
  }

  /** Atomically store one summarization run: its record, the topic changes and the summarized messages. */
  applySummary(chatId: string, batch: SummaryBatch, updates: TopicUpdate[], created: NewTopic[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const update of updates) {
        this.#updateTopic.run(JSON.stringify(update.points), update.endAt, update.id, chatId);
        for (const id of update.messageIds) this.#assignTopic.run(update.id, id, chatId);
      }
      for (const topic of created) {
        // A topic belongs to the hour in which it started, even if it runs past the boundary.
        const { lastInsertRowid } = this.#insertTopic.run(chatId, topic.startAt.slice(0, 13), topic.title,
          JSON.stringify(topic.points), topic.startAt, topic.endAt);
        for (const id of topic.messageIds) this.#assignTopic.run(lastInsertRowid, id, chatId);
      }
      const { lastInsertRowid: summaryId } = this.#insertSummary.run(chatId, batch.hour, batch.startAt,
        batch.endAt, batch.messageIds.length, batch.model, batch.summarizedAt);
      for (const id of batch.messageIds) this.#linkSummary.run(summaryId, id, chatId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Dates (`YYYY-MM-DD`) that have at least one topic. */
  days(chatId: string): string[] {
    return (this.#days.all(chatId) as unknown as { day: string }[]).map(row => row.day);
  }

  /** Topics that started on `date` (`YYYY-MM-DD`). */
  topicsOn(chatId: string, date: string): Topic[] {
    return (this.#topicsOn.all(chatId, `${date} 00`, `${date} 24`) as unknown as TopicRow[]).map(toTopic);
  }

  /** Original messages of one topic, oldest first; empty when the topic is not in `chatId`. */
  topicMessages(chatId: string, topicId: number): ChatMessage[] {
    return this.#topicMessages.all(topicId, chatId) as unknown as ChatMessage[];
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
