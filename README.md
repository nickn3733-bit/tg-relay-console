# Telegram Group Bot Relay & Web Console

Автономний веб-сервер (Node.js + Express, одна залежність), який можна розвернути на будь-якому сервері (VPS або домашній ПК) з публічною IP-адресою. Відкриваєте `http://YOUR_SERVER_IP:3000` у браузері, вводите майстер-пароль — і читаєте всі повідомлення вибраної Telegram-групи та пишете у групу від імені бота в реальному часі.

## Як це працює

1. Створіть бота в **@BotFather** → отримаєте токен виду `123456789:AAE...`.
2. Додайте бота у вашу групу (можна без адмін-прав — достатньо бачити повідомлення; в Consumer/Privacy-групах треба вимкнути *Group Privacy* в @BotFather або дати адмін-права).
3. Напишіть будь-що у групу → на сайті натисніть **⚙ Налаштування → "Виявити групу"** — сервер сам знайде `Chat ID`.
4. Готово: сервер у фоні через **Long Polling** (`getUpdates`) забирає повідомлення групи і показує їх у веб-чаті. Те, що ви пишете на сайті, відправляється в групу від імені бота (`sendMessage`).

Безпека: сайт захищений майстер-паролем (scrypt-хеш), усі API-запити вимагають заголовок `x-auth-token`, на вхід діє обмеження спроб.

## Локальний запуск (Windows / Linux / macOS)

```bash
npm install
npm start          # http://localhost:3000
```

Порт і папка даних керуються змінними середовища: `PORT` (за замовчуванням 3000), `DATA_DIR`.

## Розгортання на Ubuntu/Debian VPS

### Варіант 1 — Docker Compose (найпростіше)

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2
git clone <ваш-репозиторій> tg-relay-console
cd tg-relay-console
docker compose up -d
docker compose logs -f
```

### Варіант 2 — systemd (звичайний запуск)

```bash
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

sudo mv tg-relay-console /opt/
cd /opt/tg-relay-console
npm install --omit=dev

sudo cp deploy/tg-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tg-relay
sudo journalctl -u tg-relay -f
```

### Відкриття портів

```bash
sudo ufw allow 3000/tcp
```

- **VPS**: окрім `ufw`, відкрийте порт 3000 у панелі хостера (Security Group).
- **Домашній ПК**: налаштуйте Port Forwarding порт 3000 → ваш ПК на роутері.

Адреса доступу: `http://ВАШ_SERVER_IP:3000`.

### Бонус: безкоштовний HTTPS через Caddy

```bash
sudo apt-get install -y caddy
echo 'tg.example.com {
    reverse_proxy localhost:3000
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

#Структура

```
server.js        — Express API + фоновий Long Polling рушій Telegram
public/          — веб-консоль (vanilla JS, без збірки)
  index.html
  app.js
  styles.css
deploy/
  tg-relay.service — systemd unit для автозапуску
data/storage.json — створюється на льоту: конфігурація + останні 500 повідомлень
```
