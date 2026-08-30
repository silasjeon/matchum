// matchum popup — recipe on/off switches. All state comes from the daemon.

const list = document.getElementById("list");
const status = document.getElementById("status");

const req = matchumDaemonRequest;

function render(recipes, system) {
  const configError = system?.config?.ok === false ? system.config.error : null;
  status.textContent = configError
    ? "config error"
    : `${recipes.filter((r) => r.enabled).length}/${recipes.length} on`;
  status.classList.toggle("error", !!configError);
  status.title = configError || "";
  list.replaceChildren();
  if (!recipes.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.innerHTML = "No recipes in your config.<br>Add one with <code>matchum.use(\"name\", opts)</code>.";
    list.append(li);
    return;
  }
  for (const r of recipes) {
    const li = document.createElement("li");
    const txt = document.createElement("div");
    txt.className = "txt";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = r.name;
    const desc = document.createElement("div");
    desc.className = r.error ? "err" : "desc";
    desc.textContent = r.error ? `error: ${r.error}` : r.description || "";
    desc.title = desc.textContent;
    if (r.page) {
      const a = document.createElement("a");
      a.href = "#";
      a.className = "open";
      a.textContent = "open ↗";
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        chrome.tabs.create({ url: chrome.runtime.getURL(`page.html?recipe=${encodeURIComponent(r.name)}`) });
      });
      name.append(" ", a);
    }
    txt.append(name, desc);
    const sw = document.createElement("button");
    sw.className = "sw";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", String(r.enabled));
    sw.setAttribute("aria-label", `${r.name} ${r.enabled ? "on" : "off"}`);
    sw.addEventListener("click", async () => {
      sw.disabled = true;
      try {
        const next = await req("recipes.set", { name: r.name, enabled: !r.enabled });
        render(next, await req("system.status"));
      } catch (e) {
        status.textContent = e.message;
        sw.disabled = false;
      }
    });
    li.append(txt, sw);
    list.append(li);
  }
}

(async () => {
  try {
    const [recipes, system] = await Promise.all([
      req("recipes.list"),
      req("system.status"),
    ]);
    render(recipes, system);
  } catch (e) {
    status.textContent = "daemon not connected";
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = `${e.message} — touch any tab to reconnect.`;
    list.append(li);
  }
})();
