const T = window.__TAURI__;
const win = T.window.getCurrentWindow();
const $ = (id) => document.getElementById(id);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const uid = () => "t" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
let tasks = load("tasks", []);
if (tasks.some((t) => !t.id)) {
  // 旧版で id なしのまま保存された手順("undefined" キー)を、最初の id なしタスクへ引き継ぐ
  const orphan = tasks.find((t) => !t.id);
  tasks.forEach((t) => { t.id = t.id || uid(); });
  const fs = load("flows", {});
  if (fs.undefined) { fs[orphan.id] = fs.undefined; delete fs.undefined; save("flows", fs); }
  save("tasks", tasks);
}
let cfg = Object.assign({ mode: "top", opacity: 85, fontsize: 14 }, load("cfg", {}));

async function applyMode() {
  try {
    await win.setAlwaysOnTop(false);
    await win.setAlwaysOnBottom(false);
    if (cfg.mode === "top") await win.setAlwaysOnTop(true);
    if (cfg.mode === "bottom") await win.setAlwaysOnBottom(true);
  } catch (e) { console.error(e); }
}
function applyStyle() {
  document.documentElement.style.setProperty("--op", cfg.opacity / 100);
  document.documentElement.style.setProperty("--fs", cfg.fontsize + "px");
}

async function openFlow(t) {
  const label = "flow-" + t.id;
  const W = T.webviewWindow.WebviewWindow;
  try {
    const ex = await W.getByLabel(label);
    if (ex) { await ex.unminimize(); await ex.show(); await ex.setFocus(); return; }
    const w = new W(label, { url: "flow.html", title: "手順: " + t.text, width: 960, height: 640, center: true, focus: true });
    w.once("tauri://error", (e) => console.error(e));
  } catch (e) { console.error(e); }
}
async function dropFlow(t) {
  const fs = load("flows", {}); delete fs[t.id]; save("flows", fs);
  try { const ex = await T.webviewWindow.WebviewWindow.getByLabel("flow-" + t.id); if (ex) await ex.close(); } catch {}
}

function render() {
  const flows = load("flows", {});
  const ul = $("list");
  ul.textContent = "";
  const sorted = [...tasks.keys()].sort((a, b) => tasks[a].done - tasks[b].done);
  for (const i of sorted) {
    const t = tasks[i];
    const li = document.createElement("li");
    if (t.done) li.className = "done";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = t.done;
    cb.onchange = () => { t.done = cb.checked; commit(); };
    const span = document.createElement("span");
    span.className = "t"; span.textContent = t.text;
    span.ondblclick = () => {
      const inp = document.createElement("input");
      inp.className = "edit"; inp.value = t.text;
      const done = (ok) => { if (ok && inp.value.trim()) t.text = inp.value.trim(); commit(); };
      inp.onkeydown = (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); };
      inp.onblur = () => done(true);
      span.replaceWith(inp); inp.focus();
    };
    const x = document.createElement("button");
    x.className = "x"; x.textContent = "✕";
    x.onclick = () => { dropFlow(t); tasks.splice(i, 1); commit(); };
    const n = (flows[t.id]?.nodes || []).length;
    const f = document.createElement("button");
    f.className = "f" + (n ? " has" : "");
    f.textContent = n ? "🔀" + n : "🔀";
    f.title = "手順フローを開く";
    f.onclick = () => openFlow(t);
    li.append(cb, span, f, x);
    ul.append(li);
  }
}
function commit() { save("tasks", tasks); render(); }

$("add").onkeydown = (e) => {
  if (e.key === "Enter" && e.target.value.trim()) {
    tasks.push({ id: uid(), text: e.target.value.trim(), done: false });
    e.target.value = ""; commit();
  }
};
$("clear").onclick = () => { tasks.filter((t) => t.done).forEach(dropFlow); tasks = tasks.filter((t) => !t.done); commit(); };
$("quit").onclick = async () => {
  try { for (const w of await T.webviewWindow.getAllWebviewWindows()) if (w.label !== win.label) await w.close(); } catch {}
  win.close();
};
window.addEventListener("storage", (e) => { if (e.key === "flows" && !document.querySelector(".edit")) render(); });
$("gear").onclick = () => { $("settings").hidden = !$("settings").hidden; };

$("mode").value = cfg.mode;
$("opacity").value = cfg.opacity;
$("fontsize").value = cfg.fontsize;
$("mode").onchange = (e) => { cfg.mode = e.target.value; save("cfg", cfg); applyMode(); };
$("opacity").oninput = (e) => { cfg.opacity = +e.target.value; save("cfg", cfg); applyStyle(); };
$("fontsize").oninput = (e) => { cfg.fontsize = +e.target.value; save("cfg", cfg); applyStyle(); };

const inv = T.core.invoke;
inv("plugin:autostart|is_enabled").then((v) => ($("autostart").checked = v)).catch(() => {});
$("autostart").onchange = (e) =>
  inv(e.target.checked ? "plugin:autostart|enable" : "plugin:autostart|disable").catch(console.error);

applyStyle(); applyMode(); render();
