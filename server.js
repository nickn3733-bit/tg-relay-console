/**
 * Telegram Group Bot Relay & Web Console
 * Node.js + Express сервер, який:
 *  - хостить веб-консоль (папка public) захищену майстер-паролем;
 *  - у фоні через Long Polling опитує Telegram Bot API (getUpdates),
 *    фільтрує повідомлення цільової групи та зберігає історію у data/storage.json;
 *  - дозволяє надсилати повідомлення в групу від імені бота (sendMessage).
 *
 * Залежність лише одна — express. Telegram API викликається чистим fetch.
 */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const STORAGE_FILE = path.join(DATA_DIR, 'storage.json');
const TAG = 'data/storage.json';

const PORT = Number(process.env.PORT || 3000);
const MESSAGES_LIMIT = 500;        // скільки останніх повідомлень зберігаємо
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 діб
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const TG_API_TIMEOUT = 65; // секунд (long polling 30 + запас)

/* ------------------------------------------------------------------ */
/* Сховище (Config Store + повідомлення)                               */
/* ------------------------------------------------------------------ */

const defaultStore = () => ({
  adminPasswordHash: null,   // "salt:hash" (scrypt)
  botToken: '',
  targetChatId: null,        // число або "-100..."
  botInfo: null,             // { id, firstName, username }
  groupTitle: '',
  messages: [],              // [{ seq, id, chatId, from, text, date, isOutgoing, replyTo }]
  seq: 0,
  sessions: [],              // [{ token, exp }]
  createdAt: Date.now(),
});

let store = defaultStore();
let saveTimer = null;
let saveDirty = false;

function loadStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const raw = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
    store = { ...defaultStore(), ...raw };
    const now = Date.now();
    store.sessions = (store.sessions || []).filter((s) => s.exp > now);
    if (!Array.isArray(store.messages)) store.messages = [];
    console.log(`[storage] ${TAG} завантажено: ${store.messages.length} повідомлень`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[storage] не вдалося прочитати', e.message);
    console.log(`[storage] створено нове сховище: ${TAG}`);
    flushSave();
  }
}

function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveDirty = false;
  const tmp = STORAGE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORAGE_FILE);
}

function scheduleSave() {
  saveDirty = true;
  if (!saveTimer) saveTimer = setTimeout(() => { try { flushSave(); } catch (e) { console.error('[storage] помилка запису:', e.message); } }, 1500);
}

