# TG Quiz Bot - @quizforlearn_bot

Telegram-бот на Node.js, который генерирует квизы через Gemini и показывает их в Telegram WebApp.

## Что внутри

- `bot/index.js` - Telegraf + Express сервер, логика диалога и генерации квизов
- `webapp/index.html` - одностраничный Telegram WebApp (HTML/CSS/JS в одном файле)
- `.env.example` - пример переменных окружения

## Быстрый старт

1. Установите зависимости:

```sh
npm install
```

2. Подготовьте `.env` (можно скопировать из `.env.example`) и заполните:

- `BOT_TOKEN`
- `GEMINI_API_KEY`
- `WEBAPP_URL` (публичный URL вашего Render сервиса)
- `PORT` (обычно `3000`)

3. Запуск:

```sh
npm start
```

Для разработки:

```sh
npm run dev
```

## Render деплой

- Build command: `npm install`
- Start command: `npm start`
- Переменные окружения добавьте в Dashboard Render

## Примечания

- Состояние пользователей хранится в памяти (`Map`) и очищается при рестарте процесса.
- Квизы для WebApp выдаются через токен (`/api/quiz/:token`) с ограниченным временем жизни.

https://console.groq.com/keys
https://dashboard.render.com/web
