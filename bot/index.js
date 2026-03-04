const path = require('path');
const crypto = require('crypto');
const express = require('express');
const dotenv = require('dotenv');
const { Telegraf, Markup } = require('telegraf');
const Groq = require('groq-sdk');

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PORT = Number(process.env.PORT) || 3000;

if (!BOT_TOKEN || !GROQ_API_KEY || !WEBAPP_URL) {
  console.error('Missing required env vars. Required: BOT_TOKEN, GROQ_API_KEY, WEBAPP_URL');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

const groq = new Groq({ apiKey: GROQ_API_KEY });
const userState = new Map();
const quizTokenMap = new Map();
const resetNotifiedUsers = new Set();

const STEP = {
  IDLE: 'idle',
  WAITING_PROMPT: 'waiting_prompt',
  CONFIRM: 'confirm',
  IN_QUIZ: 'in_quiz'
};

function defaultState() {
  return {
    lastPrompt: '',
    quizData: null,
    step: STEP.IDLE,
    extraPrompt: ''
  };
}

function getOrCreateState(userId) {
  if (!userState.has(userId)) {
    userState.set(userId, defaultState());
  }
  return userState.get(userId);
}

function askForTopicButtons(state) {
  const rows = [];
  if (state.lastPrompt) {
    rows.push([Markup.button.callback(`Повторить: ${truncate(state.lastPrompt, 32)}`, 'reuse_last_prompt')]);
  }
  rows.push([Markup.button.callback('Отмена', 'cancel_flow')]);
  return Markup.inlineKeyboard(rows);
}

function startKeyboard() {
  return Markup.keyboard([['🎯 Начать квиз']]).resize();
}

function confirmPromptButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Добавить', 'add_more_prompt')],
    [Markup.button.callback('⚡ Сгенерировать', 'generate_quiz')],
    [Markup.button.callback('Отмена', 'cancel_flow')]
  ]);
}

function postQuizButtons() {
  return Markup.keyboard([['🆕 Новый квиз', '🔁 Повторить ошибки']]).resize();
}

function sanitizeQuiz(quiz, fallbackCount) {
  if (!quiz || typeof quiz !== 'object') {
    throw new Error('Quiz payload is not an object');
  }

  const title = typeof quiz.title === 'string' && quiz.title.trim() ? quiz.title.trim() : 'Новый квиз';
  const cards = Array.isArray(quiz.cards) ? quiz.cards : [];

  if (!cards.length) {
    throw new Error('Quiz has no cards');
  }

  const normalized = cards
    .slice(0, fallbackCount)
    .map((card, index) => {
      const question = typeof card.question === 'string' ? card.question.trim() : '';

      // Gemini sometimes returns options as a string block; normalize to 4 clean entries.
      const rawOptions = Array.isArray(card.options)
        ? card.options
        : typeof card.options === 'string'
          ? card.options.split(/\n|;|\|/g)
          : [];
      const options = rawOptions.map((opt) => String(opt).trim()).filter(Boolean).slice(0, 4);

      const rawCorrect = card.correct;
      let correct = Number(rawCorrect);
      if (!Number.isInteger(correct)) {
        const text = String(rawCorrect || '').trim().toUpperCase();
        if (['A', 'B', 'C', 'D'].includes(text)) {
          correct = ['A', 'B', 'C', 'D'].indexOf(text);
        }
      }
      if (Number.isInteger(correct) && correct >= 1 && correct <= 4) {
        correct -= 1;
      }

      const explanation = typeof card.explanation === 'string' ? card.explanation.trim() : '';
      const searchQuery = typeof card.searchQuery === 'string' ? card.searchQuery.trim() : question;

      if (!question || options.length !== 4 || !Number.isInteger(correct) || correct < 0 || correct > 3) {
        return null;
      }

      return {
        id: Number.isInteger(Number(card.id)) ? Number(card.id) : index + 1,
        question,
        options,
        correct,
        explanation: explanation || 'Объяснение недоступно.',
        searchQuery: searchQuery || question
      };
    })
    .filter(Boolean);

  if (!normalized.length) {
    throw new Error('All quiz cards are invalid');
  }

  return {
    title,
    cards: normalized
  };
}