process.on('SIGINT', () => { try { if (saveDirty) flushSave(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { if (saveDirty) flushSave(); } catch {} process.exit(0); });

/* ------------------------------------------------------------------ */
/* Robopomichna криптографія (пароль, сесії)                           */
/* ------------------------------------------------------------------ */

const scrypt = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${scrypt(password, salt)}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = scrypt(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

/* ------------------------------------------------------------------ */
/* Довгий опитувальний цикл (Long Polling Engine)                       */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tg(method, token, params = {}, { timeoutSec = TG_API_TIMEOUT } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({ ok: false, error_code: res.status, description: 'некоректна відповідь від Telegram' }));
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, error_code: 0, description: 'тайм-аут запиту до Telegram' };
    return { ok: false, error_code: 0, description: String(e?.cause?.message || e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

let pollerGen = 0;
const poller = {
  running: false,
  offset: 0,
  status: 'idle',   // idle | polling | error
  error: null,
  lastUpdateAt: null, // останній час, коли отримано updates
  rawBuffer: [],    // останні оновлення для "Виявити групу"
};

function startPoller() {
  pollerGen += 1;
  const gen = pollerGen;
  runLoop(gen).catch((e) => { console.error('[poller] критична помилка:', e); poller.status = 'error'; poller.error = String(e?.message || e); });
}

async function runLoop(gen) {
  poller.running = true;
  while (gen === pollerGen) {
    const token = store.botToken;
    if (!token) { poller.status = 'idle'; poller.error = null; break; }
    try {
      poller.status = 'polling';
      poller.error = null;
      const res = await tg('getUpdates', token, {
        timeout: 30,
        offset: poller.offset,
        allowed_updates: ['message', 'edited_message', 'channel_post'],
      });
      if (gen !== pollerGen) return; // токен/налаштування змінилися — перезапуск

      if (!res.ok) {
        if (res.error_code === 401 || res.error_code === 404) {
          poller.status = 'error';
          poller.error = 'Помилковий Bot Token (Telegram відповів ' + res.error_code + ')';
          await sleep(15000);
          continue;
        }
        if (res.error_code === 409) { await sleep(10000); continue; } // інший getUpdates конкурує
        if (res.error_code === 429) {
          const wait = (res.parameters?.retry_after || 5) * 1000;
          poller.error = `Ліміт запитів, пауза ${Math.round(wait / 1000)} с`;
          await sleep(wait);
          continue;
        }
        poller.status = 'error';
        poller.error = res.description || 'невідома помилка Telegram';
        await sleep(5000);
        continue;
      }
      for (const u of res.result) {
        poller.offset = u.update_id + 1;
        handleUpdate(u);
      }
      await sleep(50);
    } catch (e) {
      poller.status = 'error';
      poller.error = String(e?.message || e);
      await sleep(5000);
    }
  }
  poller.running = false;
}

function handleUpdate(update) {
  const msg = update.message || update.edited_message || update.channel_post;
  if (!msg || !msg.chat) return;

  // Буфер для автовизначення Chat ID (швидкий опис останніх чатів)
  poller.rawBuffer.push(update);
  if (poller.rawBuffer.length > 200) poller.rawBuffer.splice(0, poller.rawBuffer.length - 200);
  poller.lastUpdateAt = Date.now();

  if (store.targetChatId == null) return;
  const target = String(store.targetChatId);
  if (String(msg.chat.id) !== target) return;
  if (!store.groupTitle && msg.chat.title) { store.groupTitle = msg.chat.title; scheduleSave(); }

  const edited = Boolean(update.edited_message) || Boolean(update.edited_channel_post);
  const text = typeof msg.text === 'string' ? msg.text : (typeof msg.caption === 'string' ? msg.caption : '');
  const from = messageAuthor(msg.from || {});

  if (edited) {
    const existing = store.messages.find((m) => String(m.chatId) === target && m.id === msg.message_id);
    if (existing) { existing.text = text; scheduleSave(); }
    return;
  }

  const entry = {
    seq: ++store.seq,
    id: msg.message_id,
    chatId: msg.chat.id,
    from,
    text,
    date: msg.date || Math.floor(Date.now() / 1000),
    isOutgoing: Boolean(msg.from?.is_bot),
    replyTo: replySnapshot(msg.reply_to_message),
  };
  store.messages.push(entry);
  if (store.messages.length > MESSAGES_LIMIT) store.messages.splice(0, store.messages.length - MESSAGES_LIMIT);
  scheduleSave();
}

function messageAuthor(u) {
  return {
    id: u.id ?? null,
    firstName: u.first_name || '',
    lastName: u.last_name || '',
    username: u.username || '',
    isBot: Boolean(u.is_bot),
  };
}

function replySnapshot(r) {
  if (!r) return null;
  const a = messageAuthor(r.from || {});
  const author = a.username ? '@' + a.username : [a.firstName, a.lastName].filter(Boolean).join(' ') || 'Невідомий';
  return { id: r.message_id || null, author, text: String(r.text || r.caption || '').slice(0, 160) };
}

/* ------------------------------------------------------------------ */
/* Express API                                                         */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

const loginAttempts = new Map(); // ip -> { count, resetAt }
function rateLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + LOGIN_WINDOW_MS; }
  rec.count += 1;
  loginAttempts.set(ip, rec);
  return rec.count > LOGIN_MAX_ATTEMPTS;
}

const ipOf = (req) => (req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress || 'unknown');

function sessionToken() {
  return crypto.randomBytes(32).toString('hex');
}
function createSession() {
  const token = sessionToken();
  store.sessions.push({ token, exp: Date.now() + SESSION_TTL_MS });
  scheduleSave();
  return token;
}

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  const ok = token && store.sessions.some((s) => s.token === token && s.exp > Date.now());
  if (!ok) return res.status(401).json({ error: 'Потрібна авторизація' });
  next();
}

const publicConfig = () => ({
  bot: store.botInfo,
  groupTitle: store.groupTitle,
  targetChatId: store.targetChatId,
  status: {
    state: poller.status,
    error: poller.error,
    lastUpdateAt: poller.lastUpdateAt,
    messageCount: store.messages.length,
  },
});

/* ---- маршрути авторизації (публічні) ---- */

app.get('/api/auth/status', (req, res) => {
  res.json({ needsSetup: !store.adminPasswordHash });
});

app.post('/api/auth/setup', (req, res) => {
  if (store.adminPasswordHash) return res.status(400).json({ error: 'Майстер-пароль уже встановлено' });
  const password = String(req.body?.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Пароль має містити щонайменше 6 символів' });
  store.adminPasswordHash = hashPassword(password);
  const token = createSession();
  console.log('[auth] майстер-пароль налаштовано');
  res.json({ ok: true, token, config: publicConfig() });
});

app.post('/api/auth/login', (req, res) => {
  const ip = ipOf(req);
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Забагато спроб. Спробуйте через 15 хвилин.' });
  }
  const password = String(req.body?.password || '');
  if (store.adminPasswordHash && !verifyPassword(password, store.adminPasswordHash)) {
    console.warn(`[auth] невдала спроба входу з ${ip}`);
    return res.status(401).json({ error: 'Невірний пароль' });
  }
  if (!store.adminPasswordHash) {
    // перший вхід одночасно задає пароль
    if (password.length < 6) return res.status(400).json({ error: 'Задайте пароль (щонайменше 6 символів)' });
    store.adminPasswordHash = hashPassword(password);
  }
  const rec = loginAttempts.get(ip);
  if (rec) { rec.count = 0; loginAttempts.set(ip, rec); }
  const token = createSession();
  console.log(`[auth] успішний вхід з ${ip}`);
  res.json({ ok: true, token, config: publicConfig() });
});

/* ---- все, що нижче, захищено сесійним токеном ---- */

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/api/auth/')) return next();
  return requireAuth(req, res, next);
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  store.sessions = store.sessions.filter((s) => s.token !== token);
  flushSave();
  res.json({ ok: true });
});

