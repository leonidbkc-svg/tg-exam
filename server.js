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

const STRICT_SID = String(process.env.STRICT_SID || "0") === "1";
const REQUIRE_TG_AUTH = String(process.env.REQUIRE_TG_AUTH || "0") === "1";

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 6 * 60 * 60 * 1000); // 6 часов
const CLEANUP_EVERY_MS = 10 * 60 * 1000; // 10 минут

// логика пересдачи/порог
const PASS_RATE = 0.70;

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
 */
const sessions = new Map();

// attempt counters per tgUserId
const attemptsByUser = new Map();

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

async function sendAdmin(text, reply_markup = undefined) {
  try {
    await tg("sendMessage", { chat_id: ADMIN_TG_ID, text, reply_markup });
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

function buildRetakeDecisionKeyboard(sid) {
  return {
    inline_keyboard: [
      [{ text: "✅ Разрешить пересдачу", callback_data: `RET_OK:${sid}` }],
      [{ text: "❌ Отказать", callback_data: `RET_NO:${sid}` }]
    ]
  };
}

function buildRetakeStartKeyboard(sid) {
  return {
    inline_keyboard: [[{ text: "✅ Начать пересдачу", web_app: { url: makeWebAppUrl(sid) } }]]
  };
}

// ---------------- Admin helpers (ТОЛЬКО ДЛЯ ВАС) ----------------

function isAdmin(userId) {
  return String(userId) === String(ADMIN_TG_ID);
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function getNextAttemptNo(tgUserId) {
  if (!tgUserId) return 1;
  const k = String(tgUserId);
  const prev = Number(attemptsByUser.get(k) || 0);
  const next = prev + 1;
  attemptsByUser.set(k, next);
  return next;
}

function sessionSummaryLine(s) {
  const fio = s.fio || "—";
  const score = (s.score != null && s.total != null) ? `${s.score}/${s.total}` : "—";
  const leaves = Number.isFinite(Number(s.leaveCount)) ? Number(s.leaveCount) : 0;
  const status = s.finishedAt ? "✅" : "🕓";
  const sidShort = (s.sid || "").slice(0, 6);
  const attempt = s.attemptNo ? `попытка#${s.attemptNo}` : "попытка#—";
  return `${status} ${fio} | ${score} | уходов=${leaves} | ${attempt} | sid=${sidShort}… | end=${fmtTime(s.finishedAt)}`;
}

function getSessionsSorted() {
  return Array.from(sessions.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function buildAdminMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📊 Сводка", callback_data: "ADM_SUMMARY" }],
      [{ text: "🧾 Последние 10 (удаление)", callback_data: "ADM_LAST_10" }]
    ]
  };
}

function buildBackToMenuKeyboard() {
  return { inline_keyboard: [[{ text: "⬅️ Назад в меню", callback_data: "ADM_MENU" }]] };
}

function buildLast10WithDeleteKeyboard(list) {
  const rows = list.map(s => {
    const sidShort = (s.sid || "").slice(0, 6);
    const fio = (s.fio || "—").slice(0, 18);
    return [{ text: `🗑 ${fio} (${sidShort}…)`, callback_data: `ADM_DEL:${s.sid}` }];
  });

  rows.push([{ text: "⬅️ Назад в меню", callback_data: "ADM_MENU" }]);
  return { inline_keyboard: rows };
}

function buildConfirmDeleteKeyboard(sid) {
  return {
    inline_keyboard: [
      [{ text: "⚠️ Да, удалить", callback_data: `ADM_DEL_DO:${sid}` }],
      [{ text: "Отмена", callback_data: "ADM_LAST_10" }]
    ]
  };
}

// ---------------- Telegram initData verification (HMAC) ----------------

function verifyTelegramInitData(initData, { maxAgeSec = 24 * 60 * 60 } = {}) {
  try {
    if (!initData || typeof initData !== "string") return { ok: false, error: "no_initData" };

    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { ok: false, error: "no_hash" };

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

    const authDate = Number(params.get("auth_date") || 0);
    if (authDate > 0) {
      const ageSec = Math.floor(Date.now() / 1000) - authDate;
      if (ageSec > maxAgeSec) return { ok: false, error: "auth_date_expired" };
    }

    const userRaw = params.get("user");
    let user = null;
    if (userRaw) {
      try { user = JSON.parse(userRaw); } catch { user = null; }
    }

    return { ok: true, user, authDate };
  } catch {
    return { ok: false, error: "verify_exception" };
  }
}

function getSessionOrFallbackCreate(sid) {
  const existing = sessions.get(sid);
  if (existing) return { session: existing, created: false };

  if (!STRICT_SID) {
    const s = {
      sid,
      createdAt: Date.now(),
      fio: null,
      blurCount: 0,
      hiddenCount: 0,
      leaveCount: 0,
      events: [],
      attemptNo: 1,
      retakeStatus: null
    };
    sessions.set(sid, s);
    return { session: s, created: true };
  }

  return { session: null, created: false };
}

function isFinished(s) {
  return Boolean(s?.finishedAt);
}

function calcPassed(score, total) {
  const t = Number(total || 0);
  if (!t) return false;
  const need = Math.ceil(t * PASS_RATE);
  return Number(score || 0) >= need;
}

// ---------------- Bot polling ----------------

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
      const attemptNo = getNextAttemptNo(userId);

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
        events: [],
        attemptNo,
        retakeStatus: null
      });

      await tg("sendMessage", {
        chat_id: chatId,
        text:
          "Привет! Это тест по ИСМП.\n\n" +
          "Нажми кнопку ниже, введи ФИО и проходи тест.\n" +
          "⚠️ Сворачивания/переключения фиксируются.\n" +
          "🚫 На 3-м уходе тест завершится автоматически.\n" +
          `🧾 Попытка: ${attemptNo}`,
        reply_markup: buildStartKeyboard(sid)
      });
      return;
    }

    if (text === "/admin") {
      if (!isAdmin(userId)) {
        await tg("sendMessage", { chat_id: chatId, text: "Нет доступа." });
        return;
      }

      await tg("sendMessage", {
        chat_id: chatId,
        text: "🔐 Админ-меню",
        reply_markup: buildAdminMenuKeyboard()
      });
      return;
    }

    if (text === "/last10") {
      if (!isAdmin(userId)) {
        await tg("sendMessage", { chat_id: chatId, text: "Нет доступа." });
        return;
      }
      const last = getSessionsSorted().slice(0, 10);
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Последние 10:\n" + (last.length ? last.map(sessionSummaryLine).join("\n") : "Пока пусто.")
      });
      return;
    }
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    const userId = cq.from?.id;
    const data = cq.data || "";
    if (!chatId) return;

    try { await tg("answerCallbackQuery", { callback_query_id: cq.id }); } catch {}

    // ---- обычные кнопки для всех ----
    if (data === "NEW_SESSION") {
      const sid = newSid();
      const attemptNo = getNextAttemptNo(userId);

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
        events: [],
        attemptNo,
        retakeStatus: null
      });

      await tg("sendMessage", {
        chat_id: chatId,
        text: `Ок, создал новый сеанс. Попытка: ${attemptNo}. Жми кнопку:`,
        reply_markup: buildStartKeyboard(sid)
      });
      return;
    }

    // ---- admin кнопки (ТОЛЬКО ВЫ) ----
    if (data.startsWith("ADM_") || data.startsWith("RET_")) {
      if (!isAdmin(userId)) {
        try { await tg("sendMessage", { chat_id: chatId, text: "Нет доступа." }); } catch {}
        return;
      }

      const messageId = cq.message?.message_id;

      const edit = async (text, reply_markup) => {
        try {
          await tg("editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text,
            reply_markup
          });
        } catch {
          await tg("sendMessage", { chat_id: chatId, text, reply_markup });
        }
      };

      if (data === "ADM_MENU") {
        await edit("🔐 Админ-меню", buildAdminMenuKeyboard());
        return;
      }

      if (data === "ADM_SUMMARY") {
        const list = getSessionsSorted();
        const total = list.length;
        const finished = list.filter(s => s.finishedAt).length;

        const top = list
          .filter(s => Number.isFinite(Number(s.score)) && Number.isFinite(Number(s.total)) && Number(s.total) > 0)
          .sort((a, b) => (Number(b.score) / Number(b.total)) - (Number(a.score) / Number(a.total)))
          .slice(0, 7)
          .map((s, i) => `${i + 1}) ${(s.fio || "—")} — ${s.score}/${s.total} (уходов=${s.leaveCount || 0}) (попытка#${s.attemptNo || "—"})`)
          .join("\n") || "—";

        await edit(
          `📊 Сводка\n` +
          `Всего сессий: ${total}\n` +
          `Завершено: ${finished}\n\n` +
          `🏆 Топ:\n${top}`,
          buildBackToMenuKeyboard()
        );
        return;
      }

      if (data === "ADM_LAST_10") {
        const last = getSessionsSorted().slice(0, 10);
        const text = "🧾 Последние 10:\n" + (last.length ? last.map(sessionSummaryLine).join("\n") : "Пока пусто.");
        await edit(text, buildLast10WithDeleteKeyboard(last));
        return;
      }

      if (data.startsWith("ADM_DEL:")) {
        const sid = data.split(":")[1] || "";
        const s = sessions.get(sid);
        const fio = s?.fio || "—";
        const sidShort = sid.slice(0, 10);
        await edit(
          `⚠️ Удалить попытку?\nФИО: ${fio}\nsid: ${sidShort}…`,
          buildConfirmDeleteKeyboard(sid)
        );
        return;
      }

      if (data.startsWith("ADM_DEL_DO:")) {
        const sid = data.split(":")[1] || "";
        const existed = sessions.delete(sid);
        await edit(existed ? "🗑 Удалено." : "ℹ️ Уже удалено.", buildBackToMenuKeyboard());
        return;
      }

      // ✅ решение по пересдаче
      if (data.startsWith("RET_OK:")) {
        const oldSid = data.split(":")[1] || "";
        const s = sessions.get(oldSid);

        if (!s) {
          await edit("ℹ️ Сессия не найдена (возможно, истекла по TTL).", buildBackToMenuKeyboard());
          return;
        }

        if (!s.tgChatId || !s.tgUserId) {
          s.retakeStatus = "approved_nochat";
          sessions.set(oldSid, s);
          await edit("⚠️ Пересдача одобрена, но у сессии нет tgChatId/tgUserId — не могу отправить студенту кнопку.", buildBackToMenuKeyboard());
          return;
        }

        const newSessionSid = newSid();
        const attemptNo = getNextAttemptNo(s.tgUserId);

        sessions.set(newSessionSid, {
          sid: newSessionSid,
          createdAt: Date.now(),
          tgUserId: s.tgUserId,
          tgChatId: s.tgChatId,
          boundUserId: null,
          fio: null,
          blurCount: 0,
          hiddenCount: 0,
          leaveCount: 0,
          startedAt: null,
          finishedAt: null,
          score: null,
          total: null,
          events: [],
          attemptNo,
          retakeStatus: null
        });

        s.retakeStatus = "approved";
        s.retakeApprovedAt = Date.now();
        s.retakeNewSid = newSessionSid;
        sessions.set(oldSid, s);

        try {
          await tg("sendMessage", {
            chat_id: s.tgChatId,
            text: `✅ Пересдача одобрена.\nПопытка: ${attemptNo}\nНажмите кнопку ниже, чтобы начать.`,
            reply_markup: buildRetakeStartKeyboard(newSessionSid)
          });
        } catch (e) {
          console.error("send retake start to student failed:", e.message);
        }

        await edit(
          `✅ Пересдача одобрена.\n` +
          `ФИО: ${s.fio || "—"}\n` +
          `Старая сессия: ${oldSid}\n` +
          `Новая сессия: ${newSessionSid}\n` +
          `Новая попытка: ${attemptNo}`,
          buildBackToMenuKeyboard()
        );
        return;
      }

      if (data.startsWith("RET_NO:")) {
        const oldSid = data.split(":")[1] || "";
        const s = sessions.get(oldSid);

        if (!s) {
          await edit("ℹ️ Сессия не найдена (возможно, истекла по TTL).", buildBackToMenuKeyboard());
          return;
        }

        s.retakeStatus = "denied";
        s.retakeDeniedAt = Date.now();
        sessions.set(oldSid, s);

        if (s.tgChatId) {
          try {
            await tg("sendMessage", {
              chat_id: s.tgChatId,
              text: "❌ Пересдача не одобрена экзаменатором."
            });
          } catch (e) {
            console.error("send retake denied to student failed:", e.message);
          }
        }

        await edit(
          `❌ Пересдача отклонена.\nФИО: ${s.fio || "—"}\nСессия: ${oldSid}`,
          buildBackToMenuKeyboard()
        );
        return;
      }
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

