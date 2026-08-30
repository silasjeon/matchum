// matchum recipe page — host for a recipe's page() output. The daemon renders
// HTML+CSS; this file only asks for it and swaps it in. Re-renders when the
// daemon pushes page.refresh (recipe called matchum.refreshPage(name)).

const name = new URLSearchParams(location.search).get("recipe") || "";
const root = document.getElementById("root");
let style = null;
let renderVersion = 0;

const req = matchumDaemonRequest;

async function render() {
  const version = ++renderVersion;
  try {
    const page = await req("recipes.page", { name });
    if (version !== renderVersion) return;
    document.title = page.title || `matchum · ${name}`;
    if (!style) {
      style = document.createElement("style");
      document.head.append(style);
    }
    if (style.textContent !== (page.css || "")) style.textContent = page.css || "";
    root.innerHTML = page.html || "";
  } catch (e) {
    if (version !== renderVersion) return;
    const message = document.createElement("div");
    message.className = "matchum-msg";
    message.textContent = `${name ? `${name}: ` : ""}${String(e.message)}`;
    root.replaceChildren(message);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "page.refresh" && (!msg.name || msg.name === name)) render();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") render();
});
render();
