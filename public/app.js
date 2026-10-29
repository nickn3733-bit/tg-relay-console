/* Telegram Relay Console — клієнська логіка (vanilla JS, без збірки) */
'use strict';

/* ---------------- спільні хелпери ---------------- */

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'relay_token';
const THEME_KEY = 'relay_theme';

const state = {
  lastSeq: 0,
  config: null,
  lastSent: 0,
  replyTo: null,
  pollTimer: null,
};

let authToken = localStorage.getItem(TOKEN_KEY) || null;

function setToken(tok) {
  authToken = tok;
  if (tok) localStorage.setItem(TOKEN_KEY, tok);
  else localStorage.removeItem(TOKEN_KEY);
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth && authToken) headers['x-auth-token'] = authToken;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { data = { error: 'Некоректна відповідь сервера' }; }
  if (res.status === 401 && auth) { setToken(null); showGate(); throw new Error('Сесія завершилась — увійдіть знову'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(text, kind = '') {
  const host = $('toast-host');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function fmtTime(unix) {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const sameDay = new Date().toDateString() === d.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hh}:${mm}`;
}

function authorName(from) {
  if (!from) return 'Невідомий';
  if (from.username) return '@' + from.username;
  return [from.firstName, from.lastName].filter(Boolean).join(' ') || 'Невідомий';
}

/* ---------------- екрани ---------------- */

function showGate(needsSetup = false) {
  stopPolling();
  $('view-main').classList.add('hidden');
  $('view-gate').classList.remove('hidden');
  $('gate-error').classList.add('hidden');
  $('gate-password').value = '';
  $('gate-submit').textContent = needsSetup ? 'Створити доступ' : 'Увійти';
  $('gate-sub').textContent = needsSetup
    ? 'Перший запуск: придумайте майстер-пароль — він захистить сайт від сторонніх'
    : 'Уведіть майстер-пароль, щоб відкрити веб-чат вашої Telegram-групи';
  setTimeout(() => $('gate-password').focus(), 50);
  $('gate-password').dataset.needsSetup = needsSetup ? '1' : '';
}

function showMain() {
  $('view-gate').classList.add('hidden');
  $('view-main').classList.remove('hidden');
  startPolling();
}

/* ---------------- Password Gate ---------------- */

$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('gate-submit');
  const password = $('gate-password').value;
  if (!password) return;
  const needsSetup = $('gate-password').dataset.needsSetup === '1';
  btn.disabled = true;
  try {
    const data = await api(needsSetup ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST', auth: false, body: { password },
    });
    setToken(data.token);
    state.config = data.config;
    applyConfig(data.config);
    showMain();
    toast('Вхід виконано', 'ok');
  } catch (err) {
    const box = $('gate-error');
    box.textContent = err.message;
    box.classList.remove('hidden');
    if (String(err.message).includes('уже встановлено')) showGate(false);
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- вихід із сесії ---------------- */

$('btn-logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  setToken(null);
  showGate();
});

/* ---------------- верхня панель / конфігурація ---------------- */

function applyConfig(cfg) {
  state.config = cfg;
  $('bot-name').textContent = cfg.bot ? `${cfg.bot.firstName}${cfg.bot.username ? ' · @' + cfg.bot.username : ''}` : 'Бот не налаштований';
  $('group-name').textContent = cfg.groupTitle || (cfg.targetChatId ? `Chat ID: ${cfg.targetChatId}` : 'Група не обрана');
  $('stat-messages').textContent = `${cfg.status.messageCount} повідомлень`;
  markStatus(cfg.status.state, cfg.status.error);
  const ready = Boolean(cfg.bot && cfg.targetChatId != null);
  $('send-input').disabled = !ready;
  $('send-btn').disabled = !ready;
  $('send-input').placeholder = ready ? 'Напишіть повідомлення від імені бота…' : 'Спочатку налаштуйте бота у «⚙ Налаштуваннях»…';
}

function markStatus(st, err) {
  const dot = $('status-dot');
  dot.className = 'status-dot';
  dot.title = '';
  if (st === 'polling') { dot.classList.add('ok'); dot.title = 'Підключення активне (Long Polling)'; }
  else if (st === 'error') { dot.classList.add('err'); dot.title = err || 'Помилка підключення'; }
  else if (st === 'idle') { dot.classList.add('warn'); dot.title = 'Очікує налаштування бота'; }
}

function renderMessages(list) {
  const host = $('messages');
  const nearBottomStream = $('stream');
  const shouldStick = nearBottomStream.scrollHeight - nearBottomStream.scrollTop - nearBottomStream.clientHeight < 120;
  for (const m of list) {
    const div = document.createElement('div');
    div.className = 'msg' + (m.isOutgoing ? ' outgoing' : '');
    div.dataset.seq = m.seq;

    const head = document.createElement('div');
    head.className = 'head';
    const a = document.createElement('span');
    a.className = 'author';
    a.textContent = authorName(m.from);
    head.appendChild(a);
    if (m.from?.isBot) {
      const b = document.createElement('span');
      b.className = 'badge-bot';
      b.textContent = m.isOutgoing ? 'You / Bot' : 'Bot';
      head.appendChild(b);
    }
    const t = document.createElement('span');
    t.className = 'time';
    t.textContent = fmtTime(m.date);
    head.appendChild(t);
    div.appendChild(head);

    if (m.replyTo) {
      const q = document.createElement('div');
      q.className = 'reply-quote';
      q.textContent = `↩ ${m.replyTo.author}: ${m.replyTo.text || '(без тексту)'}`;
      div.appendChild(q);
      div.addEventListener('dblclick', () => {
        const target = [...host.children].find((n) => +n.dataset.id === m.replyTo.id);
        if (target) { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); target.style.transition = 'box-shadow .3s'; target.style.boxShadow = '0 0 0 2px var(--accent)'; setTimeout(() => (target.style.boxShadow = ''), 1200); }
      });
      div.title = 'Подвійний клік — перейти до повідомлення, на яке відповіли';
    }

    const bodyEl = document.createElement('div');
    bodyEl.className = 'body';
    bodyEl.textContent = m.text || '(без тексту)';
    div.appendChild(bodyEl);

    div.addEventListener('dblclick', () => {
      if (m.isOutgoing) return;
      state.replyTo = m;
      const inp = $('send-input');
      inp.value = inp.value ? inp.value : '';
      inp.placeholder = `Відповідь ${authorName(m.from)} ↩  (порожньо — звичайне повідомлення)`;
      inp.focus();
    });

    host.appendChild(div);
  }
  if (list.length && shouldStick) nearBottomStream.scrollTop = nearBottomStream.scrollHeight;
  const empty = $('stream-empty');
  if (state.config?.status.messageCount === 0 && host.childElementCount === 0) empty.classList.remove('hidden');
  else empty.classList.add('hidden');
}

/* ---------------- періодичне опитування нових повідомлень ---------------- */

async function pollMessages() {
  if (!authToken) return;
  try {
    const data = await api(`/api/messages?after=${state.lastSeq}`);
    if (data.seq > state.lastSeq) {
      renderMessages(data.messages);
      state.lastSeq = data.seq;
    }
    const cfg = await api('/api/state');
    applyConfig(cfg);
  } catch (err) {
    if (!String(err.message).includes('Сесія')) markStatus('error', err.message);
  }
}

function startPolling() {
  stopPolling();
  state.lastSeq = 0;
  $('messages').innerHTML = '';
  pollMessages();
  state.pollTimer = setInterval(pollMessages, 2500);
}
function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

/* ---------------- надсилання повідомлень ---------------- */

$('send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await sendMessage();
});

$('send-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

async function sendMessage() {
  const input = $('send-input');
  const text = input.value.trim();
  if (!text || Date.now() - state.lastSent < 600) return;
  const replyToMessageId = state.replyTo ? state.replyTo.id : undefined;
  state.lastSent = Date.now();
  const btn = $('send-btn');
  btn.disabled = true;
  try {
    const data = await api('/api/messages', { method: 'POST', body: { text, replyToMessageId } });
    input.value = '';
    input.style.height = 'auto';
    if (data.message.seq > state.lastSeq) {
      renderMessages([data.message]); // щоб не чекати 2.5 с — миттєво покажемо
    } else {
      renderMessages([]);
    }
    state.lastSeq = Math.max(state.lastSeq, data.message.seq);
    const sc = $('stream');
    sc.scrollTop = sc.scrollHeight;
    clearReply();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setTimeout(() => { btn.disabled = false; input.disabled = !state.config?.bot || state.config?.targetChatId == null; }, 500);
  }
}

function clearReply() {
  state.replyTo = null;
  $('send-input').placeholder = 'Напишіть повідомлення від імені бота…';
}

/* авто-зростання textarea */
$('send-input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
});

/* ---------------- налаштування підключення ---------------- */

$('btn-settings').addEventListener('click', () => {
  $('cfg-token').dataset.touched = '';
  $('cfg-chat').value = state.config?.targetChatId ?? '';
  openModal('dlg-settings');
});

$('btn-check-bot').addEventListener('click', async () => {
  await checkBot($('cfg-token').value.trim());
});

async function checkBot(token) {
  const box = $('bot-check-result');
  box.classList.remove('hidden', 'err');
  box.textContent = '… запит до Telegram (getMe)…';
  try {
    const data = await api('/api/bot/check', { method: 'POST', body: token ? { token } : {} });
    box.classList.remove('err');
    box.replaceChildren(`✅ Бот підключений: `, Object.assign(document.createElement('b'), {
      textContent: data.bot.firstName + (data.bot.username ? ` (@${data.bot.username})` : ''),
    }));
  } catch (err) {
    box.classList.add('err');
    box.textContent = '❌ ' + err.message;
  }
}

$('btn-detect').addEventListener('click', async () => {
  const box = $('detect-result');
  box.classList.remove('hidden');
  box.classList.remove('err');
  box.textContent = '… дивлюсь останні повідомлення в групах…';
  try {
    const data = await api('/api/bot/detect');
    if (!data.chats.length) {
      box.classList.add('err');
      box.textContent = '❌ Групу не знайдено. Напишіть будь-що в цільову групу та спробуйте ще раз (за 10–20 с).';
      return;
    }
    const chat = data.chats[0];
    $('cfg-chat').value = chat.id;
    box.replaceChildren(
      `✅ Знайдено групу: `,
      Object.assign(document.createElement('b'), { textContent: `${chat.title || '(без назва)'} — ${chat.id}` }),
    );
    if (data.chats.length > 1) {
      box.append(` (інші знайдені групи: ${data.chats.slice(1).map((c) => c.id).join(', ')} — якщо потрібно, впишіть ID вручну)`);
    }
  } catch (err) {
    box.classList.add('err');
    box.textContent = '❌ ' + err.message;
  }
});

$('btn-save-config').addEventListener('click', saveConfig);

async function saveConfig() {
  const token = $('cfg-token').value.trim();
  const chat = $('cfg-chat').value.trim();
  const msg = $('settings-msg');
  msg.classList.add('hidden');
  try {
    const body = {};
    if (token) body.botToken = token;
    if (chat !== '') body.targetChatId = chat;
    const data = await api('/api/config', { method: 'POST', body });
    state.config = data.config;
    applyConfig(data.config);
    toast('Підключення збережено', 'ok');
    closeModal('dlg-settings');
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.remove('hidden');
  }
}

$('btn-change-password').addEventListener('click', async () => {
  const current = $('pw-current').value;
  const next = $('pw-next').value;
  const msg = $('settings-msg');
  msg.classList.add('hidden');
  try {
    await api('/api/config/password', { method: 'POST', body: { current, next } });
    $('pw-current').value = '';
    $('pw-next').value = '';
    toast('Пароль змінено', 'ok');
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.remove('hidden');
  }
});

/* ---------------- тема ---------------- */

$('btn-theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = cur;
  localStorage.setItem(THEME_KEY, cur);
});
document.documentElement.dataset.theme = localStorage.getItem(THEME_KEY) || 'dark';

/* ---------------- модальні вікна ---------------- */

function openModal(id) { $(id).showModal(); }
function closeModal(id) { $(id).close(); }
$('btn-deploy').addEventListener('click', () => openModal('dlg-deploy'));
document.querySelectorAll('.modal-close').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));

/* ---------------- старт ---------------- */

(async function init() {
  try {
    const status = await api('/api/auth/status', { auth: false });
    if (authToken) {
      try {
        const cfg = await api('/api/state');
        state.config = cfg;
        applyConfig(cfg);
        showMain();
        return;
      } catch { setToken(null); }
    }
    showGate(status.needsSetup);
  } catch (err) {
    showGate(false);
    const box = $('gate-error');
    box.textContent = 'Сервер недоступний: ' + err.message;
    box.classList.remove('hidden');
  }
})();