app.post('/api/config/password', (req, res) => {
  const current = String(req.body?.current || '');
  const next = String(req.body?.next || '');
  if (!verifyPassword(current, store.adminPasswordHash)) return res.status(401).json({ error: 'Поточний пароль невірний' });
  if (next.length < 6) return res.status(400).json({ error: 'Новий пароль має містити щонайменше 6 символів' });
  store.adminPasswordHash = hashPassword(next);
  flushSave();
  res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
  res.json(publicConfig());
});

app.get('/api/messages', (req, res) => {
  const after = Number(req.query.after || 0);
  const list = after > 0 ? store.messages.filter((m) => m.seq > after) : store.messages.slice(-200);
  res.json({ messages: list, seq: store.seq });
});

function targetChatConfigured(res) {
  if (store.targetChatId == null || !store.botInfo) {
    res.status(400).json({ error: 'Спочатку налаштуйте Bot Token і Chat ID групи у "Налаштуваннях".' });
    return false;
  }
  return true;
}

app.post('/api/messages', async (req, res) => {
  if (!targetChatConfigured(res)) return;
  const text = String(req.body?.text || '').trim();
  const replyToMessageId = Number(req.body?.replyToMessageId || 0) || undefined;
  if (!text) return res.status(400).json({ error: 'Порожнє повідомлення' });
  if (text.length > 4096) return res.status(400).json({ error: 'Telegram обмежує повідомлення 4096 символами' });

  const token = store.botToken;
  const params = { chat_id: store.targetChatId, text };
  if (replyToMessageId) params.reply_to_message_id = replyToMessageId;
  const result = await tg('sendMessage', token, params, { timeoutSec: 30 });
  if (!result.ok) {
    const err = result.description || 'Telegram відмовив у надсиланні';
    console.warn('[send] помилка sendMessage:', err);
    return res.status(502).json({ error: err });
  }
  const sent = result.result;
  const reply = replyToMessageId
    ? replySnapshot(store.messages.find((m) => String(m.chatId) === String(store.targetChatId) && m.id === replyToMessageId))
    : null;
  const entry = {
    seq: ++store.seq,
    id: sent?.message_id ?? null,
    chatId: store.targetChatId,
    from: { id: store.botInfo?.id ?? null, firstName: store.botInfo?.firstName || 'Bot', lastName: '', username: store.botInfo?.username || '', isBot: true },
    text,
    date: sent?.date || Math.floor(Date.now() / 1000),
    isOutgoing: true,
    replyTo: reply,
  };
  store.messages.push(entry);
  if (store.messages.length > MESSAGES_LIMIT) store.messages.splice(0, store.messages.length - MESSAGES_LIMIT);
  scheduleSave();
  res.json({ ok: true, message: entry });
});

