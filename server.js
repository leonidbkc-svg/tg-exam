import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import dns from "dns";

dns.setDefaultResultOrder("ipv4first");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TG_ID = process.env.ADMIN_TG_ID; // строкой
const APP_URL = process.env.APP_URL;         // "https://epid-test.ru"
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

/**
 * ✅ ФЛАГИ "НЕ ЛОМАТЬ СТАРОЕ"
 * - Если STRICT_SID=false → поведение как раньше: /api/event может создать сессию сам.
 * - Если STRICT_SID=true  → /api/event и /api/submit требуют существующий sid (экзаменационный режим).
 *
 * Рекомендую включить, но вы просили "старое не удалять" — поэтому это переключаемо.
 */
const STRICT_SID = String(process.env.STRICT_SID || "0") === "1";

/**
 * ✅ Валидация Telegram initData
 * - Если REQUIRE_TG_AUTH=false → всё работает как раньше, initData просто логируется.
 * - Если REQUIRE_TG_AUTH=true  → /api/event и /api/submit требуют валидный initData для "telegram-сессий".
 */
const REQUIRE_TG_AUTH = String(process.env.REQUIRE_TG_AUTH || "0") === "1";

/**
 * TTL для очистки сессий из памяти (чтобы Map не рос бесконечно)
 */
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 6 * 60 * 60 * 1000); // 6 часов
const CLEANUP_EVERY_MS = 10 * 60 * 1000; // 10 минут


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
 * sessions: Map<sid, session>
 * session:
 *  - sid
 *  - createdAt
 *  - tgUserId / tgChatId (если создано ботом)
 *  - fio
 *  - blurCount / hiddenCount / leaveCount
 *  - startedAt / finishedAt
 *  - boundUserId (если подтвержден initData)
 *  - events[]
 */
const sessions = new Map();

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

/**
 * ✅ Telegram initData verification (HMAC)
 * Док-логика:
 *  - parse querystring initData
 *  - extract "hash"
 *  - build data_check_string = sorted key=value excluding hash, joined with \n
 *  - secret_key = sha256(bot_token)
 *  - hmac = HMAC-SHA256(secret_key, data_check_string)
 *  - compare hex to hash
 */
function verifyTelegramInitData(initData, { maxAgeSec = 24 * 60 * 60 } = {}) {
  try {
    if (!initData || typeof initData !== "string") return { ok: false, error: "no_initData" };

    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { ok: false, error: "no_hash" };

    // collect key=value excluding hash
    const pairs = [];
    for (const [key, val] of params.entries()) {
      if (key === "hash") continue;
      pairs.push([key, val]);
    }
    pairs.sort((a, b) => a[0].localeCompare(b[0]));

    const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

    const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
    const hmac = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (hmac !== hash) return { ok: false, error: "bad_hash" };

    // auth_date freshness (optional)
    const authDate = Number(params.get("auth_date") || 0);
    if (authDate > 0) {
      const ageSec = Math.floor(Date.now() / 1000) - authDate;
      if (ageSec > maxAgeSec) return { ok: false, error: "auth_date_expired" };
    }

    // user parsing
    const userRaw = params.get("user");
    let user = null;
    if (userRaw) {
      try { user = JSON.parse(userRaw); } catch { user = null; }
    }

    return { ok: true, user, authDate };
  } catch (e) {
    return { ok: false, error: "verify_exception" };
  }
}

function getSessionOrFallbackCreate(sid) {
  // ✅ Новый экзаменационный режим: если STRICT_SID=1 → требуем существующий sid
  const existing = sessions.get(sid);
  if (existing) return { session: existing, created: false };

  // 🔙 СТАРОЕ ПОВЕДЕНИЕ (НЕ УДАЛЯЮ): авто-создание сессии
  if (!STRICT_SID) {
    const s = {
      sid,
      createdAt: Date.now(),
      fio: null,
      blurCount: 0,
      hiddenCount: 0,
      leaveCount: 0,
      events: []
    };
    sessions.set(sid, s);
    return { session: s, created: true };
  }

  return { session: null, created: false };
}

function isFinished(s) {
  return Boolean(s?.finishedAt);
}

let offset = 0;
let polling = false;

