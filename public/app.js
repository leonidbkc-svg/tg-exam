const tg = window.Telegram?.WebApp;
tg?.expand?.();

const TEST_DURATION_SEC = 5 * 60;
const AUTO_FINISH_AT = 3;

const QUESTIONS_PER_TEST = 10;
const PASS_RATE = 0.70; // 70%

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

let allQuestions = [];   // полный пул из JSON (30)
let questions = [];      // активные вопросы текущего теста (10)

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

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickTestQuestions(pool, n) {
  const copy = pool.map(q => ({
    ...q,
    options: q.options.map(o => ({ ...o }))
  }));
  shuffleInPlace(copy);
  const picked = copy.slice(0, Math.min(n, copy.length));
  for (const q of picked) shuffleInPlace(q.options); // мешаем ответы
  return picked;
}

function getPassNeed(total) {
  return Math.ceil(total * PASS_RATE);
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
  return postJSON("/api/event", { sid, type, payload: payload || {}, ts: Date.now() }, { beacon: true });
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

  const resp = await postJSON("/api/new-session", {}, { beacon: false });
  if (resp?.ok && resp.sid) {
    sid = String(resp.sid);
    sessionStorage.setItem("sid", sid);
    // ✅ убрали всплывающее/предупреждение при создании нового сеанса
    return sid;
  }

  return "";
}

