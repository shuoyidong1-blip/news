const T = window.__TAURI__;
const label = (T && T.window.getCurrentWindow().label) || "flow-" + (new URLSearchParams(location.search).get("id") || "test");
const taskId = label.replace(/^flow-/, "");
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.append(e);
  return e;
};
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const uid = () => "n" + Math.random().toString(36).slice(2, 9);

const svg = $("svg"), stage = $("stage"), gEdges = $("edges"), gNodes = $("nodes"), gTmp = $("tmp"), ta = $("ed");
const stored = load("flows", {})[taskId];
const flow = { nodes: stored?.nodes || [], edges: stored?.edges || [] };
let view = stored?.view || null;
let sel = null;           // {type:"node"|"edge", id}
let editing = null;       // {kind, id, isNew}
const undoStack = [];

const SHAPES = ["box", "decision", "terminal"];
const COLORS = [["#2b3040", "#6b7a99"], ["#1f3a5f", "#4d8fe0"], ["#1f4a3a", "#3fb27f"], ["#5a4020", "#e0a040"], ["#5a2430", "#e0607a"]];
const LH = 18;
const ctx = document.createElement("canvas").getContext("2d");
ctx.font = '14px "Segoe UI","Yu Gothic UI",sans-serif';

const nodeById = (id) => flow.nodes.find((n) => n.id === id);
const edgeById = (id) => flow.edges.find((e) => e.id === id);
const snapGrid = (v) => Math.round(v / 10) * 10;

function dims(n) {
  const lines = (n.text || " ").split("\n");
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const th = lines.length * LH;
  if (n.shape === "decision") return { w: Math.max(110, tw * 1.5 + 40), h: Math.max(64, th * 1.6 + 34), lines };
  if (n.shape === "terminal") return { w: Math.max(100, tw + 44), h: Math.max(38, th + 20), lines };
  return { w: Math.max(100, tw + 32), h: Math.max(40, th + 22), lines };
}
function anchor(n, tx, ty) {
  const { w, h } = dims(n);
  const dx = tx - n.x, dy = ty - n.y;
  if (!dx && !dy) return { x: n.x, y: n.y };
  const hw = w / 2, hh = h / 2;
  const t = n.shape === "decision"
    ? 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
    : Math.min(hw / (Math.abs(dx) || 1e-9), hh / (Math.abs(dy) || 1e-9));
  return { x: n.x + dx * t, y: n.y + dy * t };
}
function edgeGeom(e) {
  const a = nodeById(e.from), b = nodeById(e.to);
  let ox = 0, oy = 0;
  if (flow.edges.some((x) => x.from === e.to && x.to === e.from)) {
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    ox = (-dy / L) * 7; oy = (dx / L) * 7;
  }
  const p1 = anchor(a, b.x + ox, b.y + oy), p2 = anchor(b, a.x + ox, a.y + oy);
  return { x1: p1.x + ox, y1: p1.y + oy, x2: p2.x + ox, y2: p2.y + oy };
}

