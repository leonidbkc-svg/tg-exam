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
const REQUIRE_TG_AUTH = String(process.env.REQUIRE_TG_AUTH || "0") === "1";

// IMPORTANT: prefer IPv4 first
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

function uid(prefix = "res_") {
  return prefix + crypto.randomBytes(8).toString("hex");
}

function appendResult(row) {
  const store = readStore();
  store.results.push(row);
  atomicWrite(RESULTS_FILE, JSON.stringify(store, null, 2));
}

function listResults({ fromTs, toTs, tgId } = {}) {
  const store = readStore();
  let arr = store.results.slice();

  if (typeof fromTs === "number") arr = arr.filter((r) => (r.ts || 0) >= fromTs);
  if (typeof toTs === "number") arr = arr.filter((r) => (r.ts || 0) <= toTs);
  if (tgId) arr = arr.filter((r) => String(r.tg_id || "") === String(tgId));

  return arr;
}

function toCsv(results) {
  const headers = [
    "id","ts","date_iso",
    "exam_id","exam_title",
    "tg_id","tg_username","tg_first_name","tg_last_name",
    "score","max_score","percent","passed",
    "duration_sec",
    "answers_json","meta_json",
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

// ----------------- Auth -----------------
function requireReportKey(req, res, next) {
  const key = req.query.api_key || req.headers["x-api-key"];
  if (!REPORT_API_KEY || String(key || "") !== REPORT_API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

function requireIngestKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (!INGEST_API_KEY || String(key || "") !== INGEST_API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

function safeBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

// ----------------- Express -----------------
ensureDataDir();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));
app.use(express.static(path.join(__dirname, "public")));

// ---- INGEST results (server / python) ----
app.post("/api/results", requireIngestKey, (req, res) => {
  try {
    const b = req.body || {};
    const tg = b.tg || {};

    const score = Number.isFinite(+b.score) ? +b.score : 0;
    const maxScore = Number.isFinite(+b.max_score) ? +b.max_score : 0;
    const percent = maxScore > 0 ? Math.round((score / maxScore) * 1000) / 10 : 0;

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

      answers: Array.isArray(b.answers) ? b.answers : [],
      meta: b.meta && typeof b.meta === "object" ? b.meta : {},
    };

    if (!row.meta.sid) {
      row.meta.sid = `ingest:${row.id}`;
    }

    if (STRICT_SID && !row.meta.sid) {
      return res.status(400).json({ ok: false, error: "sid_required" });
    }

    appendResult(row);
    return res.json({ ok: true, id: row.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---- admin export ----
app.get("/api/admin/results", requireReportKey, (req, res) => {
  const from = req.query.from ? Number(req.query.from) : undefined;
  const to = req.query.to ? Number(req.query.to) : undefined;
  const tgId = req.query.tg_id ? String(req.query.tg_id) : undefined;

  const results = listResults({ fromTs: from, toTs: to, tgId });
  res.json({ ok: true, count: results.length, results });
});

app.get("/api/admin/results.csv", requireReportKey, (req, res) => {
  const from = req.query.from ? Number(req.query.from) : undefined;
  const to = req.query.to ? Number(req.query.to) : undefined;
  const tgId = req.query.tg_id ? String(req.query.tg_id) : undefined;

  const results = listResults({ fromTs: from, toTs: to, tgId });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="results.csv"');
  res.send(toCsv(results));
});

// ----------------- Start -----------------
app.listen(PORT, () => {
  console.log(`✅ Server started on :${PORT}`);
  console.log(`APP_URL=${APP_URL}`);
  console.log(`STRICT_SID=${STRICT_SID} REQUIRE_TG_AUTH=${REQUIRE_TG_AUTH}`);
  console.log(`REPORT_API_KEY=${REPORT_API_KEY ? "SET" : "NOT set"}`);
  console.log(`INGEST_API_KEY=${INGEST_API_KEY ? "SET" : "NOT set"}`);
});
