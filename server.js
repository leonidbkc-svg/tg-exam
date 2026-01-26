"use strict";

/**
 * tg-exam server.js
 * - Express + static public/
 * - Telegram bot polling (IPv4-only to avoid IPv6 timeouts)
 * - Persist exam results to ./data/results.json
 * - Admin export API protected by REPORT_API_KEY
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const https = require("https");
const dns = require("dns");

// IMPORTANT: prefer IPv4 results first (still keep TLS hostname)
try {
  dns.setDefaultResultOrder("ipv4first");
} catch (_) {}

// If your project uses node-fetch in package.json, keep it:
let fetch;
try {
  fetch = require("node-fetch");
  // node-fetch v2 exports function directly
  fetch = fetch.default || fetch;
} catch (e) {
  // Fallback to global fetch (Node 18+). Note: agent option won't work in undici.
  fetch = global.fetch;
  console.warn("node-fetch not found; using global fetch. For IPv4 agent, install node-fetch.");
}

// ====== ENV ======
const PORT = parseInt(process.env.PORT || "3000", 10);
const APP_URL = process.env.APP_URL || "http://localhost:" + PORT;

const REPORT_API_KEY = process.env.REPORT_API_KEY || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_TG_ID = String(process.env.ADMIN_TG_ID || "");

// modes
const STRICT_SID = String(process.env.STRICT_SID || "0") === "1";
const REQUIRE_TG_AUTH = String(process.env.REQUIRE_TG_AUTH || "0") === "1";

// ====== TELEGRAM BASE ======
const TG_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : "";

// IPv4-only agent for node-fetch HTTPS requests
const tgAgent = new https.Agent({
  keepAlive: true,
  lookup: (hostname, opts, cb) => dns.lookup(hostname, { family: 4 }, cb),
});

// ====== STORAGE (JSON) ======
const DATA_DIR = path.join(__dirname, "data");
const RESULTS_FILE = path.join(DATA_DIR, "results.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(RESULTS_FILE)) {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify({ results: [] }, null, 2), "utf-8");
  }
}

function readStore() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(RESULTS_FILE, "utf-8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return { results: [] };
    if (!Array.isArray(obj.results)) obj.results = [];
    return obj;
  } catch {
    return { results: [] };
  }
}

function atomicWrite(filePath, content) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

function appendResult(row) {
  const store = readStore();
  store.results.push(row);
  atomicWrite(RESULTS_FILE, JSON.stringify(store, null, 2));
}

function listResults({ fromTs, toTs, tgId }) {
  const store = readStore();
  let arr = store.results.slice();

  if (typeof fromTs === "number") arr = arr.filter((r) => (r.ts || 0) >= fromTs);
  if (typeof toTs === "number") arr = arr.filter((r) => (r.ts || 0) <= toTs);
  if (tgId) arr = arr.filter((r) => String(r.tg_id || "") === String(tgId));

  return arr;
}

// ====== HELPERS ======
function nowTs() {
  return Date.now();
}

function uid(prefix = "r_") {
  return prefix + crypto.randomBytes(8).toString("hex");
}

function toCsv(results) {
  const headers = [
    "id",
    "ts",
    "date_iso",
    "exam_id",
    "exam_title",
    "tg_id",
    "tg_username",
    "tg_first_name",
    "tg_last_name",
    "score",
    "max_score",
    "percent",
    "passed",
    "duration_sec",
    "answers_json",
    "meta_json",
  ];

  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [];
  lines.push(headers.join(","));
  for (const r of results) {
    const row = [
      r.id,
      r.ts,
      r.date_iso,
      r.exam_id,
      r.exam_title,
      r.tg_id,
      r.tg_username,
      r.tg_first_name,
      r.tg_last_name,
      r.score,
      r.max_score,
      r.percent,
      r.passed,
      r.duration_sec,
      JSON.stringify(r.answers || []),
      JSON.stringify(r.meta || {}),
    ].map(esc);
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (!REPORT_API_KEY || String(key || "") !== String(REPORT_API_KEY)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

function safeBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

// ====== EXPRESS ======
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// basic health
app.get("/health", (req, res) => res.json({ ok: true, ts: nowTs() }));

// static frontend (if you have it)
app.use(express.static(path.join(__dirname, "public")));

// ====== API: RECEIVE RESULT ======
/**
 * POST /api/results
 * Headers: x-api-key: REPORT_API_KEY
 * Body example:
 * {
 *   exam_id: "test-1",
 *   exam_title: "Тест по эпидрежиму",
 *   tg: { id, username, first_name, last_name },
 *   score: 8,
 *   max_score: 10,
 *   duration_sec: 123,
 *   passed: true,
 *   answers: [{q_id, q_text, chosen, correct, is_correct}],
 *   meta: { sid, ip, user_agent }
 * }
 */
