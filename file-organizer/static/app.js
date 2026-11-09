const $ = (s) => document.querySelector(s);
const api = async (url, body) => {
  const res = await fetch(url, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const size = (b) => { const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; b = b || 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return `${b.toFixed(i ? 1 : 0)}${u[i]}`; };
const date = (t) => new Date(t * 1000).toLocaleDateString("ja-JP");
const CONF = { high: "確信度 高", mid: "確信度 中", low: "確信度 低" };
const DECISION = { pending: "未判断", approve: "提案どおり", keep: "残す", trash: "退避する" };
const proposalText = (it) => it.action === "move" && it.decision !== "trash" ? `移動 → ${it.dest}` : "退避フォルダへ移動（削除はしない）";

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2500); }

function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === view));
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === view || (view === "review" && b.dataset.tab === "groups")));
  if (view === "groups") loadGroups();
  if (view === "summary") loadSummary();
  if (view === "history") loadHistory();
}
document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => show(b.dataset.tab)));

async function refreshCount() {
  const rows = await api("/api/summary");
  $("#approvedCount").textContent = rows.length ? `(${rows.length})` : "";
}

/* ---------- グループ一覧 ---------- */
async function loadGroups() {
  const groups = await api("/api/groups");
  refreshCount();
  if (!groups.length) {
    $("#groupList").innerHTML = `<p class="hint">提案はありません。「スキャン」を押してください。</p>`;
    return;
  }
  $("#groupList").innerHTML = groups.map((g) => `
    <div class="group ${g.pending ? "" : "done"}">
      <div class="info">
        <div class="label"><span class="badge ${g.confidence}">${CONF[g.confidence]}</span>${esc(g.group_label)}</div>
        <div class="meta">${g.total}件・${size(g.size)}　｜　未判断 ${g.pending}・承認 ${g.approved}・残す ${g.kept}</div>
      </div>
      <div class="actions">
        ${g.pending ? `<button class="primary" data-act="approve" data-g="${esc(g.group_key)}">未判断を全部承認</button>` : ""}
        <button data-act="review" data-g="${esc(g.group_key)}" data-l="${esc(g.group_label)}">1件ずつ見る</button>
        ${g.pending ? `<button data-act="keep" data-g="${esc(g.group_key)}">未判断を全部残す</button>` : ""}
      </div>
    </div>`).join("");
}

$("#groupList").onclick = async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const g = b.dataset.g;
  if (b.dataset.act === "review") return startReview(g, b.dataset.l);
  await api("/api/decide", { group: g, decision: b.dataset.act });
  toast(b.dataset.act === "approve" ? "承認しました（まだ実行はされていません）" : "残すことにしました（次回から提案されません）");
  loadGroups();
};

$("#scanBtn").onclick = async () => {
  const b = $("#scanBtn"); b.disabled = true; b.textContent = "スキャン中…";
  try {
    const r = await api("/api/scan", {});
    toast(`${r.files}件を調べ、${r.proposals}件を提案しました`);
    show("groups");
  } catch (err) { toast("スキャン失敗: " + err.message); }
  b.disabled = false; b.textContent = "スキャン";
};

/* ---------- 1件ずつ判断 ---------- */
let items = [], idx = 0, group = null;

async function startReview(g, label) {
  group = g;
  items = await api(`/api/items?group=${encodeURIComponent(g)}`);
  idx = Math.max(0, items.findIndex((it) => it.decision === "pending"));
  $("#reviewTitle").textContent = label;
  show("review");
  render();
}

function render() {
  const card = $("#reviewCard");
  $("#reviewProgress").textContent = items.length ? `${Math.min(idx + 1, items.length)} / ${items.length}` : "";
  if (idx >= items.length) {
    const left = items.filter((it) => it.decision === "pending").length;
    card.innerHTML = `<div class="done-msg"><h2>このグループは最後まで見ました</h2>
      <p>未判断 ${left}件 ／ Z で戻る ／ Esc で一覧へ</p></div>`;
    return;
  }
  const it = items[idx];
  const name = it.path.split(/[\\/]/).pop();
  card.innerHTML = `
    <div>
      <div class="name">${esc(name)}</div>
      <div class="path">${esc(it.path)}</div>
      <dl><dt>サイズ</dt><dd>${size(it.size)}</dd><dt>更新日</dt><dd>${date(it.mtime)}</dd><dt>理由</dt><dd>${esc(it.reason)}</dd></dl>
      <div class="proposal">提案：${esc(proposalText(it))}</div>
      <div class="decided">現在の判断：${DECISION[it.decision]}</div>
    </div>
    <div class="preview" id="preview"><span class="none">読み込み中…</span></div>`;
  loadPreview(it);
}

