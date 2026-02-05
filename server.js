// server.js (ESM because package.json has "type": "module")

import fs from "fs";
import path from "path";
import crypto from "crypto";
import https from "https";
import dns from "dns";
import express from "express";
import { fileURLToPath } from "url";

// ----------------- ESM __dirname -----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------------- ENV -----------------
const PORT = parseInt(process.env.PORT || "3000", 10);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_TG_ID = String(process.env.ADMIN_TG_ID || "");

const REPORT_API_KEY = String(process.env.REPORT_API_KEY || "");
const INGEST_API_KEY = String(process.env.INGEST_API_KEY || REPORT_API_KEY);

const STRICT_SID = String(process.env.STRICT_SID || "0") === "1";
const REQUIRE_TG_AUTH = String(process.env.REQUIRE_TG_AUTH || "0") === "1"; // kept for compatibility/logging

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 6 * 60 * 60 * 1000); // 6 hours
const CLEANUP_EVERY_MS = Number(process.env.CLEANUP_EVERY_MS || 10 * 60 * 1000); // 10 min

// IMPORTANT: prefer IPv4 first (doesn't break TLS host)
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {}

// ----------------- IPv4-only HTTPS agent -----------------
const tgAgent = new https.Agent({
  keepAlive: true,
  lookup: (hostname, opts, cb) => dns.lookup(hostname, { family: 4 }, cb),
});

// ----------------- Storage -----------------
const DATA_DIR = path.join(__dirname, "data");
const RESULTS_FILE = path.join(DATA_DIR, "results.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(RESULTS_FILE)) {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify({ results: [] }, null, 2), "utf-8");
  }
  if (!fs.existsSync(SESSIONS_FILE)) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: [] }, null, 2), "utf-8");
  }
}

function atomicWrite(filePath, content) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

function uid(prefix = "id_") {
  return prefix + crypto.randomBytes(8).toString("hex");
}

function readJsonFile(filePath, fallbackObj) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : fallbackObj;
  } catch {
    return fallbackObj;
  }
}

// ---- results store ----
function readResultsStore() {
  ensureDataDir();
  const st = readJsonFile(RESULTS_FILE, { results: [] });
  if (!Array.isArray(st.results)) st.results = [];
  return st;
}
function appendResult(row) {
  const st = readResultsStore();
  st.results.push(row);
  atomicWrite(RESULTS_FILE, JSON.stringify(st, null, 2));
}
function listResults({ fromTs, toTs, tgId } = {}) {
  const st = readResultsStore();
  let arr = st.results.slice();
  if (typeof fromTs === "number") arr = arr.filter((r) => (r.ts || 0) >= fromTs);
  if (typeof toTs === "number") arr = arr.filter((r) => (r.ts || 0) <= toTs);
  if (tgId) arr = arr.filter((r) => String(r.tg_id || "") === String(tgId));
  return arr;
}