// cleanup
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) {
    const base = s.finishedAt || s.createdAt || now;
    if (now - base > SESSION_TTL_MS) sessions.delete(sid);
  }
}, CLEANUP_EVERY_MS);

// ---------------- HTTP API ----------------

app.get("/health", (req, res) => res.json({
  ok: true,
  strictSid: STRICT_SID,
  requireTgAuth: REQUIRE_TG_AUTH
}));

app.post("/api/new-session", (req, res) => {
  const sid = newSid();
  sessions.set(sid, {
    sid,
    createdAt: Date.now(),
    fio: null,
    blurCount: 0,
    hiddenCount: 0,
    leaveCount: 0,
    events: [],
    attemptNo: 1,
    retakeStatus: null
  });
  return res.json({ ok: true, sid });
});

app.post("/api/event", async (req, res) => {
  try {
    const { sid, type, payload, ts, initData } = req.body || {};
    if (!sid || !type) return res.status(400).json({ ok: false, error: "bad_request" });

    const { session: s } = getSessionOrFallbackCreate(sid);
    if (!s) return res.status(404).json({ ok: false, error: "unknown_sid" });

    // Telegram auth binding for bot-created sessions
    if (s.tgUserId) {
      if (initData) {
        const vr = verifyTelegramInitData(initData);
        if (!vr.ok) {
          if (REQUIRE_TG_AUTH) return res.status(401).json({ ok: false, error: "bad_initData", detail: vr.error });
        } else {
          const uid = vr.user?.id;
          if (uid != null) {
            s.boundUserId = String(uid);
            if (String(uid) !== String(s.tgUserId)) {
              if (REQUIRE_TG_AUTH) return res.status(403).json({ ok: false, error: "user_mismatch" });
              await sendAdmin(`⚠️ Возможная подмена пользователя\nsid: ${sid}\nожидался tgUserId=${s.tgUserId}\nпришёл user.id=${uid}\ntype=${type}`);
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
        `✅ Регистрация/старт\n` +
        `ФИО: ${s.fio}\n` +
        `Попытка: ${s.attemptNo || "—"}\n` +
        `sid: ${sid}\n` +
        (s.boundUserId ? `user.id: ${s.boundUserId}` : "")
      );
      return res.json({ ok: true });
    }

    if (type === "blur") {
      const next = Number.isFinite(Number(p?.blurCount)) ? Number(p.blurCount) : (Number(s.blurCount || 0) + 1);
      s.blurCount = next;
    }

    if (type === "hidden") {
      const next = Number.isFinite(Number(p?.hiddenCount)) ? Number(p.hiddenCount) : (Number(s.hiddenCount || 0) + 1);
      s.hiddenCount = next;
    }

    if (p?.leaveCount != null && Number.isFinite(Number(p.leaveCount))) {
      s.leaveCount = Number(p.leaveCount);
    }

    sessions.set(sid, s);

    if (type === "hidden") {
      const fio = s.fio || "ФИО не введено";
      const leaves = Number(s.leaveCount || 0);
      const status = leaves >= 3 ? "🚫 3-й уход — авто-завершение" : "⚠️ уход из теста";

      await sendAdmin(
        `${status}\n` +
        `ФИО: ${fio}\n` +
        `Попытка: ${s.attemptNo || "—"}\n` +
        `sid: ${sid}\n` +
        `событие: hidden\n` +
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

    const { session: s } = getSessionOrFallbackCreate(sid);
    if (!s) return res.status(404).json({ ok: false, error: "unknown_sid" });

    if (isFinished(s)) return res.json({ ok: true, alreadyFinished: true });

    // Telegram auth binding for bot-created sessions
    if (s.tgUserId) {
      if (initData) {
        const vr = verifyTelegramInitData(initData);
        if (!vr.ok) {
          if (REQUIRE_TG_AUTH) return res.status(401).json({ ok: false, error: "bad_initData", detail: vr.error });
        } else {
          const uid = vr.user?.id;
          if (uid != null) {
            s.boundUserId = String(uid);
            if (String(uid) !== String(s.tgUserId)) {
              if (REQUIRE_TG_AUTH) return res.status(403).json({ ok: false, error: "user_mismatch" });
              await sendAdmin(`⚠️ Возможная подмена пользователя (submit)\nsid: ${sid}\nожидался tgUserId=${s.tgUserId}\nпришёл user.id=${uid}`);
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

    const passed = (reason !== "too_many_violations") ? calcPassed(s.score, s.total) : false;
    const passText = passed ? "✅ СДАН" : "❌ НЕ СДАН";

    await sendAdmin(
      `🏁 Тест завершён (${passText})\n` +
      `ФИО: ${fioText}\n` +
      `Попытка: ${s.attemptNo || "—"}\n` +
      `Результат: ${s.score}/${s.total}\n` +
      `Причина: ${reasonMap[reason] || (reason || "manual")}\n` +
      `Уходов: ${leaves} (blur=${s.blurCount || 0}, hidden=${s.hiddenCount || 0})\n` +
      (spentSec != null ? `Время: ${spentSec} сек\n` : "") +
      `sid: ${sid}\n` +
      (s.boundUserId ? `user.id: ${s.boundUserId}` : "")
    );

    return res.json({ ok: true, passed });
  } catch (e) {
    console.error("api/submit error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/**
 * ✅ Запрос на пересдачу от студента
 */
app.post("/api/retake-request", async (req, res) => {
  try {
    const { sid, fio, score, total, reason } = req.body || {};
    if (!sid) return res.status(400).json({ ok: false, error: "bad_request" });

    const s = sessions.get(sid);
    if (!s) return res.status(404).json({ ok: false, error: "unknown_sid" });

    // пересдача только если тест завершён
    if (!s.finishedAt) return res.status(400).json({ ok: false, error: "not_finished" });

    // если нарушения — не даём пересдачу через кнопку (чтобы античит имел смысл)
    if (String(reason || s.reason || "") === "too_many_violations") {
      return res.status(403).json({ ok: false, error: "violations_no_retake" });
    }

    // если сдал — тоже не надо
    const passed = calcPassed(score ?? s.score, total ?? s.total);
    if (passed) return res.status(400).json({ ok: false, error: "already_passed" });

    if (s.retakeStatus === "pending") return res.json({ ok: true, status: "pending_already" });
    if (s.retakeStatus === "approved") return res.json({ ok: true, status: "approved_already" });

    s.retakeStatus = "pending";
    s.retakeRequestedAt = Date.now();
    sessions.set(sid, s);

    const fioText = (fio || s.fio || "ФИО не введено");
    const scr = (score != null && total != null) ? `${score}/${total}` : `${s.score ?? "—"}/${s.total ?? "—"}`;

    await sendAdmin(
      `📩 Запрос на пересдачу\n` +
      `ФИО: ${fioText}\n` +
      `Попытка: ${s.attemptNo || "—"}\n` +
      `Результат: ${scr}\n` +
      `sid: ${sid}\n` +
      (s.tgUserId ? `tgUserId: ${s.tgUserId}\n` : "") +
      (s.tgChatId ? `tgChatId: ${s.tgChatId}\n` : ""),
      buildRetakeDecisionKeyboard(sid)
    );

    return res.json({ ok: true, status: "pending" });
  } catch (e) {
    console.error("api/retake-request error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server started on :${PORT}`);
  console.log(`APP_URL=${APP_URL}`);
  console.log(`STRICT_SID=${STRICT_SID} REQUIRE_TG_AUTH=${REQUIRE_TG_AUTH}`);
  pollLoop();
});