app.post('/api/config', (req, res) => {
  const body = req.body || {};
  let changed = false;

  if (typeof body.botToken === 'string') {
    const token = body.botToken.trim();
    if (token && !/^\d+:[\w-]{10,}$/.test(token)) return res.status(400).json({ error: 'Токен виглядає некоректно. Формат: 123456789:AAE...' });
    if (token !== store.botToken) {
      store.botToken = token;
      store.botInfo = null;
      poller.offset = 0;
      poller.rawBuffer = [];
      poller.status = 'idle';
      changed = true;
    }
  }
  if (body.targetChatId !== undefined) {
    let chatId = body.targetChatId;
    if (typeof chatId === 'string') {
      chatId = chatId.trim();
      if (chatId.startsWith('https://t.me/')) {
        chatId = '@' + chatId.replace('https://t.me/', '');
      } else if (chatId !== '' && !/^@|^-\d+$|^\d+$/.test(chatId)) {
        return res.status(400).json({ error: 'Chat ID має виглядати як число або @username' });
      }
      if (chatId === '') chatId = null;
    }
    if (typeof chatId === 'number' || typeof chatId === 'string') {
      if (String(chatId) !== String(store.targetChatId)) {
        store.targetChatId = chatId;
        store.groupTitle = '';
        changed = true;
        // спробуємо отримати назву чату, якщо бот уже в групі
        if (store.botToken) {
          tg('getChat', store.botToken, { chat_id: chatId }, { timeoutSec: 20 })
            .then((r) => {
              if (r.ok && r.result?.title) { store.groupTitle = r.result.title; flushSave(); }
            })
            .catch(() => {});
        }
      }
    }
  }
  if (changed) {
    flushSave();
    startPoller();
  }
  res.json({ ok: true, config: publicConfig() });
});

app.post('/api/bot/check', async (req, res) => {
  const token = (typeof req.body?.token === 'string' && req.body.token.trim()) || store.botToken;
  if (!token) return res.status(400).json({ error: 'Введіть Bot Token' });
  const result = await tg('getMe', token, {}, { timeoutSec: 20 });
  if (!result.ok) return res.status(400).json({ error: result.description || 'Telegram не розпізнав токен' });
  const me = result.result;
  const info = {
    id: me.id,
    firstName: me.first_name,
    username: me.username || '',
    isBot: true,
  };
  if (token === store.botToken) {
    if (JSON.stringify(store.botInfo) !== JSON.stringify(info)) { store.botInfo = info; flushSave(); }
    if (poller.status !== 'polling') startPoller();
  }
  res.json({ ok: true, bot: info });
});

app.get('/api/bot/detect', async (req, res) => {
  if (!store.botToken) return res.status(400).json({ error: 'Спочатку збережіть Bot Token' });
  // свіжа спроба витягнути updates
  const result = await tg('getUpdates', store.botToken, { timeout: 3, offset: poller.offset }, { timeoutSec: 10 });
  if (result.ok && Array.isArray(result.result)) {
    for (const u of result.result) { poller.offset = u.update_id + 1; poller.rawBuffer.push(u); }
    poller.rawBuffer = poller.rawBuffer.slice(-200);
    poller.lastUpdateAt = Date.now();
    if (result.result.length && store.botToken && poller.status !== 'polling') { /* короткий fetch не ламає цикл */ }
  }
  const chats = [];
  for (const u of poller.rawBuffer) {
    const msg = u.message || u.edited_message || u.channel_post;
    if (!msg || !msg.chat) continue;
    if (msg.from?.is_bot) continue;
    if (!['group', 'supergroup'].includes(msg.chat.type)) continue;
    let c = chats.find((x) => String(x.id) === String(msg.chat.id));
    if (!c) { c = { id: msg.chat.id, title: msg.chat.title || '', type: msg.chat.type, lastDate: msg.date || 0 }; chats.push(c); }
    if ((msg.date || 0) > c.lastDate) c.lastDate = msg.date;
  }
  chats.sort((a, b) => b.lastDate - a.lastDate);
  res.json({ chats });
});

/* ---- статика ---- */

app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некоректний JSON' });
  console.error('[server]', err);
  res.status(500).json({ error: 'Внутрішня помилка сервера' });
});

/* ------------------------------------------------------------------ */
/* Старт                                                               */
/* ------------------------------------------------------------------ */

loadStore();
if (store.botToken) {
  console.log('[poller] зайдено з токеном — запускаю Long Polling');
  startPoller();
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Telegram Relay Web Console запущено:  http://0.0.0.0:${PORT}`);
  console.log(`   Сховище: ${STORAGE_FILE}`);
  if (!store.adminPasswordHash) console.log('   ⚠️  База пуста — відкрийте сайт і задайте майстер-пароль.\n');
});