function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function parseCardCount(prompt) {
  const match = String(prompt).match(/(\d{1,2})\s*(?:карточ|вопрос|questions?|cards?)/i);
  if (!match) return 20;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return 20;
  return Math.max(5, Math.min(parsed, 40));
}

function extractJson(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
    return cleaned;
  }

  // Scan for the first balanced JSON object that can be parsed.
  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{') continue;

    let depth = 0;
    for (let end = start; end < cleaned.length; end += 1) {
      const ch = cleaned[end];
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;

      if (depth === 0) {
        const candidate = cleaned.slice(start, end + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch (_error) {
          break;
        }
      }
    }
  }

  throw new Error('No JSON object found in model output');
}

function isGroqQuotaError(error) {
  if (!error) return false;

  if (Number(error.status) === 429) return true;

  const text = [error.message, error.statusText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (text.includes('quota exceeded') || text.includes('too many requests')) {
    return true;
  }

  const details = Array.isArray(error.errorDetails) ? error.errorDetails : [];
  return details.some((item) => {
    const serialized = JSON.stringify(item || {}).toLowerCase();
    return serialized.includes('quotafailure') || serialized.includes('quota exceeded');
  });
}

function extractRetryDelaySeconds(error) {
  const details = Array.isArray(error?.errorDetails) ? error.errorDetails : [];
  const retryInfo = details.find((item) => String(item?.['@type'] || '').includes('RetryInfo'));
  const retryDelay = retryInfo?.retryDelay;
  if (typeof retryDelay !== 'string') return null;

  const match = retryDelay.match(/(\d+)(?:\.\d+)?s/);
  if (!match) return null;
  return Number(match[1]);
}

async function generateQuizWithGroq(topicPrompt, extraPrompt) {
  const cardCount = parseCardCount(topicPrompt);
  const finalPrompt = [topicPrompt, extraPrompt].filter(Boolean).join('\nДополнительно: ');

  const baseInstruction = `Сгенерируй квиз и верни ТОЛЬКО валидный JSON-объект.\n\nПравила:\n1) Ответ начинается с { и заканчивается }\n2) Никакого markdown, никаких тройных обратных кавычек и никакого текста вне JSON\n3) Формат:\n{\n  "title": "Название квиза",\n  "cards": [\n    {\n      "id": 1,\n      "question": "Текст вопроса",\n      "options": ["Вариант A", "Вариант B", "Вариант C", "Вариант D"],\n      "correct": 0,\n      "explanation": "Краткое объяснение",\n      "searchQuery": "поисковый запрос"\n    }\n  ]\n}\n4) Язык: русский\n5) cards: ровно ${cardCount} вопросов\n6) options: ровно 4 строки\n7) correct: индекс правильного ответа 0..3\n8) Не добавляй лишних полей\n\nТема пользователя:\n${finalPrompt}`;

  async function runOnce() {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'Ты генерируешь квиз. Отвечай только валидным JSON-объектом без markdown и пояснений.'
        },
        { role: 'user', content: baseInstruction }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.5
    });

    const text = completion.choices?.[0]?.message?.content || '';
    console.log('[GROQ_RAW_RESPONSE]', text);
    const jsonText = extractJson(text);
    const parsed = JSON.parse(jsonText);
    return sanitizeQuiz(parsed, cardCount);
  }

  try {
    return await runOnce();
  } catch (firstError) {
    if (isGroqQuotaError(firstError)) {
      throw firstError;
    }

    console.warn('Groq parse failed, retrying once:', firstError.message);
    return runOnce();
  }
}

function createQuizToken(quiz) {
  const token = crypto.randomBytes(9).toString('base64url');
  quizTokenMap.set(token, {
    quiz,
    createdAt: Date.now()
  });
  return token;
}

