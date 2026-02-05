const tg = window.Telegram?.WebApp;
tg?.expand?.();

const TEST_DURATION_SEC = 10 * 60;
const AUTO_FINISH_AT = 3;

const QUESTIONS_PER_TEST = 15;
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

let allQuestions = [];   // РїРѕР»РЅС‹Р№ РїСѓР» РёР· JSON (30)
let questions = [];      // Р°РєС‚РёРІРЅС‹Рµ РІРѕРїСЂРѕСЃС‹ С‚РµРєСѓС‰РµРіРѕ С‚РµСЃС‚Р° (10)

let lastResult = null;
let watermarkStamp = "";
let modalResolve = null;

// РѕРІРµСЂР»РµР№ вЂњРІРѕР·РІСЂР°С‚ РІ С‚РµСЃС‚вЂќ
let returnOverlayTimer = null;
let returnOverlayHideTimer = null;

function $(id) { return document.getElementById(id); }

function cleanWatermarkText(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function getWatermarkText() {
  const fioText = cleanWatermarkText(fio) || "no-fio";
  const sidTail = cleanWatermarkText(sid).slice(-6) || "nosid";
  const stamp = watermarkStamp || new Date().toISOString().slice(0, 16).replace("T", " ");
  return `${fioText} | ${stamp} | ${sidTail}`;
}

function renderWatermark() {
  const layer = $("watermarkLayer");
  if (!layer) return;

  const text = getWatermarkText();
  const width = Math.max(window.innerWidth, 560);
  const height = Math.max(window.innerHeight, 700);
  const stepX = 260;
  const stepY = 130;

  layer.innerHTML = "";
  let row = 0;
  for (let y = -150; y < height + 180; y += stepY) {
    const offset = row % 2 === 0 ? -80 : 80;
    for (let x = -280 + offset; x < width + 300; x += stepX) {
      const el = document.createElement("div");
      el.className = "watermark-item";
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.textContent = text;
      layer.appendChild(el);
    }
    row += 1;
  }

  layer.classList.add("active");
}

function hideWatermark() {
  const layer = $("watermarkLayer");
  if (!layer) return;
  layer.classList.remove("active");
  layer.innerHTML = "";
}

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

/* вњ… СѓРјРЅС‹Р№ (Р±Р°Р»Р°РЅСЃРЅС‹Р№) СЂР°РЅРґРѕРј */
function pickBalancedQuestions(pool, total) {
  const n = pool.length;
  if (n <= total) return pickTestQuestions(pool, total);

  const partSize = Math.floor(n / 3);

  const first = pool.slice(0, partSize);
  const middle = pool.slice(partSize, partSize * 2);
  const last = pool.slice(partSize * 2);

  const perBlock = Math.floor(total / 3);
  let picked = [];

  picked = picked.concat(pickTestQuestions(first, perBlock));
  picked = picked.concat(pickTestQuestions(middle, perBlock));
  picked = picked.concat(
    pickTestQuestions(last, total - picked.length)
  );

  // С„РёРЅР°Р»СЊРЅС‹Р№ shuffle, С‡С‚РѕР±С‹ РЅРµ С€Р»Рё Р±Р»РѕРєР°РјРё
  shuffleInPlace(picked);
  return picked;
}

function pickTestQuestions(pool, n) {
  const copy = pool.map(q => ({
    ...q,
    options: q.options.map(o => ({ ...o }))
  }));
  shuffleInPlace(copy);
  const picked = copy.slice(0, Math.min(n, copy.length));
  for (const q of picked) shuffleInPlace(q.options);
  return picked;
}

function getPassNeed(total) {
  return Math.ceil(total * PASS_RATE);
}

/* РјРѕРґР°Р» РІРјРµСЃС‚Рѕ alert */
function showModal(title, text, btnText = "Понятно") {
  modalResolve = null;
  $("modalTitle").textContent = title;
  $("modalText").textContent = text;
  $("modalBtn").textContent = btnText;
  $("modalCancel").style.display = "none";
  $("modalBackdrop").style.display = "flex";
}
function confirmModal(title, text, okText = "Да, завершить", cancelText = "Отмена") {
  return new Promise((resolve) => {
    modalResolve = resolve;
    $("modalTitle").textContent = title;
    $("modalText").textContent = text;
    $("modalBtn").textContent = okText;
    $("modalCancel").textContent = cancelText;
    $("modalCancel").style.display = "inline-block";
    $("modalBackdrop").style.display = "flex";
  });
}
function hideModal() {
  $("modalBackdrop").style.display = "none";
}
$("modalBtn").addEventListener("click", () => {
  if (typeof modalResolve === "function") {
    const resolve = modalResolve;
    modalResolve = null;
    hideModal();
    resolve(true);
    return;
  }
  hideModal();
});
$("modalCancel").addEventListener("click", () => {
  if (typeof modalResolve === "function") {
    const resolve = modalResolve;
    modalResolve = null;
    hideModal();
    resolve(false);
    return;
  }
  hideModal();
});

/* вњ… РѕРІРµСЂР»РµР№ вЂњРІРѕР·РІСЂР°С‚/РІС‹С…РѕРґ Р·Р°С„РёРєСЃРёСЂРѕРІР°РЅвЂќ */
function showReturnOverlay() {
  const backdrop = $("returnBackdrop");
  const title = $("returnTitle");
  const text = $("returnText");

  const left = Math.max(0, AUTO_FINISH_AT - leaveCount);

  title.textContent = "Выход из теста зафиксирован";
  text.textContent =
    `Уходов: ${leaveCount} из ${AUTO_FINISH_AT}\n` +
    (left > 0 ? `Осталось попыток: ${left}` : `Дальше - автозавершение`);

  backdrop.classList.remove("fadeout");
  backdrop.style.display = "flex";

  if (returnOverlayTimer) clearTimeout(returnOverlayTimer);
  if (returnOverlayHideTimer) clearTimeout(returnOverlayHideTimer);

  returnOverlayTimer = setTimeout(() => {
    backdrop.classList.add("fadeout");
  }, 4200);

  returnOverlayHideTimer = setTimeout(() => {
    backdrop.style.display = "none";
    backdrop.classList.remove("fadeout");
  }, 5000);
}

/** postJSON */
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

/* sid */
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
    return sid;
  }

  return "";
}

