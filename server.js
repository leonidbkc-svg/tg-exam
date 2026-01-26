// ----------------- Sessions API (needed by public/app.js) -----------------
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 6 * 60 * 60 * 1000); // 6h
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

function ensureSessionsFile() {
  ensureDataDir();
  if (!fs.existsSync(SESSIONS_FILE)) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: [] }, null, 2), "utf-8");
  }
}
function readSessionsStore() {
  ensureSessionsFile();
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, "utf-8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return { sessions: [] };
    if (!Array.isArray(obj.sessions)) obj.sessions = [];
    return obj;
  } catch {
    return { sessions: [] };
  }
}
function writeSessionsStore(store) {
  atomicWrite(SESSIONS_FILE, JSON.stringify(store, null, 2));
}
function getClientIp(req) {
  return (
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    String(req.socket?.remoteAddress || "")
  );
}
function cleanupSessions() {
  try {
    const st = readSessionsStore();
    const now = Date.now();
    st.sessions = st.sessions.filter((s) => now - (s.updatedAt || s.createdAt || now) <= SESSION_TTL_MS);
    writeSessionsStore(st);
  } catch {}
}
setInterval(cleanupSessions, 10 * 60 * 1000).unref?.();

// POST /api/new-session -> { ok:true, sid }
app.post("/api/new-session", (req, res) => {
  try {
    const sid = uid("sid_");
    const st = readSessionsStore();
    const now = Date.now();
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

// POST /api/event  { sid, type, payload, ts } -> { ok:true, shouldFinish? }
app.post("/api/event", (req, res) => {
  try {
    const b = req.body || {};
    const sid = String(b.sid || "").trim();
    const type = String(b.type || "").trim();
    const payload = b.payload && typeof b.payload === "object" ? b.payload : {};
    if (!sid || !type) return res.status(400).json({ ok: false, error: "bad_request" });

    const st = readSessionsStore();
    const s = st.sessions.find((x) => x.sid === sid);
    if (!s) return res.status(404).json({ ok: false, error: "unknown_sid" });

    // update counters if they come from client
    if (payload.fio) s.fio = String(payload.fio).slice(0, 160);
    if (Number.isFinite(+payload.blurCount)) s.blurCount = +payload.blurCount;
    if (Number.isFinite(+payload.hiddenCount)) s.hiddenCount = +payload.hiddenCount;
    if (Number.isFinite(+payload.leaveCount)) s.leaveCount = +payload.leaveCount;

    s.updatedAt = Date.now();
    if (!s.startedAt && type === "start") s.startedAt = Date.now();

    writeSessionsStore(st);

    // AUTO_FINISH_AT = 3 в фронте
    const shouldFinish = Number(s.leaveCount || 0) >= 3;
    return res.json({ ok: true, shouldFinish });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /api/submit -> записывает РЕЗУЛЬТАТ в results.json (через appendResult)
app.post("/api/submit", (req, res) => {
  try {
    const b = req.body || {};
    const sid = String(b.sid || "").trim();
    if (!sid) return res.status(400).json({ ok: false, error: "sid_required" });

    const fio = String(b.fio || "").trim().slice(0, 160);
    const score = Number.isFinite(+b.score) ? +b.score : 0;
    const total = Number.isFinite(+b.total) ? +b.total : 0;
    const reason = String(b.reason || "manual");
    const spentSec = Number.isFinite(+b.spentSec) ? +b.spentSec : null;

    const blurCount = Number.isFinite(+b.blurCount) ? +b.blurCount : 0;
    const hiddenCount = Number.isFinite(+b.hiddenCount) ? +b.hiddenCount : 0;
    const leaveCount = Number.isFinite(+b.leaveCount) ? +b.leaveCount : 0;

    // отметим в sessions.json
    const st = readSessionsStore();
    const s = st.sessions.find((x) => x.sid === sid);
    if (s) {
      s.fio = fio || s.fio || "";
      s.finishedAt = Date.now();
      s.updatedAt = Date.now();
      s.lastReason = reason;
      s.blurCount = blurCount;
      s.hiddenCount = hiddenCount;
      s.leaveCount = leaveCount;
      writeSessionsStore(st);
    }

    // пишем итог в results.json (тот же формат, что ты уже экспортируешь)
    const maxScore = total;
    const percent = maxScore > 0 ? Math.round((score / maxScore) * 1000) / 10 : 0;

    const row = {
      id: uid("res_"),
      ts: Date.now(),
      date_iso: new Date().toISOString(),
      exam_id: "ismps",               // можно поменять на твой id теста
      exam_title: "Тест по ИСМП",     // можно поменять
      tg_id: "", tg_username: "", tg_first_name: "", tg_last_name: "",
      score,
      max_score: maxScore,
      percent,
      passed: reason === "too_many_violations" ? false : (maxScore > 0 ? (score / maxScore) >= 0.7 : false),
      duration_sec: spentSec,
      answers: [], // фронт не шлёт ответы; если захочешь — добавим
      meta: {
        sid,
        fio,
        reason,
        blurCount,
        hiddenCount,
        leaveCount,
        ip: getClientIp(req),
        user_agent: String(req.headers["user-agent"] || ""),
        source: "webapp_submit",
      },
    };

    if (STRICT_SID && !row.meta.sid) {
      return res.status(400).json({ ok: false, error: "sid_required" });
    }

    appendResult(row);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /api/retake-request -> заглушка, чтобы UI не падал
app.post("/api/retake-request", async (req, res) => {
  try {
    const b = req.body || {};
    const sid = String(b.sid || "").trim();
    if (!sid) return res.status(400).json({ ok: false, error: "sid_required" });

    // (опционально) можно уведомлять админа через tgSend, если ADMIN_TG_ID задан
    // await tgSend(ADMIN_TG_ID, `📩 Запрос пересдачи\nsid=${sid}\nФИО=${b.fio || "-"}`);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