function cleanupOldTokens() {
  const now = Date.now();
  const ttl = 1000 * 60 * 60;
  for (const [token, payload] of quizTokenMap.entries()) {
    if (now - payload.createdAt > ttl) {
      quizTokenMap.delete(token);
    }
  }
}

setInterval(cleanupOldTokens, 1000 * 60 * 10).unref();

async function sendWebAppLaunch(ctx, quiz) {
  const token = createQuizToken(quiz);
  const state = getOrCreateState(ctx.from.id);
  state.step = STEP.IN_QUIZ;
  state.quizData = quiz;

  const url = `${WEBAPP_URL.replace(/\/$/, '')}/?token=${encodeURIComponent(token)}`;
  await ctx.reply(`Готово! Открывай квиз: ${quiz.title}`, {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '🚀 Открыть WebApp',
            web_app: { url }
          }
        ]
      ]
    }
  });
}

async function askTopic(ctx) {
  const state = getOrCreateState(ctx.from.id);
  state.step = STEP.WAITING_PROMPT;
  state.extraPrompt = '';
  await ctx.reply('Опиши тему квиза 🧠', askForTopicButtons(state));
}

bot.start(async (ctx) => {
  const state = getOrCreateState(ctx.from.id);
  state.step = STEP.IDLE;
  await ctx.reply('Привет! Нажми кнопку ниже, чтобы начать.', startKeyboard());
});

bot.hears('🎯 Начать квиз', askTopic);
bot.hears('🆕 Новый квиз', askTopic);

bot.hears('🔁 Повторить ошибки', async (ctx) => {
  const state = getOrCreateState(ctx.from.id);
  if (!state.quizData || !Array.isArray(state.quizData.cards)) {
    await ctx.reply('Нет прошлого квиза в памяти. Создай новый квиз 🔄', startKeyboard());
    return;
  }

  const wrongCards = state.quizData.cards.filter((card) => card.__wrong === true);
  if (!wrongCards.length) {
    await ctx.reply('Ошибок нет. Отличный результат! Запусти новый квиз ✨', startKeyboard());
    return;
  }

  const retryQuiz = {
    title: `${state.quizData.title} (Ошибки)`,
    cards: wrongCards.map((card, idx) => ({
      id: idx + 1,
      question: card.question,
      options: card.options,
      correct: card.correct,
      explanation: card.explanation,
      searchQuery: card.searchQuery
    }))
  };

  await sendWebAppLaunch(ctx, retryQuiz);
});

bot.action('reuse_last_prompt', async (ctx) => {
  await ctx.answerCbQuery();
  const state = getOrCreateState(ctx.from.id);
  if (!state.lastPrompt) {
    await ctx.reply('Нет последней темы. Введи новую тему.');
    return;
  }

  state.step = STEP.CONFIRM;
  await ctx.reply(`Тема: ${state.lastPrompt}\nХорошо! Что-то добавить?`, confirmPromptButtons());
});

bot.action('cancel_flow', async (ctx) => {
  await ctx.answerCbQuery('Отменено');
  const state = getOrCreateState(ctx.from.id);
  state.step = STEP.IDLE;
  state.extraPrompt = '';
  await ctx.reply('Окей, возвращаемся в меню.', startKeyboard());
});

bot.action('add_more_prompt', async (ctx) => {
  await ctx.answerCbQuery();
  const state = getOrCreateState(ctx.from.id);
  state.step = STEP.CONFIRM;
  await ctx.reply('Напиши, что добавить к теме.');
});