/* вњ… Р·Р°РіСЂСѓР·РєР° РІРѕРїСЂРѕСЃРѕРІ */
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

    if (q.type !== "single") {
      const multiHint = document.createElement("div");
      multiHint.className = "muted";
      multiHint.style.marginTop = "0";
      multiHint.style.marginBottom = "8px";
      multiHint.textContent = "Выберите несколько вариантов ответа";
      block.appendChild(multiHint);
    }

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

/* вњ… СѓС…РѕРґ С‚РѕР»СЊРєРѕ hidden */
async function registerHiddenLeave() {
  if (!testStarted || finished) return;

  hiddenCount += 1;
  leaveCount += 1;

  const resp = await postEvent("hidden", { fio, blurCount, hiddenCount, leaveCount });

  if (leaveCount >= AUTO_FINISH_AT || resp?.shouldFinish) {
    await finishTest({ reason: "too_many_violations" });
  }
}

async function logBlurOnly() {
  if (!testStarted || finished) return;
  blurCount += 1;
  await postEvent("blur", { fio, blurCount, hiddenCount, leaveCount });
}

/* ------------------ рџЋ‰ Confetti ------------------ */

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

/* ------------------ РќР°РІРёРіР°С†РёСЏ ------------------ */

function showScreen(which) {
  const screens = ["homeScreen", "startScreen", "rulesScreen", "testScreen", "resultScreen"];
  for (const id of screens) {
    const el = $(id);
    if (!el) continue;
    el.style.display = (id === which) ? "block" : "none";
  }
}

function goHome() { showScreen("homeScreen"); }
function goStudentStart() { showScreen("startScreen"); }

/* ------------------ Flow ------------------ */

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

  questions = pickBalancedQuestions(allQuestions, QUESTIONS_PER_TEST);
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
  watermarkStamp = new Date(startedAt).toISOString().slice(0, 16).replace("T", " ");

  $("metaPill").textContent = `ИСМП • ${questions.length} вопросов`;

  renderWatermark();
  renderQuestions();
  startTimer();

  await postEvent("start", { fio });

  $("note").textContent = "";
}

function disableTestInputsOnly() {
  const test = $("testScreen");
  if (!test) return;
  test.querySelectorAll("input, button").forEach(el => {
    if (el.id === "modalBtn") return;
    el.disabled = true;
  });
}