async function handleUpdate(update) {
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
        boundUserId: null, // ✅ сюда "прибьём" user.id из initData
        fio: null,
        blurCount: 0,
        hiddenCount: 0,
        leaveCount: 0,
        startedAt: null,
        finishedAt: null,
        score: null,
        total: null,
        events: []
      });

      await tg("sendMessage", {
        chat_id: chatId,
        text:
          "Привет! Это тест по ИСМП.\n\n" +
          "Нажми кнопку ниже, введи ФИО и проходи тест.\n" +
          "⚠️ Сворачивания/переключения фиксируются.\n" +
          "🚫 На 3-м уходе тест завершится автоматически.",
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
        const leaves = Number.isFinite(Number(s.leaveCount)) ? Number(s.leaveCount) : 0;
        const bound = s.boundUserId ? `bound=${s.boundUserId}` : "bound=—";
        return `• ${fio} | sid=${s.sid.slice(0, 6)}… | уходов=${leaves} (blur=${s.blurCount} hidden=${s.hiddenCount}) | score=${score} | ${bound}`;
      });

      await tg("sendMessage", {
        chat_id: chatId,
        text: "Последние 10 сессий:\n" + (lines.length ? lines.join("\n") : "Пока пусто.")
      });
      return;
    }
  }

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
        boundUserId: null,
        fio: null,
        blurCount: 0,
        hiddenCount: 0,
        leaveCount: 0,
        startedAt: null,
        finishedAt: null,
        score: null,
        total: null,
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

/**
 * ✅ cleanup old sessions (не влияет на рабочее поведение)
 */
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) {
    const base = s.finishedAt || s.createdAt || now;
    if (now - base > SESSION_TTL_MS) sessions.delete(sid);
  }
}, CLEANUP_EVERY_MS);


app.get("/health", (req, res) => res.json({
  ok: true,
  strictSid: STRICT_SID,
  requireTgAuth: REQUIRE_TG_AUTH
}));

/**
 * 🔙 СТАРОЕ (НЕ УДАЛЯЮ): создание сессии без бота
 * Для экзамена лучше не использовать, но оставляем как было.
 */
app.post("/api/new-session", (req, res) => {
  const sid = newSid();
  sessions.set(sid, {
    sid,
    createdAt: Date.now(),
    fio: null,
    blurCount: 0,
    hiddenCount: 0,
    leaveCount: 0,
    events: []
  });
  return res.json({ ok: true, sid });
});

