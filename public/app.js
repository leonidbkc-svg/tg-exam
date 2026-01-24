const tg = window.Telegram?.WebApp;
tg?.expand?.();

const TEST_DURATION_SEC = 5 * 60;
const AUTO_FINISH_AT = 3;

let sid = "";
let fio = "";

let blurCount = 0;
let hiddenCount = 0;
let leaveCount = 0;

let isHiddenCycle = false; // ✅ один "цикл ухода"
let startedAt = 0;

let timeLeft = TEST_DURATION_SEC;
let timerId = null;

let testStarted = false;
let finished = false;

const questions = [
  { id: "q1", type: "single", text: "ИСМП — это…", options: [
    { id: "a", text: "инфекции, связанные с оказанием медицинской помощи", correct: true },
    { id: "b", text: "инфекции, передающиеся половым путём", correct: false },
    { id: "c", text: "инфекции пищевого происхождения", correct: false },
    { id: "d", text: "внутрибольничные аллергии", correct: false }
  ]},
  { id: "q2", type: "single", text: "Главная цель профилактики ИСМП — это…", options: [
    { id: "a", text: "снижение риска инфицирования пациентов и персонала", correct: true },
    { id: "b", text: "увеличение количества процедур", correct: false },
    { id: "c", text: "ускорение выписки пациентов", correct: false },
    { id: "d", text: "уменьшение затрат на питание", correct: false }
  ]},
  { id: "q3", type: "single", text: "Наиболее эффективная мера профилактики ИСМП — это…", options: [
    { id: "a", text: "ношение перчаток всегда и везде", correct: false },
    { id: "b", text: "гигиена рук по показаниям", correct: true },
    { id: "c", text: "проветривание палат каждые 2 часа", correct: false },
    { id: "d", text: "приём витаминов персоналом", correct: false }
  ]},
  { id: "q4", type: "single", text: "К контактному пути передачи ИСМП относится…", options: [
    { id: "a", text: "укус насекомого", correct: false },
    { id: "b", text: "передача через руки/поверхности/инструменты при нарушении режима", correct: true },
    { id: "c", text: "только воздушно-капельная передача", correct: false },
    { id: "d", text: "передача через пищу при любой инфекции", correct: false }
  ]},
  { id: "q5", type: "multi", text: "Выберите НЕСКОЛЬКО мер профилактики ИСМП (несколько правильных):", options: [
    { id: "a", text: "гигиена рук", correct: true },
    { id: "b", text: "стерилизация/дезинфекция инструментов по режимам", correct: true },
    { id: "c", text: "использование СИЗ по показаниям", correct: true },
    { id: "d", text: "отмена уборки для экономии времени", correct: false }
  ]}
];

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

/* ✅ модал вместо alert */
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

/* ✅ плашка предупреждения */
let warnTimer = null;
function showWarning(title, subtitle = "", ms = 2200) {
  const box = $("warnBox");
  box.innerHTML = `${title}${subtitle ? `<small>${subtitle}</small>` : ""}`;
  box.style.display = "block";
  if (warnTimer) clearTimeout(warnTimer);
  warnTimer = setTimeout(() => (box.style.display = "none"), ms);
}

// Надёжная отправка
function sendJSON(url, data) {
  try {
    const body = JSON.stringify(data);
    if (navigator.sendBeacon) {
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
  } catch {
    return Promise.resolve({ ok: false });
  }
}

async function postEvent(type, payload) {
  if (!sid) return { ok: false };
  return sendJSON("/api/event", { sid, type, payload: payload || {}, ts: Date.now() });
}

/* ✅ если sid потерялся — создаём новый */
async function ensureSid() {
  // 1) URL
  const fromUrl = getSidFromUrl();
  if (fromUrl) {
    sid = fromUrl;
    sessionStorage.setItem("sid", sid);
    return sid;
  }

  // 2) sessionStorage
  const stored = (sessionStorage.getItem("sid") || "").trim();
  if (stored) {
    sid = stored;
    return sid;
  }

  // 3) сервер
  const resp = await sendJSON("/api/new-session", {});
  if (resp?.ok && resp.sid) {
    sid = String(resp.sid);
    sessionStorage.setItem("sid", sid);
    // подсказка (не ошибка!)
    showWarning("ℹ️ Сеанс создан заново", "Откройте из бота — будет стабильнее");
    return sid;
  }

  return "";
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

/* ✅ один уход = один leaveCount */
async function registerLeave(kind) {
  if (!testStarted || finished) return;

  // детальные счётчики (для админа)
  if (kind === "blur") blurCount += 1;
  if (kind === "hidden") hiddenCount += 1;

  // главный счётчик
  leaveCount += 1;

  const resp = await postEvent(kind, {
    fio,
    blurCount,
    hiddenCount,
    leaveCount
  });

  if (leaveCount >= AUTO_FINISH_AT || resp?.shouldFinish) {
    await finishTest({ reason: "too_many_violations" });
  }
}

async function startTest() {
  fio = $("fio").value.trim();
  if (!fio) return showModal("Ошибка", "Введите ФИО");

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

  await postEvent("start", { fio });
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

  await sendJSON("/api/submit", {
    sid, fio, score, total, reason,
    blurCount, hiddenCount, leaveCount,
    spentSec
  });

  const text =
    reason === "too_many_violations"
      ? `Тест завершён автоматически (3-й уход).\nРезультат: ${score}/${total}`
      : reason === "time_up"
        ? `Время вышло.\nРезультат: ${score}/${total}`
        : `Тест завершён.\nРезультат: ${score}/${total}`;

  // ✅ вместо alert
  showModal("Готово", text, "Ок");

  $("note").textContent = `Ваш результат: ${score}/${total}`;
  $("finishBtn").style.display = "none";
  $("closeBtn").style.display = "block";
}

/* ✅ Логика событий:
   - уход считаем по hidden (один раз за цикл)
   - blur игнорируем, если уже hidden (чтобы не было 2 попыток за одно сворачивание)
*/
document.addEventListener("visibilitychange", () => {
  if (!testStarted || finished) return;

  if (document.hidden) {
    if (!isHiddenCycle) {
      isHiddenCycle = true;
      registerLeave("hidden");
    }
  } else {
    if (isHiddenCycle) {
      showWarning("⚠️ Возврат в тест зафиксирован", `Уходов: ${leaveCount} из ${AUTO_FINISH_AT}`);
      isHiddenCycle = false;
    }
  }
});

window.addEventListener("blur", () => {
  if (!testStarted || finished) return;
  // ✅ если уже hidden — не считаем blur вторым уходом
  if (document.hidden || isHiddenCycle) return;
  registerLeave("blur");
});

window.addEventListener("focus", () => {
  if (!testStarted || finished) return;
  // просто уведомление при возвращении фокуса
  showWarning("ℹ️ Проверка фокуса", `Уходов: ${leaveCount} из ${AUTO_FINISH_AT}`, 1400);
});

$("startBtn").addEventListener("click", startTest);
$("finishBtn").addEventListener("click", () => finishTest({ reason: "manual" }));
$("closeBtn").addEventListener("click", () => tg?.close?.());

// init
(async () => {
  await ensureSid();
})();
