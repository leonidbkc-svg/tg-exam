import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TG_ID = process.env.ADMIN_TG_ID; // число строкой, например "215609496"
const APP_URL = process.env.APP_URL;         // "https://epid-test.ru"
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

if (!BOT_TOKEN || !ADMIN_TG_ID || !APP_URL) {
  console.error("❌ Не заданы BOT_TOKEN / ADMIN_TG_ID / APP_URL");
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

/**
 * In-memory сессии:
 * sid -> {
 *   sid, createdAt,
 *   tgUserId, tgChatId,
 *   fio,
 *   blurCount, hiddenCount,
 *   startedAt, finishedAt,
 *   score, total,
 *   events: [{type, payload, ts}]
 * }
 */
const sessions = new Map();

// --- Telegram helpers (без библиотек) ---
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method, payload) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok) {
    const msg = data?.description ? `Telegram error: ${data.description}` : "Telegram error";
    throw new Error(msg);
  }
  return data.result;
}

async function sendAdmin(text) {
  try {
    await tg("sendMessage", { chat_id: ADMIN_TG_ID, text });
  } catch (e) {
    console.error("sendAdmin failed:", e.message);
  }
}

function newSid() {
  return crypto.randomBytes(16).toString("hex");
}

function makeWebAppUrl(sid) {
  // мини-апп открывается по домену, sid передаём как query param
  return `${APP_URL}/?sid=${encodeURIComponent(sid)}`;
}

function buildStartKeyboard(sid) {
  return {
    inline_keyboard: [
      [{ text: "✅ Начать тест", web_app: { url: makeWebAppUrl(sid) } }],
      [{ text: "🔄 Новый сеанс", callback_data: "NEW_SESSION" }]
    ]
  };
}

// --- Simple long polling loop ---
let offset = 0;
let polling = false;

async function handleUpdate(update) {
  // messages
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = (msg.text || "").trim();

    if (text === "/start") {
      const sid = newSid();
      sessions.set(sid, {
        sid,
        createdAt: Date.now(),
        tgUserId: userId,
        tgChatId: chatId,
        fio: null,
        blurCount: 0,
        hiddenCount: 0,
        events: []
      });

      await tg("sendMessage", {
        chat_id: chatId,
        text:
          "Привет! Это тест по ИСМП.\n\n" +
          "Нажми кнопку ниже, введи ФИО и проходи тест.\n" +
          "⚠️ Сворачивания/переключения фиксируются.",
        reply_markup: buildStartKeyboard(sid)
      });
      return;
    }

    if (text === "/admin") {
      if (String(userId) !== String(ADMIN_TG_ID)) {
        await tg("sendMessage", { chat_id: chatId, text: "Нет доступа." });
        return;
      }
      const last = Array.from(sessions.values())
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 10);

      const lines = last.map((s) => {
        const fio = s.fio || "—";
        const score = (s.score != null) ? `${s.score}/${s.total ?? "?"}` : "—";
        return `• ${fio} | sid=${s.sid.slice(0, 6)}… | blur=${s.blurCount} hidden=${s.hiddenCount} | score=${score}`;
      });

      await tg("sendMessage", {
        chat_id: chatId,
        text: "Последние 10 сессий:\n" + (lines.length ? lines.join("\n") : "Пока пусто.")
      });
      return;
    }
  }

  // callback_query (кнопки)
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    const userId = cq.from?.id;
    const data = cq.data;

    if (!chatId) return;

    if (data === "NEW_SESSION") {
      const sid = newSid();
      sessions.set(sid, {
        sid,
        createdAt: Date.now(),
        tgUserId: userId,
        tgChatId: chatId,
        fio: null,
        blurCount: 0,
        hiddenCount: 0,
        events: []
      });

      await tg("answerCallbackQuery", { callback_query_id: cq.id });
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Ок, создал новый сеанс. Жми кнопку:",
        reply_markup: buildStartKeyboard(sid)
      });
    }
  }
}

async function pollLoop() {
  if (polling) return;
  polling = true;

  console.log("🤖 Bot polling started");

  while (true) {
    try {
      const res = await fetch(`${TG_API}/getUpdates?timeout=25&offset=${offset}`);
      const data = await res.json();
      if (!data.ok) {
        console.error("getUpdates error:", data.description);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      for (const upd of data.result) {
        offset = Math.max(offset, upd.update_id + 1);
        await handleUpdate(upd);
      }
    } catch (e) {
      console.error("pollLoop error:", e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// --- API for mini app ---
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/api/event", async (req, res) => {
  try {
    const { sid, type, payload, ts } = req.body || {};
    if (!sid || !type) return res.status(400).json({ ok: false, error: "bad_request" });

    const s = sessions.get(sid) || {
      sid,
      createdAt: Date.now(),
      fio: null,
      blurCount: 0,
      hiddenCount: 0,
      events: []
    };

    s.events.push({ type, payload: payload || {}, ts: ts || Date.now() });

    if (type === "start" && payload?.fio) {
      s.fio = String(payload.fio).trim().slice(0, 120);
      s.startedAt = Date.now();
    }

    if (type === "blur") s.blurCount = Number(payload?.blurCount ?? (s.blurCount + 1));
    if (type === "hidden") s.hiddenCount = Number(payload?.hiddenCount ?? (s.hiddenCount + 1));

    sessions.set(sid, s);

    // Уведомления админу: только на уходы + порог
    if (type === "blur" || type === "hidden") {
      const fio = s.fio || "ФИО не введено";
      const totalLeaves = (s.blurCount || 0) + (s.hiddenCount || 0);

      // пороги можно менять
      const warnAt = 2;   // начиная с 2 — предупреждать
      const stopAt = 4;   // начиная с 4 — жёстко пометить

      if (totalLeaves >= warnAt) {
        const status = totalLeaves >= stopAt ? "🚫 МНОГО УХОДОВ" : "⚠️ возможное списывание";
        await sendAdmin(
          `${status}\nФИО: ${fio}\nsid: ${sid}\nblur: ${s.blurCount}, hidden: ${s.hiddenCount}`
        );
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/submit", async (req, res) => {
  try {
    const { sid, fio, score, total } = req.body || {};
    if (!sid) return res.status(400).json({ ok: false });

    const s = sessions.get(sid) || { sid, createdAt: Date.now(), events: [], blurCount: 0, hiddenCount: 0 };
    if (fio) s.fio = String(fio).trim().slice(0, 120);
    s.score = Number(score ?? 0);
    s.total = Number(total ?? 0);
    s.finishedAt = Date.now();

    sessions.set(sid, s);

    const fioText = s.fio || "ФИО не введено";
    await sendAdmin(
      `✅ Тест завершён\nФИО: ${fioText}\nРезультат: ${s.score}/${s.total}\nblur: ${s.blurCount}, hidden: ${s.hiddenCount}\nsid: ${sid}`
    );

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server started on :${PORT}`);
  console.log(`APP_URL=${APP_URL}`);
  // запускаем polling
  pollLoop();
});
