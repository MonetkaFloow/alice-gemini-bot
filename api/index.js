// Webhook-обработчик для Яндекс.Диалогов (Алиса) с интеграцией Google Gemini
// Развёртывается на Vercel без внешних зависимостей.

const SYSTEM_INSTRUCTION = `
Ты — близкий друг и верный кент пользователя, общаешься с ним голосом через колонку Яндекс.Алиса.
Пользователь живёт с родителями, поэтому не используй жёсткий грязный мат, но общайся свободно, без цензуры официоза.

Твой характер и стиль речи:
- Общайся как реальный пацан-кореш, на "ты".
- Никакого формализма, никаких "Здравствуйте, конечно же", "Чем я могу вам помочь?", "Я голосовой ассистент".
- Используй живые разговорные слова и подколки: "Здорово", "Да ладно тебе", "Придурок", "Балбес", "Ну ты выдал", "Короче", "Слушай сюда", "Базаришь".
- Если пользователь тупит — можешь по-доброму подколоть ("Ну ты и придурок конечно, ладно, слушай").
- Отвечай по делу, но с юмором, живо и саркастично.
- ВАЖНО: Твой ответ будут слушать УШАМИ через колонку! Поэтому пиши коротко и ёмко (1-3 живых предложения). Не катай длинные списки и простыни текста.
- Не используй markdown-разметку (никаких звёздочек **, решёток #, списков), пиши чистый текст для озвучки.
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
  // Разрешаем CORS и проверку работоспособности через браузер
  if (req.method === "GET") {
    return res.status(200).json({
      status: "online",
      service: "Alice Gemini Bro Bot",
      time: new Date().toISOString()
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { request, session, state, version = "1.0" } = req.body || {};

    // 1. Проверка первого входа в навык (пользователь только что активировал Алису)
    if (session && session.new) {
      const greeting = "Здорово, придурок! Чего звал? Давай рассказывай, что стряслось.";
      return res.status(200).json({
        response: {
          text: greeting,
          tts: "Зд+орово, прид+урок! Чего зв+ал? Дав+ай расск+азывай, что стрясл+ось.",
          end_session: false
        },
        session_state: {
          history: []
        },
        version
      });
    }

    const userUtterance = (request && (request.command || request.original_utterance || "")).trim();

    // 2. Проверка команды выхода
    const exitWords = ["пока", "хватит", "стоп", "выход", "отключись", "отмена", "закройся"];
    if (exitWords.includes(userUtterance.toLowerCase())) {
      return res.status(200).json({
        response: {
          text: "Давай, бывай, если что — зови!",
          tts: "Дав+ай, быв+ай, +если что — зов+и!",
          end_session: true
        },
        version
      });
    }

    // 3. Получение API ключа Gemini (из переменных Vercel)
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return res.status(200).json({
        response: {
          text: "Слушай, ключа Gemini нет. Добавь GEMINI_API_KEY в настройках Vercel, и поболтаем!",
          end_session: false
        },
        version
      });
    }

    // 4. Восстановление истории диалога (до 6 последних реплик) для памяти контекста
    const prevHistory = (state && state.session && state.session.history) || [];
    
    // Формируем историю для Gemini
    const contents = [];
    for (const h of prevHistory.slice(-6)) {
      contents.push({
        role: h.role === "user" ? "user" : "model",
        parts: [{ text: h.text }]
      });
    }
    // Добавляем текущую реплику пользователя
    contents.push({
      role: "user",
      parts: [{ text: userUtterance || "Здорово!" }]
    });

    // 5. Запрос к Google Gemini 3.8 Flash с таймаутом для Яндекс.Диалогов (макс 2.3 сек)
    let botReply = "";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2300);

    try {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${geminiApiKey}`;
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
            temperature: 0.9,
            maxOutputTokens: 150
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
      botReply = "Чё-то я залип на секунду, повтори ещё раз, придурок!";
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
        text: "Слушай, что-то пошло не так, но я всё ещё тут. Давай ещё раз.",
        end_session: false
      },
      version: "1.0"
    });
  }
}