function drawNode(n) {
  const { w, h, lines } = dims(n);
  const [fill, stroke] = COLORS[n.color || 0];
  const g = el("g", {
    class: "node" + (sel?.id === n.id ? " sel" : "") + (n.done ? " done" : ""),
    "data-node": n.id, transform: `translate(${n.x},${n.y})`,
  }, gNodes);
  if (n.shape === "decision") el("polygon", { class: "shape", points: `0,${-h / 2} ${w / 2},0 0,${h / 2} ${-w / 2},0`, fill, stroke }, g);
  else el("rect", { class: "shape", x: -w / 2, y: -h / 2, width: w, height: h, rx: n.shape === "terminal" ? h / 2 : 6, fill, stroke }, g);
  const t = el("text", { class: "txt", "text-anchor": "middle", "dominant-baseline": "central" }, g);
  lines.forEach((l, i) => {
    const s = el("tspan", { x: 0, y: (i - (lines.length - 1) / 2) * LH }, t);
    s.textContent = l || " ";
  });
  if (n.done) {
    const bx = n.shape === "decision" ? w / 4 : w / 2 - 6, by = n.shape === "decision" ? -h / 4 : -h / 2 + 6;
    el("circle", { cx: bx, cy: by, r: 8, fill: "#3fb27f" }, g);
    const c = el("text", { x: bx, y: by, "text-anchor": "middle", "dominant-baseline": "central", fill: "#fff", "font-size": 11, "pointer-events": "none" }, g);
    c.textContent = "✓";
  }
  for (const [hx, hy] of [[0, -h / 2], [w / 2, 0], [0, h / 2], [-w / 2, 0]]) el("circle", { class: "handle", cx: hx, cy: hy, r: 6, "data-h": n.id }, g);
}
function drawEdge(e) {
  const p = edgeGeom(e);
  const on = sel?.type === "edge" && sel.id === e.id;
  const g = el("g", { class: "edge" + (on ? " sel" : ""), "data-edge": e.id }, gEdges);
  el("line", { class: "hit", x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 }, g);
  el("line", { class: "vis", x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, "marker-end": on ? "url(#arrowSel)" : "url(#arrow)" }, g);
  if (e.label) {
    const t = el("text", { class: "lbl", x: (p.x1 + p.x2) / 2, y: (p.y1 + p.y2) / 2 - 6, "text-anchor": "middle" }, g);
    t.textContent = e.label;
  }
}
function render() {
  gEdges.replaceChildren(); gNodes.replaceChildren();
  flow.edges.forEach(drawEdge);
  flow.nodes.forEach(drawNode);
  $("empty").hidden = flow.nodes.length > 0;
  const isNode = sel?.type === "node";
  ["bShape", "bColor", "bDone"].forEach((id) => ($(id).disabled = !isNode));
  $("bDel").disabled = !sel;
  $("bUndo").disabled = !undoStack.length;
  $("bDone").textContent = isNode && nodeById(sel.id)?.done ? "↺ 未完了に" : "✓ 完了";
}
function applyView() {
  $("vp").setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
  stage.style.backgroundPosition = `${view.x}px ${view.y}px`;
  stage.style.backgroundSize = `${20 * view.k}px ${20 * view.k}px`;
}
function save() {
  const all = load("flows", {});
  all[taskId] = { nodes: flow.nodes, edges: flow.edges, view };
  localStorage.setItem("flows", JSON.stringify(all));
}
let saveTimer;
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); };
function snap() {
  undoStack.push(JSON.stringify({ nodes: flow.nodes, edges: flow.edges }));
  if (undoStack.length > 60) undoStack.shift();
}
function select(s) { sel = s; render(); }
function toWorld(cx, cy) {
  const r = svg.getBoundingClientRect();
  return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
}
function fit() {
  const r = svg.getBoundingClientRect();
  if (!flow.nodes.length) { view = { x: r.width / 2, y: r.height / 2, k: 1 }; applyView(); return; }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const n of flow.nodes) {
    const { w, h } = dims(n);
    x0 = Math.min(x0, n.x - w / 2); x1 = Math.max(x1, n.x + w / 2);
    y0 = Math.min(y0, n.y - h / 2); y1 = Math.max(y1, n.y + h / 2);
  }
  const k = Math.max(0.3, Math.min(1.2, (r.width - 120) / (x1 - x0), (r.height - 120) / (y1 - y0)));
  view = { x: r.width / 2 - ((x0 + x1) / 2) * k, y: r.height / 2 - ((y0 + y1) / 2) * k, k };
  applyView(); saveSoon();
}

// ---- 編集 ----
function startEdit(kind, id, isNew) {
  let cx, cy, w, h, val;
  if (kind === "node") {
    const n = nodeById(id), d = dims(n);
    cx = n.x; cy = n.y; w = Math.max(d.w * view.k, 140); h = Math.max(d.h * view.k, 38); val = n.text;
  } else {
    const p = edgeGeom(edgeById(id));
    cx = (p.x1 + p.x2) / 2; cy = (p.y1 + p.y2) / 2; w = 130; h = 34; val = edgeById(id).label || "";
  }
  editing = { kind, id, isNew: !!isNew };
  ta.value = val;
  Object.assign(ta.style, { left: view.x + cx * view.k - w / 2 + "px", top: view.y + cy * view.k - h / 2 + "px", width: w + "px", height: h + "px" });
  ta.hidden = false;
  setTimeout(() => { ta.focus(); ta.select(); }, 30);
}
function commitEdit(cancel) {
  if (!editing) return;
  const ed = editing; editing = null;
  const v = ta.value.replace(/\s+$/, "");
  ta.hidden = true;
  if (ed.kind === "node") {
    const n = nodeById(ed.id);
    if (n) {
      if (!v || cancel) {
        if (ed.isNew && !n.text) { undoStack.pop(); removeNode(ed.id); sel = null; }
      } else if (v !== n.text) { if (!ed.isNew) snap(); n.text = v; }
    }
  } else {
    const e = edgeById(ed.id);
    if (e && !cancel && v !== (e.label || "")) { snap(); e.label = v; }
  }
  render(); save();
}
ta.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); commitEdit(false); }
  else if (e.key === "Escape") { e.preventDefault(); commitEdit(true); }
});
ta.addEventListener("blur", () => commitEdit(false));

