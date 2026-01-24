import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { Telegraf, Markup } from "telegraf";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TG_ID = process.env.ADMIN_TG_ID;
const APP_URL = process.env.APP_URL;

if (!BOT_TOKEN || !ADMIN_TG_ID || !APP_URL) {
  console.error("❌ Не заданы BOT_TOKEN / ADMIN_TG_ID / APP_URL");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const bot = new Telegraf(BOT_TOKEN);

/* ===== ВРЕМЕННОЕ ХРАНИЛИЩЕ СЕССИЙ (MVP) ===== */
const sessions = new Map();

function makeSessionId() {
  return crypto.randomBytes(12).toString("hex");
}

/* ===== ПРОВЕРКА initData ОТ TELEGRAM ===== */
function verifyTelegramInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return false;

  params.delete("hash");

  const data = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const checkHash = crypto
    .createHmac("sha256", secretKey)
    .update(data)
    .digest("hex");

  return checkHash === hash;
}

/* ===== БОТ ===== */
bot.start((ctx) => {
  const sid = makeSessionId();

  sessions.set(sid, {
    userId: ctx.from.id,
    username: ctx.from.username || "",
    fio: "",
    exits: 0,
    lastHidden: null
  });

  ctx.reply(
    "ИСМП — тестирование\nНажмите кнопку ниже для начала:",
    Markup.inlineKeyboard([
      Markup.button.webApp("🧪 Начать тест", `${APP_URL}/?sid=${sid}`)
    ])
  );
});

/* ===== API ДЛЯ MINI APP ===== */
app.post("/api/event", async (req, res) => {
  const { initData, sid, type, payload } = req.body;

  if (!verifyTelegramInitData(initData)) {
    return res.status(403).json({ ok: false });
  }

  const s = sessions.get(sid);
  if (!s) return res.status(404).json({ ok: false });

  const now = Date.now();

  if (type === "fio") {
    s.fio = payload.fio;
  }

  if (type === "hidden") {
    s.exits += 1;
    s.lastHidden = now;

    if (s.exits >= 2) {
      await bot.telegram.sendMessage(
        ADMIN_TG_ID,
        `🚨 ИСМП — выход из теста\n` +
        `ФИО: ${s.fio || "не указано"}\n` +
        `@${s.username || "без username"}\n` +
        `Выходов: ${s.exits}`
      );
    }
  }

  if (type === "visible" && s.lastHidden) {
    const sec = Math.round((now - s.lastHidden) / 1000);
    s.lastHidden = null;

    if (sec >= 15) {
      await bot.telegram.sendMessage(
        ADMIN_TG_ID,
        `⏱ Долгий выход из теста\n` +
        `ФИО: ${s.fio || "не указано"}\n` +
        `Отсутствовал: ${sec} сек`
      );
    }
  }

  res.json({ ok: true });
});

/* ===== ЗАПУСК ===== */
const PORT = 3000;
app.listen(PORT, () => console.log("🚀 Сервер запущен на 3000"));

bot.launch();
