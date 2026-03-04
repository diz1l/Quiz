# TG Quiz Bot (@quizforlearn_bot)

Minimal Telegram quiz bot with WebApp UI.

- Bot: `@quizforlearn_bot`
- AI provider: Groq API (`llama-3.3-70b-versatile`)
- Hosting: Render

## Run locally

1. Install dependencies:

```sh
npm install
```

2. Create `.env` and set:

```env
BOT_TOKEN=...
GROQ_API_KEY=...
WEBAPP_URL=https://your-service.onrender.com
PORT=3000
```

3. Start:

```sh
npm start
```

## Deploy on Render

- Build command: `npm install`
- Start command: `npm start`
- Add env vars in Render dashboard