// ---- 操作 ----
function newNode(shape, x, y) { return { id: uid(), x: snapGrid(x), y: snapGrid(y), shape, text: "", color: 0, done: false }; }
function removeNode(id) {
  flow.nodes = flow.nodes.filter((n) => n.id !== id);
  flow.edges = flow.edges.filter((e) => e.from !== id && e.to !== id);
}
function addEdge(from, to) {
  if (from === to || flow.edges.some((e) => e.from === from && e.to === to)) return;
  snap(); flow.edges.push({ id: uid(), from, to, label: "" }); render(); save();
}
function createAt(w) {
  snap();
  const n = newNode("box", w.x, w.y);
  flow.nodes.push(n); select({ type: "node", id: n.id }); save(); startEdit("node", n.id, true);
}
function addNode(shape) {
  snap();
  const s = sel?.type === "node" ? nodeById(sel.id) : null;
  let x, y;
  if (s) { x = s.x; y = s.y + dims(s).h / 2 + 70; }
  else { const r = svg.getBoundingClientRect(); ({ x, y } = toWorld(r.left + r.width / 2, r.top + r.height / 2)); }
  for (let g = 0; g < 50 && flow.nodes.some((o) => Math.abs(o.x - x) < 110 && Math.abs(o.y - y) < 50); g++) { if (s) x += 140; else { x += 20; y += 20; } }
  const n = newNode(shape, x, y);
  flow.nodes.push(n);
  if (s) flow.edges.push({ id: uid(), from: s.id, to: n.id, label: "" });
  select({ type: "node", id: n.id }); save(); startEdit("node", n.id, true);
}
function deleteSel() {
  if (!sel) return;
  snap();
  if (sel.type === "node") removeNode(sel.id); else flow.edges = flow.edges.filter((e) => e.id !== sel.id);
  select(null); save();
}
function undo() {
  const s = undoStack.pop();
  if (!s) return;
  const o = JSON.parse(s);
  flow.nodes = o.nodes; flow.edges = o.edges; sel = null; render(); save();
}
document.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => addNode(b.dataset.add)));
$("bShape").onclick = () => { const n = nodeById(sel?.id); if (!n) return; snap(); n.shape = SHAPES[(SHAPES.indexOf(n.shape) + 1) % SHAPES.length]; render(); save(); };
$("bColor").onclick = () => { const n = nodeById(sel?.id); if (!n) return; snap(); n.color = ((n.color || 0) + 1) % COLORS.length; render(); save(); };
$("bDone").onclick = () => { const n = nodeById(sel?.id); if (!n) return; snap(); n.done = !n.done; render(); save(); };
$("bDel").onclick = deleteSel;
$("bUndo").onclick = undo;
$("bFit").onclick = fit;

document.addEventListener("keydown", (e) => {
  if (editing) return;
  if (e.key === "Delete" || e.key === "Backspace") deleteSel();
  else if ((e.key === "Enter" || e.key === "F2") && sel?.type === "node") startEdit("node", sel.id, false);
  else if (e.key === "Tab") { e.preventDefault(); addNode("box"); }
  else if (e.key === "Escape") select(null);
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === "0") { e.preventDefault(); fit(); }
});

