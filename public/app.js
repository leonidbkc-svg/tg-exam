const tg = window.Telegram.WebApp;
tg.expand();

let fio = '';
let blurCount = 0;
let hiddenCount = 0;
let testStarted = false;

function startTest() {
  const input = document.getElementById('fio');
  fio = input.value.trim();

  if (!fio) {
    alert('Введите ФИО');
    return;
  }

  document.getElementById('startScreen').style.display = 'none';
  document.getElementById('testScreen').style.display = 'block';

  testStarted = true;

  tg.sendData(JSON.stringify({
    type: 'start_test',
    fio
  }));
}

function finishTest() {
  tg.sendData(JSON.stringify({
    type: 'finish_test',
    fio,
    blur: blurCount,
    hidden: hiddenCount
  }));

  alert('Тест завершён');
  tg.close();
}

// Анти-чит
document.addEventListener('visibilitychange', () => {
  if (!testStarted) return;

  if (document.hidden) {
    hiddenCount++;
    sendViolation('hidden');
  }
});

window.addEventListener('blur', () => {
  if (!testStarted) return;

  blurCount++;
  sendViolation('blur');
});

function sendViolation(type) {
  document.getElementById('violations').innerText =
    `Уходы: blur=${blurCount}, hidden=${hiddenCount}`;

  tg.sendData(JSON.stringify({
    type: 'focus_lost',
    fio,
    event: type,
    blur: blurCount,
    hidden: hiddenCount
  }));
}
