const tg = window.Telegram?.WebApp;
tg?.expand?.();

const TEST_DURATION_SEC = 5 * 60;
const AUTO_FINISH_AT = 3;

let sid = "";
let fio = "";

let blurCount = 0;
let hiddenCount = 0;
let leaveCount = 0;

let isHiddenCycle = false;
let startedAt = 0;

let timeLeft = TEST_DURATION_SEC;
let timerId = null;

let testStarted = false;
let finished = false;

let questions = [];

function $(id) { return document.getElementById(id); }

function getSidFromUrl() {
  const sp = new URLSearchParams(window.location.search);
  return (sp.get("sid") || "").trim();
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

/**
 * ✅ Telegram initData (подпись Telegram)
 * Сервер будет валидировать и привязывать sid к user.id
 */
function getInitData() {
  return tg?.initData || "";
}
function getInitUserIdUnsafe() {
  return tg?.initDataUnsafe?.user?.id ?? null;
}

/* модал вместо alert */
function showModal(title, text, btnText = "Понятно") {
  $("modalTitle").textContent = title;
  $("modalText").textContent = text;
  $("modalBtn").textContent = btnText;
  $("modalBackdrop").style.display = "flex";
}
function hideModal() {
  $("modalBackdrop").style.display = "none";
}
$("modalBtn").addEventListener("click", hideModal);

/* предупреждение */
let warnTimer = null;
function showWarning(title, subtitle = "", ms = 2200) {
  const box = $("warnBox");
  box.innerHTML = `${title}${subtitle ? `<small>${subtitle}</small>` : ""}`;
  box.style.display = "block";
  if (warnTimer) clearTimeout(warnTimer);
  warnTimer = setTimeout(() => (box.style.display = "none"), ms);
}

/** postJSON: beacon можно только когда ответ не нужен */
function postJSON(url, data, { beacon = true } = {}) {
  const body = JSON.stringify(data ?? {});
  if (beacon && navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    const ok = navigator.sendBeacon(url, blob);
    if (ok) return Promise.resolve({ ok: true, beacon: true });
  }
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true
  }).then(r => r.json()).catch(() => ({ ok: false }));
}

async function postEvent(type, payload) {
  if (!sid) return { ok: false };

  // ✅ добавили initData + userIdUnsafe (на сервере userIdUnsafe не доверяется, только для логов)
  return postJSON(
    "/api/event",
    {
      sid,
      type,
      payload: payload || {},
      ts: Date.now(),
      initData: getInitData(),
      initUserIdUnsafe: getInitUserIdUnsafe()
    },
    { beacon: true }
  );
}

/* sid: URL -> sessionStorage -> /api/new-session (ТОЛЬКО fetch) */
async function ensureSid() {
  const fromUrl = getSidFromUrl();
  if (fromUrl) {
    sid = fromUrl;
    sessionStorage.setItem("sid", sid);
    return sid;
  }

  const stored = (sessionStorage.getItem("sid") || "").trim();
  if (stored) {
    sid = stored;
    return sid;
  }

  // 🔙 старое поведение оставляем: сервер может создать sid
  const resp = await postJSON("/api/new-session", {}, { beacon: false });
  if (resp?.ok && resp.sid) {
    sid = String(resp.sid);
    sessionStorage.setItem("sid", sid);
    showWarning("ℹ️ Сеанс создан заново", "Лучше открывать тест через кнопку в боте");
    return sid;
  }

  return "";
}

/* ✅ загрузка вопросов из JSON */
async function loadQuestions() {
  try {
    const res = await fetch(`/questions.json?v=30`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const q = Array.isArray(data?.questions) ? data.questions : [];
    if (!q.length) throw new Error("questions пустой");

    for (const item of q) {
      if (!item?.id || !item?.type || !item?.text || !Array.isArray(item?.options)) {
        throw new Error("неверный формат questions.json");
      }
    }

    questions = q;
    $("metaPill").textContent = `ИСМП • ${questions.length} вопросов`;
    return true;
  } catch (e) {
    console.error("loadQuestions failed:", e?.message || e);
    showModal("Ошибка", "Не удалось загрузить вопросы. Проверьте questions.json на сервере.", "Ок");
    return false;
  }
}

function renderQuestions() {
  const root = $("questions");
  root.innerHTML = "";

  questions.forEach((q, idx) => {
    const block = document.createElement("div");
    block.className = "q";

    const title = document.createElement("div");
    title.className = "q-title";
    title.textContent = `${idx + 1}. ${q.text}`;
    block.appendChild(title);

    const answers = document.createElement("div");
    answers.className = "answers";

    q.options.forEach(opt => {
      const lab = document.createElement("label");

      const inp = document.createElement("input");
      inp.type = (q.type === "single") ? "radio" : "checkbox";
      inp.name = q.id;
      inp.value = opt.id;

      const txt = document.createElement("div");
      txt.textContent = opt.text;

      lab.appendChild(inp);
      lab.appendChild(txt);
      answers.appendChild(lab);
    });

    block.appendChild(answers);
    root.appendChild(block);
  });
}

function getAnswersMap() {
  const res = {};
  questions.forEach(q => {
    if (q.type === "single") {
      const checked = document.querySelector(`input[name="${q.id}"]:checked`);
      res[q.id] = checked ? [checked.value] : [];
    } else {
      const checked = Array.from(document.querySelectorAll(`input[name="${q.id}"]:checked`));
      res[q.id] = checked.map(x => x.value);
    }
  });
  return res;
}

function calcScore(answersMap) {
  let score = 0;
  questions.forEach(q => {
    const correctIds = q.options.filter(o => o.correct).map(o => o.id).sort();
    const userIds = (answersMap[q.id] || []).slice().sort();

    if (q.type === "single") {
      if (userIds.length === 1 && correctIds.length === 1 && userIds[0] === correctIds[0]) score += 1;
    } else {
      if (userIds.length === correctIds.length && userIds.every((v, i) => v === correctIds[i])) score += 1;
    }
  });
  return score;
}

function startTimer() {
  $("timerPill").textContent = `⏱ ${formatTime(timeLeft)}`;
  timerId = setInterval(() => {
    if (finished) return;
    timeLeft -= 1;
    if (timeLeft <= 0) {
      timeLeft = 0;
      $("timerPill").textContent = `⏱ 00:00`;
      finishTest({ reason: "time_up" });
      return;
    }
    $("timerPill").textContent = `⏱ ${formatTime(timeLeft)}`;
  }, 1000);
}
function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
}