app.post("/api/results", requireApiKey, (req, res) => {
  try {
    const b = req.body || {};
    const tg = b.tg || {};

    const score = Number.isFinite(+b.score) ? +b.score : 0;
    const maxScore = Number.isFinite(+b.max_score) ? +b.max_score : 0;
    const percent = maxScore > 0 ? Math.round((score / maxScore) * 1000) / 10 : 0;

    const row = {
      id: uid("res_"),
      ts: nowTs(),
      date_iso: new Date().toISOString(),

      exam_id: String(b.exam_id || ""),
      exam_title: String(b.exam_title || ""),

      tg_id: tg.id != null ? String(tg.id) : "",
      tg_username: tg.username ? String(tg.username) : "",
      tg_first_name: tg.first_name ? String(tg.first_name) : "",
      tg_last_name: tg.last_name ? String(tg.last_name) : "",

      score,
      max_score: maxScore,
      percent,
      passed: safeBool(b.passed),

      duration_sec: Number.isFinite(+b.duration_sec) ? +b.duration_sec : null,

      answers: Array.isArray(b.answers) ? b.answers : [],
      meta: (b.meta && typeof b.meta === "object") ? b.meta : {},
    };

    // optional strict mode: require SID in meta
    if (STRICT_SID && !row.meta?.sid) {
      return res.status(400).json({ ok: false, error: "sid_required" });
    }

    // optional require tg auth: require tg_id
    if (REQUIRE_TG_AUTH && !row.tg_id) {
      return res.status(400).json({ ok: false, error: "tg_required" });
    }

    appendResult(row);
    return res.json({ ok: true, id: row.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ====== API: ADMIN EXPORT ======
/**
 * GET /api/admin/results
 * Headers: x-api-key: REPORT_API_KEY
 * Query: from=timestamp_ms&to=timestamp_ms&tg_id=...
 */
app.get("/api/admin/results", requireApiKey, (req, res) => {
  const from = req.query.from ? Number(req.query.from) : undefined;
  const to = req.query.to ? Number(req.query.to) : undefined;
  const tgId = req.query.tg_id ? String(req.query.tg_id) : undefined;

  const results = listResults({
    fromTs: Number.isFinite(from) ? from : undefined,
    toTs: Number.isFinite(to) ? to : undefined,
    tgId,
  });

  res.json({ ok: true, count: results.length, results });
});

/**
 * GET /api/admin/results.csv
 * Headers: x-api-key: REPORT_API_KEY
 * Query: from=...&to=...&tg_id=...
 */
app.get("/api/admin/results.csv", requireApiKey, (req, res) => {
  const from = req.query.from ? Number(req.query.from) : undefined;
  const to = req.query.to ? Number(req.query.to) : undefined;
  const tgId = req.query.tg_id ? String(req.query.tg_id) : undefined;

  const results = listResults({
    fromTs: Number.isFinite(from) ? from : undefined,
    toTs: Number.isFinite(to) ? to : undefined,
    tgId,
  });

  const csv = toCsv(results);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="results.csv"');
  res.send(csv);
});

// ====== TELEGRAM BOT (POLLING) ======
let isPolling = false;
let pollOffset = 0;

async function tgCall(method, params) {
  if (!TG_API) throw new Error("BOT_TOKEN is not set");

  const url = `${TG_API}/${method}`;
  const opts = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params || {}),
  };

  // node-fetch supports agent; global fetch (undici) doesn't
  if (opts && typeof opts === "object" && fetch && fetch.name !== "fetch") {
    opts.agent = tgAgent;
  } else if (fetch && fetch !== global.fetch) {
    opts.agent = tgAgent;
  }

  const r = await fetch(url, opts);
  const j = await r.json().catch(() => null);
  if (!j || j.ok !== true) {
    throw new Error(`Telegram API error: ${JSON.stringify(j)}`);
  }
  return j.result;
}

async function tgSend(chatId, text, extra) {
  return tgCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(extra || {}),
  });
}

function isAdminTgId(tgId) {
  if (!ADMIN_TG_ID) return false;
  return String(tgId) === String(ADMIN_TG_ID);
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const from = msg.from || {};
  const text = String(msg.text || "").trim();

  if (text === "/start") {
    await tgSend(
      chatId,
      "Привет! Это бот тестирования.\n\n" +
        "• Если ты проходишь тест — просто следуй ссылке/инструкции.\n" +
        "• Админ: /export"
    );
    return;
  }

  if (text === "/export") {
    if (!isAdminTgId(from.id)) {
      await tgSend(chatId, "⛔ Нет доступа.");
      return;
    }
    // Give an admin link to export (requires REPORT_API_KEY)
    const hint =
      `✅ Экспорт:\n` +
      `JSON: ${APP_URL}/api/admin/results?api_key=REPORT_API_KEY\n` +
      `CSV:  ${APP_URL}/api/admin/results.csv?api_key=REPORT_API_KEY\n\n` +
      `⚠️ Вместо REPORT_API_KEY подставь свой ключ.`;
    await tgSend(chatId, hint);
    return;
  }

  if (text.startsWith("/whoami")) {
    await tgSend(
      chatId,
      `id: <b>${from.id}</b>\nusername: <b>${from.username || "-"}</b>`
    );
    return;
  }

  // any other message
  await tgSend(chatId, "Я понял. Если нужен экспорт — /export");
}

async function pollLoop() {
  if (!BOT_TOKEN) {
    console.warn("BOT_TOKEN is not set. Bot polling disabled.");
    return;
  }
  if (!fetch) {
    console.warn("fetch is not available. Bot polling disabled.");
    return;
  }

  isPolling = true;
  console.log("🤖 Bot polling started");

  while (isPolling) {
    try {
      const url = `${TG_API}/getUpdates?timeout=25&offset=${pollOffset}`;

      const opts = {
        method: "GET",
        headers: { "content-type": "application/json" },
      };

      // node-fetch: use agent to force IPv4
      if (fetch && fetch !== global.fetch) opts.agent = tgAgent;

      const r = await fetch(url, opts);
      const j = await r.json().catch(() => null);

      if (!j || j.ok !== true) {
        throw new Error(`getUpdates failed: ${JSON.stringify(j)}`);
      }

      const updates = j.result || [];
      for (const u of updates) {
        pollOffset = Math.max(pollOffset, (u.update_id || 0) + 1);
        await handleUpdate(u);
      }
    } catch (e) {
      console.error("pollLoop error:", e && e.message ? e.message : e);
      // small backoff
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ====== START SERVER ======
ensureDataDir();

app.listen(PORT, () => {
  console.log(`✅ Server started on :${PORT}`);
  console.log(`APP_URL=${APP_URL}`);
  console.log(`STRICT_SID=${STRICT_SID} REQUIRE_TG_AUTH=${REQUIRE_TG_AUTH}`);
  console.log(`REPORT_API_KEY is ${REPORT_API_KEY ? "SET" : "NOT set"}`);

  // start bot polling
  pollLoop().catch((e) => console.error("pollLoop fatal:", e));
});

// graceful stop
process.on("SIGINT", () => {
  isPolling = false;
  process.exit(0);
});
process.on("SIGTERM", () => {
  isPolling = false;
  process.exit(0);
});
