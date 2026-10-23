// Webhook-обработчик для Яндекс.Диалогов (Алиса) с интеграцией Google Gemini
// Развёртывается на Vercel без внешних зависимостей.

const SYSTEM_INSTRUCTION = `
Ты — близкий и хороший друг пользователя, общаешься с ним голосом через колонку Яндекс.Алиса.
Пользователь живёт с родителями, поэтому общайся без мата и без токсичности.

Твой характер и стиль речи:
- Общайся легко, тепло, по-дружески, на "ты".
- НЕ обзывай и НЕ оскорбляй пользователя (никаких "придурок", "дурак" и т.п.). Общайся на равных, по-человечески, как со старым добрым приятелем.
- Никакого роботизированного официоза ("Здравствуйте", "Чем могу помочь?", "Я голосовой ассистент").
- Разговаривай естественно и непринуждённо: "Здорово", "Да ладно?", "Серьёзно?", "Короче", "Слушай", "Нормально всё, бро".
- Отвечай живо, интересно, с дружеским юмором и поддержкой.
- ВАЖНО: Твой ответ будут слушать УШАМИ через колонку! Поэтому пиши коротко и ёмко (1-2 живых предложения). Не катай длинные списки и простыни текста.
- Не используй markdown-разметку (никаких звёздочек **, решёток #, списков), пиши только чистый разговорный текст для озвучки.
`;

// Удаление markdown-символов, чтобы Алиса не читала звёздочки и решётки вслух
function cleanTextForSpeech(text) {
  if (!text) return "";
  return text
    .replace(/[*_#`~>\[\]\(\)]/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function handler(req, res) {
  // Проверка работоспособности через браузер
  if (req.method === "GET") {
    return res.status(200).json({
      status: "online",
      service: "Alice Gemini Friend Bot",
      model: "gemini-flash-lite-latest",
      time: new Date().toISOString()
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { request, session, state, version = "1.0" } = req.body || {};

    // 1. Приветствие при старте навыка
    if (session && session.new) {
      const greeting = "Здорово! Чего расскажешь, как дела?";
      return res.status(200).json({
        response: {
          text: greeting,
          tts: "Зд+орово! Чег+о расск+ажешь, как дел+а?",
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
          text: "Слушай, ключа Gemini нет в настройках Vercel. Добавь переменную GEMINI_API_KEY, и поболтаем!",
          end_session: false
        },
        version
      });
    }

    // 4. История диалога (до 6 последних реплик) для памяти
    const prevHistory = (state && state.session && state.session.history) || [];
    const contents = [];
    for (const h of prevHistory.slice(-6)) {
      contents.push({
        role: h.role === "user" ? "user" : "model",
        parts: [{ text: h.text }]
      });
    }
    contents.push({
      role: "user",
      parts: [{ text: userUtterance || "Здорово!" }]
    });

    // 5. Запрос к Google Gemini (модель gemini-flash-lite-latest — сверхбыстрая и без задержек)
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

    // Вежливый запасной ответ на случай сбоя сети
    if (!botReply) {
      botReply = "Слушай, что-то со связью моргнуло, повтори ещё разок!";
    }

    // 6. Обновляем память сессии
    const newHistory = [
      ...prevHistory.slice(-4),
      { role: "user", text: userUtterance },
      { role: "model", text: botReply }
    ];

    // 7. Отправляем ответ в Яндекс.Диалоги
    return res.status(200).json({
      response: {
        text: botReply,
        end_session: false
      },
      session_state: {
        history: newHistory
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
