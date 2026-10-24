const STRIP_DAYS = 30;
const ACCENTS = 6;
const SPEAKER_COLORS = 8;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const datesNav = document.getElementById('dates');
const content = document.getElementById('content');
const chatName = document.getElementById('chat-name');

/** Chat metadata `{ chatId, name, today, days: Set }`, refreshed on every navigation so "today" rolls over. */
let chat;
/** Bumped on every navigation so late responses for an old URL are dropped. */
let generation = 0;

const compact = iso => iso.replaceAll('-', '');
const expand = digits => `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
const monthDay = iso => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const weekday = iso => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function notice(emoji, text) {
  const box = element('div', 'notice');
  box.append(element('div', 'notice-emoji', emoji), element('p', undefined, text));
  return box;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

function renderDates(selected) {
  const first = selected < addDays(chat.today, 1 - STRIP_DAYS) ? selected : addDays(chat.today, 1 - STRIP_DAYS);
  const links = [];
  // Today is always the last cell.
  for (let day = first; day <= chat.today; day = addDays(day, 1)) {
    const link = element('a', 'date');
    link.href = `/${chat.chatId}/${compact(day)}`;
    link.dataset.route = '';
    if (chat.days.has(day)) link.classList.add('has-topics');
    if (day === chat.today) link.classList.add('today');
    if (day === selected) {
      link.classList.add('selected');
      link.setAttribute('aria-current', 'date');
    }
    link.append(
      element('span', 'day', monthDay(day)),
      element('span', 'weekday', day === chat.today ? '今天' : `週${weekday(day)}`),
    );
    links.push(link);
  }
  datesNav.replaceChildren(...links);
  datesNav.querySelector('.selected')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function timeLabel(stamp, date) {
  const time = stamp.slice(11, 16);
  return stamp.slice(0, 10) === date ? time : `${monthDay(stamp)} ${time}`;
}

function speakerName(index) {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

function renderChat(container, messages, date) {
  if (messages.length === 0) {
    container.replaceChildren(element('p', 'chat-empty', '原始訊息已收回或不存在。'));
    return;
  }
  const rows = [];
  let previous;
  for (const message of messages) {
    const row = element('div', `chat-row speaker-${message.speaker % SPEAKER_COLORS}`);
    const continued = message.speaker === previous;
    if (continued) row.classList.add('continued');
    previous = message.speaker;
    const avatar = element('span', 'avatar', continued ? '' : speakerName(message.speaker));
    avatar.setAttribute('aria-label', `成員 ${speakerName(message.speaker)}`);
    const bubble = element('div', 'bubble');
    bubble.append(element('span', 'text', message.text), element('time', 'stamp', timeLabel(message.time, date)));
    row.append(avatar, bubble);
    rows.push(row);
  }
  container.replaceChildren(...rows);
}

function renderTopic(topic, index, date) {
  const article = element('article', `topic accent-${index % ACCENTS}`);
  article.style.setProperty('--delay', `${Math.min(index, 10) * 40}ms`);
  const header = element('header');
  const time = element('time', 'time-chip', `${timeLabel(topic.start, date)} – ${timeLabel(topic.end, date)}`);
  time.dateTime = topic.start.replace(' ', 'T');
  header.append(element('h3', undefined, topic.title), time);
  const list = element('ul', 'points');
  for (const point of topic.points) list.append(element('li', undefined, point));
  article.append(header, list);

  if (topic.messageCount > 0) {
    const details = element('details', 'chat');
    const summary = element('summary');
    summary.append(element('span', 'chat-label', '原始對話'), element('span', 'chat-count', `${topic.messageCount} 則`));
    const body = element('div', 'chat-body');
    body.append(element('p', 'chat-empty', '載入中…'));
    details.append(summary, body);
    let loaded = false;
    details.addEventListener('toggle', async () => {
      if (!details.open || loaded) return;
      loaded = true;
      try {
        const result = await getJson(`/api/chats/${encodeURIComponent(chat.chatId)}/topics/${topic.id}`);
        renderChat(body, result?.messages ?? [], date);
      } catch {
        loaded = false;
        body.replaceChildren(element('p', 'chat-empty', '載入失敗，收合後再試一次。'));
      }
    });
    article.append(details);
  }
  return article;
}

function renderDay(date, topics) {
  const nodes = [];
  const hours = new Set(topics.map(topic => topic.hour));
  const heading = element('section', 'day-heading');
  heading.append(
    element('h1', undefined, `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`),
    element('p', undefined, `星期${weekday(date)}${date === chat.today ? '・今天' : ''}`
      + (topics.length ? `・${topics.length} 個話題・${hours.size} 個時段` : '')),
  );
  nodes.push(heading);

  if (topics.length === 0) {
    nodes.push(notice('🐈', date === chat.today ? '今天還沒有摘要，整點過後再來看看。' : '這天很安靜，沒有摘要。'));
  } else {
    const timeline = element('div', 'timeline');
    let group;
    let hour;
    topics.forEach((topic, index) => {
      if (topic.hour !== hour) {
        hour = topic.hour;
        group = element('section', 'hour');
        group.append(element('h2', 'hour-label', `${hour}:00`));
        timeline.append(group);
      }
      group.append(renderTopic(topic, index, date));
    });
    nodes.push(timeline);
  }
  if (date === chat.today) nodes.push(element('p', 'hint', '每小時整點後摘要上一個小時的對話。'));
  content.replaceChildren(...nodes);
}

async function route() {
  const current = ++generation;
  const [chatId, digits, ...rest] = location.pathname.split('/').filter(Boolean);
  if (!chatId || rest.length > 0) {
    chat = undefined;
    datesNav.replaceChildren();
    content.replaceChildren(notice('🔎', '請使用 /{聊天室ID}/{年月日} 開啟摘要。'));
    return;
  }
  try {
    if (chat?.chatId !== chatId) {
      chatName.textContent = '';
      chat = undefined;
      datesNav.replaceChildren();
      content.replaceChildren(notice('⏳', '載入中…'));
    }
    const meta = await getJson(`/api/chats/${encodeURIComponent(chatId)}`);
    if (current !== generation) return;
    if (!meta) {
      chat = undefined;
      datesNav.replaceChildren();
      content.replaceChildren(notice('🙀', '找不到這個聊天室。'));
      return;
    }
    chat = { chatId, name: meta.name, today: meta.today, days: new Set(meta.days) };
    chatName.textContent = chat.name;
    if (!digits) {
      history.replaceState(null, '', `/${chatId}/${compact(chat.today)}`);
      return route();
    }
    const date = /^\d{8}$/.test(digits) ? expand(digits) : '';
    renderDates(date && date <= chat.today ? date : chat.today);
    document.title = date ? `${chat.name} · ${date} · NekoBrief` : `${chat.name} · NekoBrief`;
    const day = date && await getJson(`/api/chats/${encodeURIComponent(chatId)}/days/${digits}`);
    if (current !== generation) return;
    if (!day) {
      content.replaceChildren(notice('📅', '日期格式應為年月日，例如 20261024。'));
      return;
    }
    renderDay(day.date, day.topics);
  } catch {
    if (current === generation) content.replaceChildren(notice('😿', '載入失敗，請稍後再試。'));
  }
}

document.addEventListener('click', event => {
  const link = event.target instanceof Element ? event.target.closest('a[data-route]') : null;
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (link.pathname !== location.pathname) history.pushState(null, '', link.pathname);
  void route();
});
addEventListener('popstate', () => void route());
void route();