bot.action('generate_quiz', async (ctx) => {
  await ctx.answerCbQuery('Генерирую...');
  const state = getOrCreateState(ctx.from.id);

  if (!state.lastPrompt) {
    await ctx.reply('Сначала задай тему квиза.');
    state.step = STEP.WAITING_PROMPT;
    return;
  }

  await ctx.reply('Генерирую квиз через Groq, это займет пару секунд...');

  try {
    const quiz = await generateQuizWithGroq(state.lastPrompt, state.extraPrompt);
    state.quizData = quiz;
    console.log(`[QUIZ] user=${ctx.from.id} title="${quiz.title}" cards=${quiz.cards.length}`);
    await sendWebAppLaunch(ctx, quiz);
  } catch (error) {
    console.error('Groq generation failed:', error);
    state.step = STEP.CONFIRM;

    if (isGroqQuotaError(error)) {
      const retrySeconds = extractRetryDelaySeconds(error);
      const retryPart = retrySeconds ? ` Попробуй снова через ~${retrySeconds} сек.` : ' Попробуй снова позже.';
      await ctx.reply(`Сейчас превышена квота Groq API.${retryPart}`);
      return;
    }

    await ctx.reply('Не удалось сгенерировать валидный квиз. Попробуй изменить тему и повторить.');
  }
});

bot.on('message', async (ctx, next) => {
  const userId = ctx.from.id;

  if (!userState.has(userId) && !ctx.message.text?.startsWith('/start')) {
    if (!resetNotifiedUsers.has(userId)) {
      resetNotifiedUsers.add(userId);
      await ctx.reply('Произошел сброс памяти сервера. Создай новый квиз 🔄', startKeyboard());
      return;
    }
  }

  return next();
});

bot.on('message', async (ctx) => {
  const state = getOrCreateState(ctx.from.id);

  if (ctx.message.web_app_data?.data) {
    try {
      const data = JSON.parse(ctx.message.web_app_data.data);
      if (data.type === 'quiz_result' && Array.isArray(data.wrongCards) && state.quizData) {
        const wrongIds = new Set(data.wrongCards.map((c) => Number(c.id)));
        state.quizData.cards = state.quizData.cards.map((card) => ({
          ...card,
          __wrong: wrongIds.has(Number(card.id))
        }));
        state.step = STEP.IDLE;
        await ctx.reply('Квиз завершен. Что дальше?', postQuizButtons());
        return;
      }

      if (data.type === 'new_quiz') {
        await askTopic(ctx);
        return;
      }

      if (data.type === 'retry_mistakes') {
        await ctx.reply('Нажми кнопку "🔁 Повторить ошибки" ниже.', postQuizButtons());
        return;
      }
    } catch (error) {
      console.warn('Invalid web_app_data payload:', error.message);
    }
  }

  const text = ctx.message.text;
  if (!text) {
    return;
  }

  if (state.step === STEP.WAITING_PROMPT) {
    state.lastPrompt = text.trim();
    state.step = STEP.CONFIRM;
    await ctx.reply('Хорошо! Что-то добавить?', confirmPromptButtons());
    return;
  }

  if (state.step === STEP.CONFIRM) {
    state.extraPrompt = state.extraPrompt
      ? `${state.extraPrompt}\n${text.trim()}`
      : text.trim();
    await ctx.reply('Добавил. Нажми "⚡ Сгенерировать", когда будешь готов.', confirmPromptButtons());
    return;
  }

  if (text === '/start') {
    return;
  }

  await ctx.reply('Используй кнопку "🎯 Начать квиз", чтобы продолжить.', startKeyboard());
});

bot.catch((error, ctx) => {
  console.error('Telegraf global error:', error);
  if (ctx) {
    ctx.reply('Произошла ошибка. Попробуй еще раз через пару секунд.').catch(() => {});
  }
});

app.use(express.static(path.join(__dirname, '../webapp')));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/api/quiz/:token', (req, res) => {
  const payload = quizTokenMap.get(req.params.token);
  if (!payload) {
    res.status(404).json({ error: 'Quiz not found or expired' });
    return;
  }

  res.json(payload.quiz);
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../webapp/index.html'));
});

app.listen(PORT, () => {
  console.log(`[SERVER] Express listening on ${PORT}`);
});

bot.launch().then(() => {
  console.log('[BOT] Bot started successfully');
});

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  process.exit(0);
});

