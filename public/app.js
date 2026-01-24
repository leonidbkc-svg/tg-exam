const tg = Telegram.WebApp;
tg.ready();

const sid = new URLSearchParams(location.search).get("sid");
let exits = 0;

function send(type, payload = {}) {
  fetch("/api/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      initData: tg.initData,
      sid,
      type,
      payload
    })
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    exits++;
    document.getElementById("cnt").innerText = exits;
    document.getElementById("warn").innerText =
      exits >= 2
        ? "❌ Повторный выход. Попытка зафиксирована."
        : "⚠️ Вы покинули тест.";

    send("hidden");
  } else {
    send("visible");
  }
});

function saveFio() {
  const fio = document.getElementById("fio").value;
  send("fio", { fio });
}