// ---- ポインタ ----
let mode = null, drag = null, last = { t: 0, key: "", x: 0, y: 0 };
svg.addEventListener("pointerdown", (e) => {
  const hn = e.target.closest("[data-h]"), nd = e.target.closest("[data-node]"), ed = e.target.closest("[data-edge]");
  const key = nd ? "n" + nd.dataset.node : ed ? "e" + ed.dataset.edge : "bg";
  const now = performance.now();
  const dbl = !hn && e.button === 0 && last.key === key && now - last.t < 400 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 6;
  last = { t: dbl ? 0 : now, key, x: e.clientX, y: e.clientY };
  if (dbl) {
    if (key === "bg") createAt(toWorld(e.clientX, e.clientY));
    else if (nd) startEdit("node", nd.dataset.node, false);
    else startEdit("edge", ed.dataset.edge, false);
    return;
  }
  svg.setPointerCapture(e.pointerId);
  const w = toWorld(e.clientX, e.clientY);
  const pan = () => { mode = "pan"; drag = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }; };
  if (e.button === 1) pan();
  else if (hn) { mode = "connect"; drag = { from: hn.dataset.h, x: e.clientX, y: e.clientY }; select({ type: "node", id: hn.dataset.h }); }
  else if (nd) {
    const n = nodeById(nd.dataset.node);
    mode = "move"; drag = { id: n.id, dx: n.x - w.x, dy: n.y - w.y, moved: false, sx: e.clientX, sy: e.clientY };
    select({ type: "node", id: n.id });
  } else if (ed) { mode = null; select({ type: "edge", id: ed.dataset.edge }); }
  else { select(null); pan(); }
});
svg.addEventListener("pointermove", (e) => {
  if (mode === "pan") { view.x = drag.vx + e.clientX - drag.sx; view.y = drag.vy + e.clientY - drag.sy; applyView(); }
  else if (mode === "move") {
    if (!drag.moved) { if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return; snap(); drag.moved = true; }
    const w = toWorld(e.clientX, e.clientY), n = nodeById(drag.id);
    n.x = snapGrid(w.x + drag.dx); n.y = snapGrid(w.y + drag.dy);
    render();
  } else if (mode === "connect") {
    gTmp.replaceChildren();
    const src = nodeById(drag.from), w = toWorld(e.clientX, e.clientY);
    const a = anchor(src, w.x, w.y);
    el("line", { x1: a.x, y1: a.y, x2: w.x, y2: w.y, stroke: "#4d8fe0", "stroke-width": 2, "stroke-dasharray": "6 4", "marker-end": "url(#arrow)" }, gTmp);
    const t = document.elementFromPoint(e.clientX, e.clientY)?.closest?.("[data-node]");
    const tn = t && nodeById(t.dataset.node);
    if (tn && tn.id !== src.id) {
      const d = dims(tn);
      el("rect", { x: tn.x - d.w / 2 - 5, y: tn.y - d.h / 2 - 5, width: d.w + 10, height: d.h + 10, rx: 8, fill: "none", stroke: "#4d8fe0", "stroke-width": 2, "stroke-dasharray": "4 3" }, gTmp);
    }
  }
});
function endPointer(e, cancelled) {
  try { svg.releasePointerCapture(e.pointerId); } catch {}
  if (mode === "pan" || (mode === "move" && drag.moved)) saveSoon();
  if (mode === "connect" && !cancelled && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) >= 8) {
    const t = document.elementFromPoint(e.clientX, e.clientY)?.closest?.("[data-node]");
    if (t) addEdge(drag.from, t.dataset.node);
    else {
      const w = toWorld(e.clientX, e.clientY);
      snap();
      const n = newNode("box", w.x, w.y);
      flow.nodes.push(n); flow.edges.push({ id: uid(), from: drag.from, to: n.id, label: "" });
      select({ type: "node", id: n.id }); save(); startEdit("node", n.id, true);
    }
  }
  mode = null; drag = null; gTmp.replaceChildren();
}
svg.addEventListener("pointerup", (e) => endPointer(e, false));
svg.addEventListener("pointercancel", (e) => endPointer(e, true));
svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const k = Math.min(2.5, Math.max(0.3, view.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  view.x = mx - ((mx - view.x) * k) / view.k; view.y = my - ((my - view.y) * k) / view.k; view.k = k;
  applyView(); saveSoon();
}, { passive: false });
svg.addEventListener("contextmenu", (e) => e.preventDefault());

const setTitle = () => { const t = load("tasks", []).find((x) => x.id === taskId); $("ttl").textContent = t ? t.text : ""; };
window.addEventListener("storage", (e) => { if (e.key === "tasks") setTitle(); });
window.addEventListener("beforeunload", save);
setTitle();
if (view) applyView(); else fit();
render();