async function loadPreview(it) {
  const box = $("#preview");
  const url = `/api/preview/${it.id}`;
  const res = await fetch(url);
  if (items[idx] !== it) return;
  const type = res.headers.get("Content-Type") || "";
  if (res.status === 204) box.innerHTML = `<span class="none">プレビューなし</span>`;
  else if (type.startsWith("image/")) box.innerHTML = `<img src="${url}">`;
  else if (type.includes("pdf")) box.innerHTML = `<iframe src="${url}"></iframe>`;
  else box.innerHTML = `<pre>${esc(await res.text())}</pre>`;
}

async function act(k) {
  const it = items[idx];
  if (k === "prev") { if (idx > 0) { idx--; render(); } return; }
  if (!it) return;
  if (k === "reveal") { await api(`/api/reveal/${it.id}`, {}); return; }
  if (k === "approve" || k === "keep" || k === "trash") {
    await api("/api/decide", { ids: [it.id], decision: k });
    it.decision = k;
    refreshCount();
  }
  idx++;
  render();
}

document.querySelectorAll(".keys button").forEach((b) => (b.onclick = () => act(b.dataset.k)));
$("#backBtn").onclick = () => show("groups");
document.addEventListener("keydown", (e) => {
  if (!$("#review").classList.contains("active") || e.ctrlKey || e.altKey || e.metaKey) return;
  const map = { Enter: "approve", y: "approve", d: "trash", k: "keep", s: "skip", ArrowRight: "skip", z: "prev", ArrowLeft: "prev", o: "reveal" };
  if (e.key === "Escape") return show("groups");
  const k = map[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (k) { e.preventDefault(); act(k); }
});

/* ---------- 実行 ---------- */
async function loadSummary() {
  const rows = await api("/api/summary");
  refreshCount();
  const move = rows.filter((r) => r.action === "move" && r.decision !== "trash"), trash = rows.filter((r) => !move.includes(r));
  const total = rows.reduce((s, r) => s + r.size, 0);
  $("#summaryHead").innerHTML = rows.length ? `
    <div class="summary-box">
      <div class="big">承認済み ${rows.length}件（退避 ${trash.length}件・移動 ${move.length}件）合計 ${size(total)}</div>
      <button class="danger" id="execBtn">実行する</button>
    </div>
    <p class="hint">「退避」は退避フォルダへ移すだけで、削除はしません。実行後も「③ 履歴」から元に戻せます。</p>`
    : `<p class="hint">承認済みの提案はありません。</p>`;
  $("#summaryList").innerHTML = rows.length ? `<table><tr><th>ファイル</th><th>処理</th><th>サイズ</th><th></th></tr>${rows.map((r) => `
    <tr><td>${esc(r.path)}</td><td>${esc(proposalText(r))}</td><td class="num">${size(r.size)}</td>
    <td><button data-undo="${r.id}">取り消し</button></td></tr>`).join("")}</table>` : "";
  const btn = $("#execBtn");
  if (btn) btn.onclick = async () => {
    if (!confirm(`${rows.length}件を実行します。よろしいですか？`)) return;
    btn.disabled = true;
    const r = await api("/api/execute", {});
    toast(`${r.done}件を実行しました${r.skipped.length ? `（${r.skipped.length}件はスキップ）` : ""}`);
    if (r.skipped.length) alert("スキップしたファイル:\n" + r.skipped.map(([p, why]) => `${p}\n  → ${why}`).join("\n"));
    loadSummary();
  };
}
$("#summaryList").onclick = async (e) => {
  const id = e.target.dataset.undo; if (!id) return;
  await api("/api/decide", { ids: [Number(id)], decision: "pending" });
  loadSummary();
};

/* ---------- 履歴 ---------- */
async function loadHistory() {
  const rows = await api("/api/history");
  $("#historyList").innerHTML = rows.length ? `<table><tr><th>実行日時</th><th>件数</th><th>状態</th><th></th></tr>${rows.map((r) => `
    <tr><td>${new Date(r.ts * 1000).toLocaleString("ja-JP")}</td>
    <td>${r.total}件（退避 ${r.trashed}・移動 ${r.moved}）</td>
    <td>${r.undone ? `${r.undone}件取り消し済み` : ""}</td>
    <td>${r.undone < r.total ? `<button data-batch="${esc(r.batch)}">元に戻す</button>` : ""}</td></tr>`).join("")}</table>`
    : `<p class="hint">まだ実行履歴はありません。</p>`;
}
$("#historyList").onclick = async (e) => {
  const batch = e.target.dataset.batch; if (!batch) return;
  if (!confirm("この回の処理をすべて元の場所に戻します。よろしいですか？")) return;
  const r = await api(`/api/undo/${encodeURIComponent(batch)}`, {});
  toast(`${r.restored}件を元に戻しました`);
  if (r.failed.length) alert("戻せなかったファイル:\n" + r.failed.map(([p, why]) => `${p}\n  → ${why}`).join("\n"));
  loadHistory();
};
$("#openTrash").onclick = async () => { const r = await api("/api/open-trash", {}); toast(`退避フォルダ: ${r.path}`); };

show("groups");