/* ✅ загрузка вопросов из JSON (в allQuestions) */
async function loadQuestions() {
  try {
    const res = await fetch(`/questions.json?v=31`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const q = Array.isArray(data?.questions) ? data.questions : [];
    if (!q.length) throw new Error("questions пустой");

    for (const item of q) {
      if (!item?.id || !item?.type || !item?.text || !Array.isArray(item?.options)) {
        throw new Error("неверный формат questions.json");
      }
    }

    allQuestions = q;

    // metaPill актуален для теста (10 вопросов)
    $("metaPill").textContent = `ИСМП • ${QUESTIONS_PER_TEST} вопросов`;
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

/* ------------------ 🎉 Confetti (хлопушка) ------------------ */

let confettiRaf = null;

function runConfetti(ms = 1800) {
  const canvas = $("confettiCanvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  canvas.style.display = "block";

  const resize = () => {
    canvas.width = Math.floor(window.innerWidth * (window.devicePixelRatio || 1));
    canvas.height = Math.floor(window.innerHeight * (window.devicePixelRatio || 1));
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
  };
  resize();

  const W = window.innerWidth;
  const H = window.innerHeight;

  const colors = ["#ff3b30","#ffcc00","#34c759","#007aff","#af52de","#ff2d55"];
  const particles = [];
  const N = 140;

  for (let i = 0; i < N; i++) {
    particles.push({
      x: W * 0.5 + (Math.random() - 0.5) * 120,
      y: H * 0.25 + (Math.random() - 0.5) * 30,
      vx: (Math.random() - 0.5) * 10,
      vy: -Math.random() * 8 - 4,
      g: 0.25 + Math.random() * 0.2,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.2,
      w: 6 + Math.random() * 6,
      h: 6 + Math.random() * 10,
      c: colors[Math.floor(Math.random() * colors.length)],
      life: 1
    });
  }

  const t0 = performance.now();
  const tick = (t) => {
    const dt = Math.min(32, t - (tick.last || t));
    tick.last = t;

    ctx.clearRect(0, 0, W, H);

    for (const p of particles) {
      p.vy += p.g;
      p.x += p.vx * (dt / 16);
      p.y += p.vy * (dt / 16);
      p.rot += p.vr * (dt / 16);

      const age = (t - t0) / ms;
      p.life = Math.max(0, 1 - age);

      ctx.save();
      ctx.globalAlpha = p.life;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }

    if (t - t0 < ms) {
      confettiRaf = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(confettiRaf);
      confettiRaf = null;
      canvas.style.display = "none";
      ctx.clearRect(0, 0, W, H);
    }
  };

  window.addEventListener("resize", resize, { once: true });
  confettiRaf = requestAnimationFrame(tick);
}

/* ------------------ Навигация экранов ------------------ */

function showScreen(which) {
  const screens = ["homeScreen", "startScreen", "rulesScreen", "testScreen", "resultScreen"];
  for (const id of screens) {
    const el = $(id);
    if (!el) continue;
    el.style.display = (id === which) ? "block" : "none";
  }
}

function goHome() {
  showScreen("homeScreen");
}

function goStudentStart() {
  showScreen("startScreen");
}

/* ------------------ Новый flow: ФИО -> Правила -> Тест ------------------ */

function goRules() {
  fio = $("fio").value.trim();
  if (!fio) return showModal("Ошибка", "Введите ФИО");

  const passNeed = getPassNeed(QUESTIONS_PER_TEST);
  $("passNeed").textContent = String(passNeed);

  showScreen("rulesScreen");
}

async function beginTest() {
  if (!fio) fio = $("fio").value.trim();
  if (!fio) return showModal("Ошибка", "Введите ФИО");

  if (!allQuestions.length) {
    const ok = await loadQuestions();
    if (!ok) return;
  }

  await ensureSid();
  if (!sid) return showModal("Ошибка", "Не удалось создать сеанс. Откройте тест через кнопку в боте.");

  // выбираем 10 случайных вопросов + мешаем варианты
  questions = pickTestQuestions(allQuestions, QUESTIONS_PER_TEST);
  sessionStorage.setItem("activeQuestions", JSON.stringify(questions));

  showScreen("testScreen");

  blurCount = 0;
  hiddenCount = 0;
  leaveCount = 0;
  isHiddenCycle = false;

  timeLeft = TEST_DURATION_SEC;
  testStarted = true;
  finished = false;
  startedAt = Date.now();

  $("metaPill").textContent = `ИСМП • ${questions.length} вопросов`;

  renderQuestions();
  startTimer();

  await postEvent("start", { fio });

  // убрали нижнюю “инфу” под кнопками в тесте
  $("note").textContent = "";
}

function disableAllInputs() {
  document.querySelectorAll("input, button").forEach(el => {
    // оставим возможность закрывать модал, если он вдруг открыт
    if (el.id === "modalBtn") return;
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

  await postJSON("/api/submit", {
    sid, fio, score, total, reason,
    blurCount, hiddenCount, leaveCount,
    spentSec
  }, { beacon: false });

  const passNeed = getPassNeed(total);
  let passed = score >= passNeed;

  // если авто-завершение по нарушениям — считаем “не сдал” всегда
  if (reason === "too_many_violations") passed = false;

  // 🎉 конфетти только если успешно и завершил вручную
  if (passed && reason === "manual") runConfetti(1800);

  // Экран результата вместо модалки
  showScreen("resultScreen");

  const pct = total > 0 ? Math.round((score / total) * 100) : 0;

  if (reason === "too_many_violations") {
    $("resultTitle").textContent = "🚨 Экзамен завершён автоматически";
    $("resultSubtitle").textContent = "Причина: превышено количество уходов из теста.";
  } else if (reason === "time_up") {
    $("resultTitle").textContent = passed ? "✅ Экзамен сдан" : "❌ Экзамен не сдан";
    $("resultSubtitle").textContent = "Время истекло. Ответы зафиксированы.";
  } else {
    $("resultTitle").textContent = passed ? "✅ Экзамен сдан" : "❌ Экзамен не сдан";
    $("resultSubtitle").textContent = passed
      ? "Поздравляем! Результат выше порога."
      : "Результат ниже порога. Попробуйте ещё раз.";
  }

  $("resultPill").textContent = `Результат: ${score}/${total} (${pct}%) • Порог: ${passNeed}/${total}`;

  const reasonMap = {
    manual: "завершено вручную",
    time_up: "время вышло",
    too_many_violations: "3-й уход"
  };

  $("resultMeta").textContent =
    `ФИО: ${fio}\n` +
    `Уходов: ${leaveCount} (blur=${blurCount}, hidden=${hiddenCount})\n` +
    `Причина: ${reasonMap[reason] || reason}`;

  // милый маскот только если успешно и не нарушения
  $("mascotWrap").style.display = (passed && reason !== "too_many_violations") ? "block" : "none";
}

/* события анти-чита */
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

/* кнопки */
$("btnStudents").addEventListener("click", () => goStudentStart());
$("btnResidents").addEventListener("click", () => showModal("Скоро", "Раздел для ординаторов в разработке.", "Ок"));
$("btnStaff").addEventListener("click", () => showModal("Скоро", "Раздел для сотрудников центра в разработке.", "Ок"));
$("backHomeBtn").addEventListener("click", () => goHome());

$("startBtn").addEventListener("click", goRules);
$("rulesAgreeBtn").addEventListener("click", beginTest);
$("rulesBackBtn").addEventListener("click", () => showScreen("startScreen"));

$("finishBtn").addEventListener("click", () => finishTest({ reason: "manual" }));

// старую кнопку closeBtn оставляем (не ломаем), но она теперь не основная
$("closeBtn").addEventListener("click", () => tg?.close?.());
$("resultCloseBtn").addEventListener("click", () => tg?.close?.());

/* init */
(async () => {
  await ensureSid();
  await loadQuestions(); // заранее подгружаем, чтобы при старте не ждать

  // если страницу перезагрузили во время теста — сохраним набор вопросов (но не продолжаем автоматически)
  const stored = sessionStorage.getItem("activeQuestions");
  if (stored) {
    try { questions = JSON.parse(stored) || []; } catch {}
  }

  showScreen("homeScreen");
})();