async function requestRetake() {
  const btn = $("retakeBtn");
  if (!lastResult?.sid || !sid) return;

  btn.disabled = true;
  btn.textContent = "⏳ Отправляем запрос...";

  const resp = await postJSON("/api/retake-request", {
    sid,
    fio,
    score: lastResult.score,
    total: lastResult.total,
    reason: lastResult.reason
  }, { beacon: false });

  if (resp?.ok) {
    btn.textContent = "✅ Запрос отправлен";
    showModal("Запрос отправлен", "Экзаменатор получит запрос на пересдачу. Если пересдача будет одобрена, вам придет новая кнопка в чате.", "Ок");
  } else {
    btn.disabled = false;
    btn.textContent = "📩 Запросить пересдачу";
    showModal("Ошибка", "Не удалось отправить запрос на пересдачу. Попробуйте еще раз.", "Ок");
  }
}

async function finishTest({ reason = "manual" } = {}) {
  if (!testStarted || finished) return;

  finished = true;
  stopTimer();
  hideWatermark();

  const answers = getAnswersMap();
  const score = calcScore(answers);
  const total = questions.length;
  const spentSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));

  disableTestInputsOnly();

  await postJSON("/api/submit", {
    sid, fio, score, total, reason,
    blurCount, hiddenCount, leaveCount,
    spentSec
  }, { beacon: false });

  const passNeed = getPassNeed(total);
  let passed = score >= passNeed;
  if (reason === "too_many_violations") passed = false;

  if (passed && reason === "manual") runConfetti(1800);

  showScreen("resultScreen");

  const pct = total > 0 ? Math.round((score / total) * 100) : 0;

  const titleEl = $("resultTitle");
  const subEl = $("resultSubtitle");
  const mascot = $("mascotWrap");
  const scoreEl = $("resultScore");

  scoreEl.textContent = `${score}/${total} (${pct}%)`;

  if (passed && reason !== "too_many_violations") {
    titleEl.textContent = "✅ Экзамен сдан";
    subEl.textContent = "Поздравляем! 🎉";
    mascot.style.display = "block";
    $("retakeBtn").style.display = "none";
  } else {
    if (reason === "too_many_violations") {
      titleEl.textContent = "🚨 Экзамен завершен автоматически";
      subEl.textContent = "Выходы из теста зафиксированы.";
    } else if (reason === "time_up") {
      titleEl.textContent = "❌ Экзамен не сдан";
      subEl.textContent = "Время истекло.";
    } else {
      titleEl.textContent = "❌ Экзамен не сдан";
      subEl.textContent = "Попробуйте еще раз.";
    }

    mascot.style.display = "none";

    const retakeBtn = $("retakeBtn");
    if (reason !== "too_many_violations") {
      retakeBtn.style.display = "block";
      retakeBtn.disabled = false;
      retakeBtn.textContent = "📩 Запросить пересдачу";
    } else {
      retakeBtn.style.display = "none";
    }
  }

  lastResult = { sid, fio, score, total, reason, passed, pct };
}

/* Р°РЅС‚Рё-С‡РёС‚ */
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
      showReturnOverlay();
    }
  }
});

window.addEventListener("blur", () => {
  if (!testStarted || finished) return;
  if (document.hidden || isHiddenCycle) return;
  logBlurOnly();
});

window.addEventListener("resize", () => {
  if (!testStarted || finished) return;
  renderWatermark();
});

/* Buttons */
$("btnStudents").addEventListener("click", () => goStudentStart());
$("btnResidents").addEventListener("click", () => showModal("Скоро", "Раздел для ординаторов в разработке.", "Ок"));
$("btnStaff").addEventListener("click", () => showModal("Скоро", "Раздел для сотрудников центра в разработке.", "Ок"));
$("backHomeBtn").addEventListener("click", () => goHome());

$("startBtn").addEventListener("click", goRules);
$("rulesAgreeBtn").addEventListener("click", beginTest);
$("rulesBackBtn").addEventListener("click", () => showScreen("startScreen"));

$("finishBtn").addEventListener("click", async () => {
  if (!testStarted || finished) return;
  const ok = await confirmModal(
    "Подтверждение",
    "Вы точно хотите завершить тест? После этого ответы изменить нельзя.",
    "Да, завершить",
    "Отмена"
  );
  if (!ok) return;
  finishTest({ reason: "manual" });
});

$("closeBtn").addEventListener("click", () => tg?.close?.());
$("resultCloseBtn").addEventListener("click", () => tg?.close?.());

$("retakeBtn").addEventListener("click", requestRetake);

/* init */
(async () => {
  await ensureSid();
  await loadQuestions();

  const stored = sessionStorage.getItem("activeQuestions");
  if (stored) {
    try { questions = JSON.parse(stored) || []; } catch {}
  }

  showScreen("homeScreen");
})();



