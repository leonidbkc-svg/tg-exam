// Тестовые вопросы (замени потом на свои)
const QUESTIONS = [
  {
    id: 1,
    text: "ИСМП — это…",
    options: [
      "инфекции, связанные с оказанием медицинской помощи",
      "инфекции, передающиеся половым путём",
      "инфекции пищевого происхождения",
      "внутрибольничные аллергии"
    ],
    correctIndex: 0
  },
  {
    id: 2,
    text: "Гигиена рук наиболее эффективна для профилактики…",
    options: ["ИСМП", "травм", "гипертонии", "анемии"],
    correctIndex: 0
  },
  {
    id: 3,
    text: "Минимальная длительность обработки рук антисептиком (сек)?",
    options: ["5", "10", "20", "60"],
    correctIndex: 2
  }
];

function $(id) { return document.getElementById(id); }

function getSid() {
  const url = new URL(window.location.href);
  return url.searchParams.get("sid") || "";
}

async function sendEvent(type, payload = {}) {
  try {
    await fetch("/api/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid: getSid(), type, payload, ts: Date.now() })
    });
  } catch {}
}

async function submitResult({ fio, score, total }) {
  try {
    await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid: getSid(), fio, score, total })
    });
  } catch {}
}

let blurCount = 0;
let hiddenCount = 0;

window.addEventListener("blur", () => {
  blurCount += 1;
  updateLeaveInfo();
  sendEvent("blur", { blurCount });
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenCount += 1;
    updateLeaveInfo();
    sendEvent("hidden", { hiddenCount });
  } else {
    sendEvent("visible", { hiddenCount });
  }
});

function updateLeaveInfo() {
  const el = $("leaveInfo");
  if (!el) return;
  el.textContent = `Уходы: blur=${blurCount}, hidden=${hiddenCount}`;
  const totalLeaves = blurCount + hiddenCount;
  $("hint").textContent =
    totalLeaves >= 2
      ? "⚠️ Зафиксированы переключения. При большом количестве уходов преподавателю придёт уведомление."
      : "";
}

function renderQuestions() {
  const wrap = $("questions");
  wrap.innerHTML = "";
  QUESTIONS.forEach((q, idx) => {
    const block = document.createElement("div");
    block.className = "q";
    block.innerHTML = `<div><b>${idx + 1}. ${q.text}</b></div>`;

    q.options.forEach((opt, oi) => {
      const label = document.createElement("label");
      label.className = "opt";
      label.innerHTML = `
        <input type="radio" name="q_${q.id}" value="${oi}">
        ${opt}
      `;
      block.appendChild(label);
    });

    wrap.appendChild(block);
  });
}

function calcScore() {
  let score = 0;
  for (const q of QUESTIONS) {
    const picked = document.querySelector(`input[name="q_${q.id}"]:checked`);
    if (!picked) continue;
    const val = Number(picked.value);
    if (val === q.correctIndex) score += 1;
  }
  return score;
}

function show(id) { $(id).classList.remove("hidden"); }
function hide(id) { $(id).classList.add("hidden"); }

function startTest() {
  const fio = $("fio").value.trim();
  if (fio.length < 5) {
    alert("Введите ФИО полностью.");
    return;
  }
  hide("step-fio");
  show("step-test");

  blurCount = 0;
  hiddenCount = 0;
  updateLeaveInfo();

  renderQuestions();
  sendEvent("start", { fio });
}

async function finishTest() {
  const fio = $("fio").value.trim();
  const score = calcScore();
  const total = QUESTIONS.length;

  hide("step-test");
  show("step-result");

  $("resultTitle").textContent = "Результат";
  $("resultText").innerHTML = `
    <div class="ok"><b>${score}</b> из <b>${total}</b></div>
    <div class="muted">Уходы: blur=${blurCount}, hidden=${hiddenCount}</div>
  `;

  sendEvent("finish", { score, total });
  await submitResult({ fio, score, total });
}

(function init() {
  const sid = getSid();
  $("sidInfo").textContent = sid ? `sid: ${sid}` : "⚠️ sid не передан (открывай из Telegram-кнопки).";

  $("btnStart").addEventListener("click", startTest);
  $("btnFinish").addEventListener("click", finishTest);
})();
