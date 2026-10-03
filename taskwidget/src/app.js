const T = window.__TAURI__;
const win = T.window.getCurrentWindow();
const $ = (id) => document.getElementById(id);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let tasks = load("tasks", []);
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

function render() {
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
    x.onclick = () => { tasks.splice(i, 1); commit(); };
    li.append(cb, span, x);
    ul.append(li);
  }
}
function commit() { save("tasks", tasks); render(); }

$("add").onkeydown = (e) => {
  if (e.key === "Enter" && e.target.value.trim()) {
    tasks.push({ text: e.target.value.trim(), done: false });
    e.target.value = ""; commit();
  }
};
$("clear").onclick = () => { tasks = tasks.filter((t) => !t.done); commit(); };
$("quit").onclick = () => win.close();
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
