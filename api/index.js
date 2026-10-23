// Webhook-обработчик для Яндекс.Диалогов (Алиса) с интеграцией Google Gemini
// Развёртывается на Vercel без внешних зависимостей.

const SYSTEM_INSTRUCTION = `
Ты — близкий и хороший друг пользователя, общаешься с ним голосом через колонку Яндекс.Алиса.
Пользователь живёт с родителями, поэтому общайся без мата и без токсичности.

Твой характер и стиль речи:
- Общайся легко, тепло, по-дружески, на "ты".
- НЕ обзывай и НЕ оскорбляй пользователя. Общайся на равных, по-человечески, как со старым добрым приятелем.
- Никакого роботизированного официоза ("Здравствуйте", "Чем могу помочь?", "Я языковая модель").
- Разговаривай естественно: "Здорово", "Да ладно?", "Серьёзно?", "Короче", "Слушай", "О, ништяк", "Красава".
- ВАЖНО ПРО ПАМЯТЬ ДИАЛОГА:
  * Всегда помни, о чём вы только что говорили! Если вы обсуждали игру (например, Brawl Stars, персонажа Булла, CS2), ПРОДОЛЖАЙ ТЕМУ разговора, реагируй на его выбор и отвечай по контексту.
  * НИКОГДА не здоровайся заново в середине разговора ("Здорово!", "Чего как?") — вы уже общаетесь!
- ВАЖНО ДЛЯ ГОЛОСА: Твой ответ будут слушать УШАМИ через колонку! Поэтому отвечай кратко и живо (1-2 ёмких предложения).
- Не используй markdown-разметку (никаких звёздочек **, решёток #, списков), пиши только чистый разговорный текст для озвучки.
`;

// Кэш сессий прямо в оперативной памяти сервера (для мгновенной памяти между репликами)
const memoryCache = new Map();

// Очистка текста от markdown-символов
function cleanTextForSpeech(text) {
  if (!text) return "";
  return text
    .replace(/[*_#`~>\[\]\(\)]/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function handler(req, res) {
  // Проверка статуса в браузере
  if (req.method === "GET") {
    return res.status(200).json({
      status: "online",
      service: "Alice Gemini Friend Bot",
      active_sessions: memoryCache.size,
      time: new Date().toISOString()
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { request, session, state, version = "1.0" } = req.body || {};
    const sessionId = (session && session.session_id) || "default_session";

    // 1. Приветствие при старте сессии
    if (session && session.new) {
      memoryCache.delete(sessionId); // Сбрасываем старую память новой сессии
      const greeting = "Здорово! Чего расскажешь, во что поиграем или о чём поболтаем?";
      return res.status(200).json({
        response: {
          text: greeting,
          tts: "Зд+орово! Чег+о расск+ажешь, во что поигр+аем +или о чём поболт+аем?",
          end_session: false
        },
        session_state: {
          history: []
        },
        version
      });
    }

    const userUtterance = (request && (request.command || request.original_utterance || "")).trim();

    // 2. Команды выхода
    const exitWords = ["пока", "хватит", "стоп", "выход", "отключись", "отмена", "закройся", "до свидания"];
    if (exitWords.includes(userUtterance.toLowerCase())) {
      memoryCache.delete(sessionId);
      return res.status(200).json({
        response: {
          text: "Давай, на связи! Если что — зови.",
          tts: "Дав+ай, на св+язи! +Если что — зов+и.",
          end_session: true
        },
        version
      });
    }

    // 3. Получение API ключа Gemini
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return res.status(200).json({
        response: {
          text: "Слушай, ключа Gemini нет в настройках Vercel. Добавь переменную GEMINI_API_KEY!",
          end_session: false
        },
        version
      });
    }

    // 4. Восстановление истории диалога (проверяем и Яндекс state, и наш кэш в памяти)
    let history = [];
    if (state && state.session && Array.isArray(state.session.history) && state.session.history.length > 0) {
      history = state.session.history;
    } else if (memoryCache.has(sessionId)) {
      history = memoryCache.get(sessionId);
    }

    // Формируем строго чередующиеся реплики для Gemini: user -> model -> user -> model -> user
    const contents = [];
    let expectedRole = "user";
    for (const item of history.slice(-8)) {
      if (item && item.role === expectedRole && item.text) {
        contents.push({
          role: item.role,
          parts: [{ text: item.text }]
        });
        expectedRole = expectedRole === "user" ? "model" : "user";
      }
    }

    if (expectedRole === "model") {
      contents.push({
        role: "model",
        parts: [{ text: "Ага, понял." }]
      });
    }

    contents.push({
      role: "user",
      parts: [{ text: userUtterance || "Давай продолжим." }]
    });

    // 5. Запрос к Google Gemini Flash-Lite
    let botReply = "";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2300);

    try {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${geminiApiKey}`;
      const geminiResponse = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: SYSTEM_INSTRUCTION }]
          },
          contents: contents,
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 120
          }
        })
      });
      clearTimeout(timeoutId);

      if (geminiResponse.ok) {
        const geminiData = await geminiResponse.json();
        const candidate = geminiData.candidates && geminiData.candidates[0];
        const part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];
        if (part && part.text) {
          botReply = cleanTextForSpeech(part.text);
        }
      } else {
        const errText = await geminiResponse.text();
        console.error("Gemini API error:", errText);
      }
    } catch (err) {
      clearTimeout(timeoutId);
      console.error("Fetch/Timeout error:", err);
    }

    if (!botReply) {
      botReply = "Слушай, что-то со связью моргнуло, повтори ещё разок!";
    }

    // 6. Сохраняем обновлённую историю в память
    const updatedHistory = [
      ...history.slice(-6),
      { role: "user", text: userUtterance },
      { role: "model", text: botReply }
    ];

    // Сохраняем в память сервера
    memoryCache.set(sessionId, updatedHistory);
    if (memoryCache.size > 200) {
      const oldestKey = memoryCache.keys().next().value;
      memoryCache.delete(oldestKey);
    }

    // 7. Отправляем ответ в Яндекс.Диалоги
    return res.status(200).json({
      response: {
        text: botReply,
        end_session: false
      },
      session_state: {
        history: updatedHistory
      },
      version
    });

  } catch (error) {
    console.error("Handler error:", error);
    return res.status(200).json({
      response: {
        text: "Слушай, что-то подвисло. Давай ещё разок.",
        end_session: false
      },
      version: "1.0"
    });
  }
}