app.post("/api/event", async (req, res) => {
  try {
    const { sid, type, payload, ts, initData } = req.body || {};
    if (!sid || !type) return res.status(400).json({ ok: false, error: "bad_request" });

    const { session: s, created } = getSessionOrFallbackCreate(sid);
    if (!s) {
      // ✅ экзаменационный режим: sid обязателен
      return res.status(404).json({ ok: false, error: "unknown_sid" });
    }

    // ✅ Если сессия ботом создана (есть tgUserId) — привязываем к initData user.id
    // 🔙 Если initData нет — не ломаем старое, но можем потребовать если REQUIRE_TG_AUTH=1
    if (s.tgUserId) {
      if (initData) {
        const vr = verifyTelegramInitData(initData);
        if (!vr.ok) {
          if (REQUIRE_TG_AUTH) {
            return res.status(401).json({ ok: false, error: "bad_initData", detail: vr.error });
          }
        } else {
          const uid = vr.user?.id;
          if (uid != null) {
            s.boundUserId = String(uid);
            if (String(uid) !== String(s.tgUserId)) {
              // чужой аккаунт открыл ссылку
              if (REQUIRE_TG_AUTH) {
                return res.status(403).json({ ok: false, error: "user_mismatch" });
              } else {
                // мягкий режим: просто уведомим админа
                await sendAdmin(
                  `⚠️ Возможная подмена пользователя\nsid: ${sid}\n` +
                  `ожидался tgUserId=${s.tgUserId}\nпришёл user.id=${uid}\n` +
                  `type=${type}`
                );
              }
            }
          }
        }
      } else if (REQUIRE_TG_AUTH) {
        return res.status(401).json({ ok: false, error: "initData_required" });
      }
    }

    const when = ts || Date.now();
    const p = payload || {};
    s.events = s.events || [];
    s.events.push({ type, payload: p, ts: when });

    if (type === "start" && p?.fio) {
      s.fio = String(p.fio).trim().slice(0, 120);
      s.startedAt = Date.now();
      sessions.set(sid, s);

      await sendAdmin(
        `✅ Регистрация/старт\nФИО: ${s.fio}\nsid: ${sid}\n` +
        (created ? "⚠️ sid был создан через fallback (не из бота)\n" : "") +
        (s.boundUserId ? `user.id: ${s.boundUserId}\n` : "")
      );
      return res.json({ ok: true });
    }

    // счетчики
    if (type === "blur") {
      const next = Number.isFinite(Number(p?.blurCount)) ? Number(p.blurCount) : (Number(s.blurCount || 0) + 1);
      s.blurCount = next;
    }

    if (type === "hidden") {
      const next = Number.isFinite(Number(p?.hiddenCount)) ? Number(p.hiddenCount) : (Number(s.hiddenCount || 0) + 1);
      s.hiddenCount = next;
    }

    // leaveCount только от клиента
    if (p?.leaveCount != null && Number.isFinite(Number(p.leaveCount))) {
      s.leaveCount = Number(p.leaveCount);
    }

    sessions.set(sid, s);

    // админу пишем ТОЛЬКО на hidden (как у вас)
    if (type === "hidden") {
      const fio = s.fio || "ФИО не введено";
      const leaves = Number(s.leaveCount || 0);
      const status = leaves >= 3 ? "🚫 3-й уход — авто-завершение" : "⚠️ уход из теста";

      await sendAdmin(
        `${status}\nФИО: ${fio}\nsid: ${sid}\nсобытие: hidden\n` +
        `уходов: ${leaves} (blur=${s.blurCount || 0}, hidden=${s.hiddenCount || 0})\n` +
        (s.boundUserId ? `user.id: ${s.boundUserId}` : "")
      );

      return res.json({ ok: true, shouldFinish: leaves >= 3 });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("api/event error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/submit", async (req, res) => {
  try {
    const { sid, fio, score, total, reason, blurCount, hiddenCount, leaveCount, spentSec, initData } = req.body || {};
    if (!sid) return res.status(400).json({ ok: false, error: "bad_request" });

    const { session: s, created } = getSessionOrFallbackCreate(sid);
    if (!s) return res.status(404).json({ ok: false, error: "unknown_sid" });

    // ✅ ИДЕМПОТЕНТНОСТЬ: если уже завершено — не шлём админу повторно
    if (isFinished(s)) {
      return res.json({ ok: true, alreadyFinished: true });
    }

    // ✅ Привязка к Telegram user через initData (аналогично /api/event)
    if (s.tgUserId) {
      if (initData) {
        const vr = verifyTelegramInitData(initData);
        if (!vr.ok) {
          if (REQUIRE_TG_AUTH) {
            return res.status(401).json({ ok: false, error: "bad_initData", detail: vr.error });
          }
        } else {
          const uid = vr.user?.id;
          if (uid != null) {
            s.boundUserId = String(uid);
            if (String(uid) !== String(s.tgUserId)) {
              if (REQUIRE_TG_AUTH) {
                return res.status(403).json({ ok: false, error: "user_mismatch" });
              } else {
                await sendAdmin(
                  `⚠️ Возможная подмена пользователя (submit)\n` +
                  `sid: ${sid}\nожидался tgUserId=${s.tgUserId}\nпришёл user.id=${uid}`
                );
              }
            }
          }
        }
      } else if (REQUIRE_TG_AUTH) {
        return res.status(401).json({ ok: false, error: "initData_required" });
      }
    }

    if (fio) s.fio = String(fio).trim().slice(0, 120);
    if (Number.isFinite(Number(blurCount))) s.blurCount = Number(blurCount);
    if (Number.isFinite(Number(hiddenCount))) s.hiddenCount = Number(hiddenCount);
    if (Number.isFinite(Number(leaveCount))) s.leaveCount = Number(leaveCount);

    s.score = Number(score ?? 0);
    s.total = Number(total ?? 0);
    s.finishedAt = Date.now();
    sessions.set(sid, s);

    const fioText = s.fio || "ФИО не введено";
    const leaves = Number(s.leaveCount || 0);

    const reasonMap = {
      manual: "завершил вручную",
      time_up: "время вышло",
      too_many_violations: "авто-завершение (3-й уход)"
    };

    await sendAdmin(
      `🏁 Тест завершён\n` +
      `ФИО: ${fioText}\n` +
      `Результат: ${s.score}/${s.total}\n` +
      `Причина: ${reasonMap[reason] || (reason || "manual")}\n` +
      `Уходов: ${leaves} (blur=${s.blurCount || 0}, hidden=${s.hiddenCount || 0})\n` +
      (spentSec != null ? `Время: ${spentSec} сек\n` : "") +
      `sid: ${sid}\n` +
      (created ? "⚠️ sid был создан через fallback (не из бота)\n" : "") +
      (s.boundUserId ? `user.id: ${s.boundUserId}` : "")
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("api/submit error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server started on :${PORT}`);
  console.log(`APP_URL=${APP_URL}`);
  console.log(`STRICT_SID=${STRICT_SID} REQUIRE_TG_AUTH=${REQUIRE_TG_AUTH}`);
  pollLoop();
});
