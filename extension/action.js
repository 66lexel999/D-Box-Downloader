// Toolbar popup: enable toggle, live MyIDM status, quick links.

const DEFAULTS = { enabled: true, myidmBase: "http://127.0.0.1:8081" };

async function settings() {
  const { settings } = await chrome.storage.local.get("settings");
  return Object.assign({}, DEFAULTS, settings || {});
}

async function init() {
  const s = await settings();
  document.getElementById("enabled").checked = s.enabled;

  const base = s.myidmBase.replace(/\/+$/, "");
  const dot = document.getElementById("dot");
  const txt = document.getElementById("statusText");
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(base + "/api/categories", { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) { dot.className = "dot up"; txt.textContent = "D BOX running"; }
    else throw new Error();
  } catch {
    dot.className = "dot down"; txt.textContent = "D BOX not reachable";
  }

  document.getElementById("enabled").addEventListener("change", async (e) => {
    const cur = await settings();
    cur.enabled = e.target.checked;
    await chrome.storage.local.set({ settings: cur });
  });
  document.getElementById("open").addEventListener("click", () =>
    chrome.tabs.create({ url: base + "/" }));
  document.getElementById("opts").addEventListener("click", () =>
    chrome.runtime.openOptionsPage());
}

init();