function toCsv(results) {
  const headers = [
    "id", "ts", "date_iso",
    "exam_id", "exam_title",
    "tg_id", "tg_username", "tg_first_name", "tg_last_name",
    "score", "max_score", "percent", "passed",
    "duration_sec",
    "answers_json", "meta_json",
  ];

  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [headers.join(",")];
  for (const r of results) {
    const row = [
      r.id, r.ts, r.date_iso,
      r.exam_id, r.exam_title,
      r.tg_id, r.tg_username, r.tg_first_name, r.tg_last_name,
      r.score, r.max_score, r.percent, r.passed,
      r.duration_sec,
      JSON.stringify(r.answers || []),
      JSON.stringify(r.meta || {}),
    ].map(esc);
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

// ---- sessions store ----
function readSessionsStore() {
  ensureDataDir();
  const st = readJsonFile(SESSIONS_FILE, { sessions: [] });
  if (!Array.isArray(st.sessions)) st.sessions = [];
  return st;
}
function writeSessionsStore(st) {
  atomicWrite(SESSIONS_FILE, JSON.stringify(st, null, 2));
}
function getClientIp(req) {
  return (
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    String(req.socket?.remoteAddress || "")
  );
}
function findSession(st, sid) {
  return st.sessions.find((s) => s.sid === sid);
}

// Cleanup old sessions (best effort)
function cleanupSessions() {
  try {
    const st = readSessionsStore();
    const now = Date.now();
    st.sessions = st.sessions.filter((s) => {
      const base = s.updatedAt || s.createdAt || now;
      return now - base <= SESSION_TTL_MS;
    });
    writeSessionsStore(st);
  } catch {}
}

// ----------------- Auth -----------------
function requireReportKey(req, res, next) {
  const key = req.query.api_key || req.headers["x-api-key"];
  if (!REPORT_API_KEY || String(key || "") !== String(REPORT_API_KEY)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

function requireIngestKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (!INGEST_API_KEY || String(key || "") !== String(INGEST_API_KEY)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

function safeBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function normalizeAnswers(b) {
  if (!b) return [];
  let answers = b.answers;
  if (typeof answers === "string") {
    try { answers = JSON.parse(answers); } catch {}
  }
  if (!Array.isArray(answers) && b.answers_json) {
    try {
      const parsed = typeof b.answers_json === "string" ? JSON.parse(b.answers_json) : b.answers_json;
      if (Array.isArray(parsed)) answers = parsed;
      if (parsed && Array.isArray(parsed.answers)) answers = parsed.answers;
    } catch {}
  }
  if (!Array.isArray(answers) && b.payload && Array.isArray(b.payload.answers)) {
    answers = b.payload.answers;
  }
  if (!Array.isArray(answers)) answers = [];
  return answers;
}

// ----------------- Telegram HTTP helper (NO fetch, pure https) -----------------
function tgRequestJson({ method = "GET", path: reqPath, bodyObj = null }) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? Buffer.from(JSON.stringify(bodyObj), "utf-8") : null;

    const req = https.request(
      {
        protocol: "https:",
        hostname: "api.telegram.org",
        port: 443,
        method,
        path: reqPath,
        agent: tgAgent,
        headers: {
          "content-type": "application/json",
          ...(body ? { "content-length": body.length } : {}),
        },
        timeout: 35000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data || "{}");
            resolve({ status: res.statusCode || 0, json });
          } catch (e) {
            reject(new Error("Bad JSON from Telegram: " + String(e?.message || e)));
          }
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error("Telegram request timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function tgCall(methodName, params = {}) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");
  const p = `/bot${BOT_TOKEN}/${methodName}`;
  const { json } = await tgRequestJson({ method: "POST", path: p, bodyObj: params });
  if (!json || json.ok !== true) {
    throw new Error(`Telegram API error: ${JSON.stringify(json)}`);
  }
  return json.result;
}

async function tgSend(chatId, text, extra = {}) {
  return tgCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function sendAdmin(text) {
  if (!ADMIN_TG_ID) return;
  try {
    await tgSend(ADMIN_TG_ID, text);
  } catch (e) {
    console.error("sendAdmin failed:", e?.message || e);
  }
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function isAdminTgId(tgId) {
  return ADMIN_TG_ID && String(tgId) === String(ADMIN_TG_ID);
}

// ----------------- Bot polling -----------------
let isPolling = false;
let pollOffset = 0;

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
        "Админ команды:\n" +
        "• /export — ссылки на выгрузку\n" +
        "• /whoami — покажу твой TG id"
    );
    return;
  }

  if (text === "/whoami") {
    await tgSend(chatId, `id: <b>${from.id}</b>\nusername: <b>${from.username || "-"}</b>`);
    return;
  }

  if (text === "/export") {
    if (!isAdminTgId(from.id)) {
      await tgSend(chatId, "⛔ Нет доступа.");
      return;
    }
    const hint =
      `✅ Экспорт:\n` +
      `JSON: ${APP_URL}/api/admin/results?api_key=REPORT_API_KEY\n` +
      `CSV:  ${APP_URL}/api/admin/results.csv?api_key=REPORT_API_KEY\n\n` +
      `⚠️ Вместо REPORT_API_KEY подставь свой ключ.`;
    await tgSend(chatId, hint);
    return;
  }

  await tgSend(chatId, "Ок. Если нужен экспорт — /export");
}

async function pollLoop() {
  if (!BOT_TOKEN) {
    console.warn("BOT_TOKEN is not set. Bot polling disabled.");
    return;
  }

  isPolling = true;
  console.log("🤖 Bot polling started");

  while (isPolling) {
    try {
      const p = `/bot${BOT_TOKEN}/getUpdates?timeout=25&offset=${pollOffset}`;
      const { json } = await tgRequestJson({ method: "GET", path: p });

      if (!json || json.ok !== true) {
        throw new Error(`getUpdates failed: ${JSON.stringify(json)}`);
      }

      const updates = json.result || [];
      for (const u of updates) {
        pollOffset = Math.max(pollOffset, (u.update_id || 0) + 1);
        await handleUpdate(u);
      }
    } catch (e) {
      console.error("pollLoop error:", e?.message || e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ----------------- Express -----------------
ensureDataDir();
setInterval(cleanupSessions, CLEANUP_EVERY_MS).unref?.();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// static
app.use(express.static(path.join(__dirname, "public")));

// ----------------- MiniApp API -----------------

app.post("/api/new-session", (req, res) => {
  try {
    const sid = uid("sid_");
    const now = Date.now();
    const st = readSessionsStore();
    st.sessions.push({
      sid,
      createdAt: now,
      updatedAt: now,
      ip: getClientIp(req),
      user_agent: String(req.headers["user-agent"] || ""),
      fio: "",
      blurCount: 0,
      hiddenCount: 0,
      leaveCount: 0,
      startedAt: null,
      finishedAt: null,
      lastReason: null,
    });
    writeSessionsStore(st);
    return res.json({ ok: true, sid });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/event", async (req, res) => {
  try {
    const b = req.body || {};
    const sid = String(b.sid || "").trim();
    const type = String(b.type || "").trim();
    const payload = b.payload && typeof b.payload === "object" ? b.payload : {};

    if (!sid || !type) return res.status(400).json({ ok: false, error: "bad_request" });

    const st = readSessionsStore();
    const s = findSession(st, sid);
    if (!s) return res.status(404).json({ ok: false, error: "unknown_sid" });

    if (payload.fio) s.fio = String(payload.fio).trim().slice(0, 160);
    if (Number.isFinite(+payload.blurCount)) s.blurCount = +payload.blurCount;
    if (Number.isFinite(+payload.hiddenCount)) s.hiddenCount = +payload.hiddenCount;
    if (Number.isFinite(+payload.leaveCount)) s.leaveCount = +payload.leaveCount;

    s.updatedAt = Date.now();
    if (!s.startedAt && type === "start") s.startedAt = Date.now();

    writeSessionsStore(st);

    const shouldFinish = Number(s.leaveCount || 0) >= 3;

    // ---- admin notifications (only important events) ----
    if (type === "start") {
      const fio = s.fio || "—";
      await sendAdmin(
        `✅ Старт/регистрация\n` +
          `ФИО: <b>${fio}</b>\n` +
          `sid: <code>${sid}</code>\n` +
          `IP: <code>${s.ip || "-"}</code>\n` +
          `time: <code>${fmtTime(Date.now())}</code>`
      );
    }

    if (type === "hidden") {
      const fio = s.fio || "—";
      const leaves = Number(s.leaveCount || 0);
      const status = leaves >= 3 ? "🚫 3-й уход — авто-завершение" : "⚠️ уход из теста";
      await sendAdmin(
        `${status}\n` +
          `ФИО: <b>${fio}</b>\n` +
          `уходов: <b>${leaves}</b> (blur=${s.blurCount || 0}, hidden=${s.hiddenCount || 0})\n` +
          `sid: <code>${sid}</code>\n` +
          `time: <code>${fmtTime(Date.now())}</code>`
      );
    }

    return res.json({ ok: true, shouldFinish });
  } catch (e) {
    console.error("api/event error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/submit", async (req, res) => {
  try {
    const b = req.body || {};
    const sid = String(b.sid || "").trim();
    if (!sid) return res.status(400).json({ ok: false, error: "sid_required" });

    console.log("SUBMIT answers:", Array.isArray(b.answers), typeof b.answers, b.answers?.length);

    const fio = String(b.fio || "").trim().slice(0, 160);
    const score = Number.isFinite(+b.score) ? +b.score : 0;
    const total = Number.isFinite(+b.total) ? +b.total : 0;
    const reason = String(b.reason || "manual");
    const spentSec = Number.isFinite(+b.spentSec) ? +b.spentSec : null;

    const blurCount = Number.isFinite(+b.blurCount) ? +b.blurCount : 0;
    const hiddenCount = Number.isFinite(+b.hiddenCount) ? +b.hiddenCount : 0;
    const leaveCount = Number.isFinite(+b.leaveCount) ? +b.leaveCount : 0;

    // update session (best effort)
    let ip = getClientIp(req);
    try {
      const st = readSessionsStore();
      const s = findSession(st, sid);
      if (s) {
        ip = s.ip || ip;
        s.fio = fio || s.fio || "";
        s.finishedAt = Date.now();
        s.updatedAt = Date.now();
        s.lastReason = reason;
        s.blurCount = blurCount;
        s.hiddenCount = hiddenCount;
        s.leaveCount = leaveCount;
        writeSessionsStore(st);
      }
    } catch {}

    const maxScore = total;
    const percent = maxScore > 0 ? Math.round((score / maxScore) * 1000) / 10 : 0;

    const passed = reason === "too_many_violations"
      ? false
      : (maxScore > 0 ? (score / maxScore) >= 0.7 : false);

    const answers = normalizeAnswers(b);

    const row = {
      id: uid("res_"),
      ts: Date.now(),
      date_iso: new Date().toISOString(),

      exam_id: "ismps",
      exam_title: "Тест по ИСМП",

      tg_id: "",
      tg_username: "",
      tg_first_name: "",
      tg_last_name: "",

      score,
      max_score: maxScore,
      percent,
      passed,

      duration_sec: spentSec,

      answers,

      meta: {
        sid,
        fio,
        reason,
        blurCount,
        hiddenCount,
        leaveCount,
        ip,
        user_agent: String(req.headers["user-agent"] || ""),
        source: "webapp_submit",
      },
    };

    if (STRICT_SID && !row.meta?.sid) {
      return res.status(400).json({ ok: false, error: "sid_required" });
    }

    appendResult(row);

    // ---- admin notification (finish) ----
    const reasonMap = {
      manual: "завершил вручную",
      time_up: "время вышло",
      too_many_violations: "авто-завершение (3-й уход)",
    };
    const passText = passed ? "✅ СДАН" : "❌ НЕ СДАН";

    await sendAdmin(
      `🏁 Тест завершён (${passText})\n` +
        `ФИО: <b>${fio || "—"}</b>\n` +
        `Результат: <b>${score}/${total}</b> (${Math.round(percent)}%)\n` +
        `Причина: <b>${reasonMap[reason] || reason}</b>\n` +
        `Уходов: <b>${leaveCount}</b> (blur=${blurCount}, hidden=${hiddenCount})\n` +
        `Время: <b>${spentSec ?? "-"}</b> сек\n` +
        `sid: <code>${sid}</code>\n` +
        `time: <code>${fmtTime(Date.now())}</code>`
    );

    return res.json({ ok: true, passed });
  } catch (e) {
    console.error("api/submit error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/retake-request", (req, res) => {
  try {
    const b = req.body || {};
    const sid = String(b.sid || "").trim();
    if (!sid) return res.status(400).json({ ok: false, error: "sid_required" });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ----------------- Ingest API (server/python) -----------------
app.post("/api/results", requireIngestKey, (req, res) => {
  try {
    const b = req.body || {};
    const tg = b.tg || {};

    const score = Number.isFinite(+b.score) ? +b.score : 0;
    const maxScore = Number.isFinite(+b.max_score) ? +b.max_score : 0;
    const percent = maxScore > 0 ? Math.round((score / maxScore) * 1000) / 10 : 0;

    const answers = normalizeAnswers(b);

    const row = {
      id: uid("res_"),
      ts: Date.now(),
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

      answers,
      meta: b.meta && typeof b.meta === "object" ? b.meta : {},
    };

    if (!row.meta.sid) row.meta.sid = `ingest:${row.id}`;

    if (STRICT_SID && !row.meta?.sid) {
      return res.status(400).json({ ok: false, error: "sid_required" });
    }

    appendResult(row);
    return res.json({ ok: true, id: row.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ----------------- Admin export -----------------
app.get("/api/admin/results", requireReportKey, (req, res) => {
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

app.get("/api/admin/results.csv", requireReportKey, (req, res) => {
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

// ----------------- Start -----------------
app.listen(PORT, () => {
  console.log(`✅ Server started on :${PORT}`);
  console.log(`APP_URL=${APP_URL}`);
  console.log(`STRICT_SID=${STRICT_SID} REQUIRE_TG_AUTH=${REQUIRE_TG_AUTH}`);
  console.log(`REPORT_API_KEY is ${REPORT_API_KEY ? "SET" : "NOT set"}`);
  console.log(`INGEST_API_KEY is ${INGEST_API_KEY ? "SET" : "NOT set"}`);
  pollLoop().catch((e) => console.error("pollLoop fatal:", e));
});

process.on("SIGINT", () => {
  isPolling = false;
  process.exit(0);
});
process.on("SIGTERM", () => {
  isPolling = false;
  process.exit(0);
});
