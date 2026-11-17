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
let cfg = Object.assign({ mode: "top", opacity: 85, fontsize: 14, buddy: true, freq: "normal", pulse: true, buddyImg: null }, load("cfg", {}));

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

function startReorder(e, li) {
  e.preventDefault();
  const ul = $("list");
  ul.setPointerCapture(e.pointerId);
  li.classList.add("drag");
  ul.onpointermove = (ev) => {
    const others = [...ul.children].filter((x) => x !== li);
    const next = others.find((x) => { const r = x.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
    if (next) { if (li.nextSibling !== next) ul.insertBefore(li, next); }
    else if (ul.lastChild !== li) ul.append(li);
  };
  ul.onpointerup = ul.onpointercancel = () => {
    ul.onpointermove = ul.onpointerup = ul.onpointercancel = null;
    const ids = [...ul.children].map((x) => x.dataset.id);
    tasks = ids.map((id) => tasks.find((t) => t.id === id));
    commit();
  };
}

function render() {
  const flows = load("flows", {});
  const ul = $("list");
  ul.textContent = "";
  const sorted = [...tasks.keys()].sort((a, b) => tasks[a].done - tasks[b].done);
  let rank = 0;
  for (const i of sorted) {
    const t = tasks[i];
    const li = document.createElement("li");
    li.dataset.id = t.id;
    if (t.done) li.className = "done";
    else if (rank === 0) li.className = "top";
    const g = document.createElement("span");
    g.className = "g"; g.textContent = "⠿"; g.title = "ドラッグで優先順位を入れ替え";
    g.onpointerdown = (e) => startReorder(e, li);
    const no = document.createElement("span");
    no.className = "no"; no.textContent = t.done ? "" : ++rank;
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = t.done;
    cb.onchange = () => { t.done = cb.checked; commit(); if (t.done) cheer(); };
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
    li.append(g, no, cb, span, f, x);
    ul.append(li);
  }
  trackTop();
}
function commit() { save("tasks", tasks); render(); }

// ---- キャラ & たまに揺らす(慣れ対策) ----
const MIN = 60000;
const SPEAK = { low: [8, 15], normal: [3, 7], high: [1.5, 4] };
const PULSE = { low: [20, 40], normal: [10, 25], high: [5, 12] };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rand = ([a, b]) => (a + Math.random() * (b - a)) * MIN;
let state = "idle", bubbleTimer, speakTimer, pulseTimer;

function catSvg(st) {
  const eyes = st === "happy"
    ? '<path d="M18 31q5-6 10 0M36 31q5-6 10 0" stroke="#333" stroke-width="2.5" fill="none" stroke-linecap="round"/>'
    : st === "sad"
      ? '<circle cx="24" cy="32" r="3" fill="#333"/><circle cx="40" cy="32" r="3" fill="#333"/><path d="M18 25l10 3M46 25l-10 3" stroke="#333" stroke-width="2" stroke-linecap="round"/>'
      : '<circle cx="24" cy="31" r="3" fill="#333"/><circle cx="40" cy="31" r="3" fill="#333"/>';
  const mouth = st === "sad"
    ? '<path d="M27 46q5-5 10 0" stroke="#a55" stroke-width="2" fill="none" stroke-linecap="round"/>'
    : st === "happy"
      ? '<path d="M26 41q6 8 12 0z" fill="#e66"/>'
      : '<path d="M28 42q4 4 4 0q0 4 4 0" stroke="#a55" stroke-width="2" fill="none" stroke-linecap="round"/>';
  return `<svg viewBox="0 0 64 64" width="46" height="46"><path d="M9 28L12 5l15 12zM55 28L52 5 37 17z" fill="#f2a95a"/><ellipse cx="32" cy="37" rx="23" ry="21" fill="#f8c98a"/>${eyes}<path d="M30 37l2 2 2-2z" fill="#e88"/>${mouth}<path d="M5 38h11M5 44l10-3M59 38H48M59 44l-10-3" stroke="#b98" stroke-width="1.5" stroke-linecap="round"/></svg>`;
}
function renderBuddy() {
  $("buddy").hidden = !cfg.buddy;
  $("char").innerHTML = cfg.buddyImg ? `<img src="${cfg.buddyImg}" width="46" height="46" style="object-fit:contain">` : catSvg(state);
}
function say(text, st, ms = 8000) {
  state = st; renderBuddy();
  const c = $("char"), b = $("bubble");
  c.classList.remove("hop"); void c.offsetWidth; c.classList.add("hop");
  b.textContent = text; b.hidden = false;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { b.hidden = true; state = "idle"; renderBuddy(); }, ms);
}
function topTask() { return tasks.find((t) => !t.done); }
function speak() {
  if (!cfg.buddy) return;
  const t = topTask();
  if (!t) { say(pick(["タスクが空っぽだよ。次は何する?", "全部おわってる!えらい!", "ひと息ついてね☕"]), "happy"); return; }
  const ts = load("topSince", null);
  const hours = ts && ts.id === t.id ? (Date.now() - ts.ts) / 3600000 : 0;
  if (hours >= 3) say(`「${t.text}」、そろそろ手をつけてみない?`, "sad", 10000);
  else say(pick([`いまは「${t.text}」だよ!`, `次は「${t.text}」から行こう!`, `「${t.text}」、5分だけやってみる?`, `「${t.text}」に集中〜`]), "idle");
  pulseTop();
}
function cheer() {
  if (!cfg.buddy) return;
  if (!topTask()) say(pick(["ぜんぶ終わった!お疲れさま🎉", "完璧!ゆっくり休んでね"]), "happy");
  else say(pick(["やったね!", "いいぞ!", "ナイス!", "ひとつ前進!"]), "happy", 5000);
}
function pulseTop() {
  const el = document.querySelector("#list li.top");
  if (!el) return;
  el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse");
  setTimeout(() => el.classList.remove("pulse"), 3500);
}
function trackTop() {
  const t = topTask(), ts = load("topSince", null);
  if (t && (!ts || ts.id !== t.id)) save("topSince", { id: t.id, ts: Date.now() });
}
function schedule() {
  clearTimeout(speakTimer); clearTimeout(pulseTimer);
  if (cfg.buddy) speakTimer = setTimeout(() => { speak(); schedule(); }, rand(SPEAK[cfg.freq]));
  if (cfg.pulse) pulseTimer = setTimeout(() => { pulseTop(); schedule(); }, rand(PULSE[cfg.freq]));
}

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

// ホットキー(Ctrl+Alt+T): 一時的に最前面へ出して追加欄にフォーカス。フォーカスが外れたら元のモードへ戻す
if (T.event) {
  T.event.listen("hotkey", async () => {
    try {
      await win.setAlwaysOnBottom(false);
      await win.setAlwaysOnTop(true);
      await win.show();
      await win.setFocus();
      $("add").focus();
    } catch (e) { console.error(e); }
  });
  win.onFocusChanged(({ payload: focused }) => { if (!focused) applyMode(); });
}

$("buddyOn").checked = cfg.buddy;
$("pulseOn").checked = cfg.pulse;
$("freq").value = cfg.freq;
$("buddyOn").onchange = (e) => { cfg.buddy = e.target.checked; save("cfg", cfg); renderBuddy(); schedule(); };
$("pulseOn").onchange = (e) => { cfg.pulse = e.target.checked; save("cfg", cfg); schedule(); };
$("freq").onchange = (e) => { cfg.freq = e.target.value; save("cfg", cfg); schedule(); };
$("char").onclick = speak;
$("imgBtn").onclick = () => $("imgFile").click();
$("imgReset").onclick = () => { cfg.buddyImg = null; save("cfg", cfg); renderBuddy(); };
$("imgFile").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    if (f.type === "image/gif" && f.size < 1_000_000) { cfg.buddyImg = rd.result; save("cfg", cfg); renderBuddy(); return; }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"), k = 128 / Math.max(img.width, img.height, 1);
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      cfg.buddyImg = c.toDataURL("image/png"); save("cfg", cfg); renderBuddy();
    };
    img.src = rd.result;
  };
  rd.readAsDataURL(f);
};

applyStyle(); applyMode(); render(); renderBuddy(); schedule();