/* ✅ Считаем уход ТОЛЬКО по hidden (честно) */
async function registerHiddenLeave() {
  if (!testStarted || finished) return;

  hiddenCount += 1;
  leaveCount += 1;

  const resp = await postEvent("hidden", { fio, blurCount, hiddenCount, leaveCount });

  if (leaveCount >= AUTO_FINISH_AT || resp?.shouldFinish) {
    await finishTest({ reason: "too_many_violations" });
  }
}

/* blur только логируем, не считаем попыткой */
async function logBlurOnly() {
  if (!testStarted || finished) return;
  blurCount += 1;
  await postEvent("blur", { fio, blurCount, hiddenCount, leaveCount });
}

async function startTest() {
  fio = $("fio").value.trim();
  if (!fio) return showModal("Ошибка", "Введите ФИО");

  if (!questions.length) {
    const ok = await loadQuestions();
    if (!ok) return;
  }

  await ensureSid();
  if (!sid) return showModal("Ошибка", "Не удалось создать сеанс. Откройте тест через кнопку в боте.");

  $("startScreen").style.display = "none";
  $("testScreen").style.display = "block";

  blurCount = 0;
  hiddenCount = 0;
  leaveCount = 0;
  isHiddenCycle = false;

  timeLeft = TEST_DURATION_SEC;
  testStarted = true;
  finished = false;
  startedAt = Date.now();

  renderQuestions();
  startTimer();

  const r = await postEvent("start", { fio });
  if (r?.ok === false && (r?.error === "initData_required" || r?.error === "user_mismatch" || r?.error === "bad_initData")) {
    // сервер включил жёсткий режим — покажем понятное сообщение
    showModal("Доступ ограничен", "Откройте тест через кнопку в боте и не пересылайте ссылку другим.", "Ок");
  }

  $("note").textContent = "Не закрывайте приложение до завершения теста.";
}

function disableAllInputs() {
  document.querySelectorAll("input, button").forEach(el => {
    if (el.id === "closeBtn" || el.id === "modalBtn") return;
    el.disabled = true;
  });
}

async function finishTest({ reason = "manual" } = {}) {
  if (!testStarted || finished) return;

  finished = true;
  stopTimer();

  const answers = getAnswersMap();
  const score = calcScore(answers);
  const total = questions.length;
  const spentSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));

  disableAllInputs();

  // ✅ добавили initData в submit
  const resp = await postJSON("/api/submit", {
    sid, fio, score, total, reason,
    blurCount, hiddenCount, leaveCount,
    spentSec,
    initData: getInitData(),
    initUserIdUnsafe: getInitUserIdUnsafe()
  }, { beacon: false });

  if (resp?.ok === false && (resp?.error === "initData_required" || resp?.error === "user_mismatch" || resp?.error === "bad_initData")) {
    showModal("Доступ ограничен", "Откройте тест через кнопку в боте и не пересылайте ссылку другим.", "Ок");
    return;
  }

  const text =
    reason === "too_many_violations"
      ? `Тест завершён автоматически (3-й уход).\nРезультат: ${score}/${total}`
      : reason === "time_up"
        ? `Время вышло.\nРезультат: ${score}/${total}`
        : `Тест завершён.\nРезультат: ${score}/${total}`;

  showModal("Готово", text, "Ок");

  $("note").textContent = `Ваш результат: ${score}/${total}`;
  $("finishBtn").style.display = "none";
  $("closeBtn").style.display = "block";
}

/* события */
document.addEventListener("visibilitychange", () => {
  if (!testStarted || finished) return;

  if (document.hidden) {
    if (!isHiddenCycle) {
      isHiddenCycle = true;
      registerHiddenLeave();
    }
  } else {
    if (isHiddenCycle) {
      isHiddenCycle = false;
      showWarning("⚠️ Возврат в тест зафиксирован", `Уходов: ${leaveCount} из ${AUTO_FINISH_AT}`);
    }
  }
});

window.addEventListener("blur", () => {
  if (!testStarted || finished) return;
  if (document.hidden || isHiddenCycle) return;
  logBlurOnly();
});

$("startBtn").addEventListener("click", startTest);
$("finishBtn").addEventListener("click", () => finishTest({ reason: "manual" }));
$("closeBtn").addEventListener("click", () => tg?.close?.());

// init
(async () => {
  await ensureSid();
  await loadQuestions();
})();
