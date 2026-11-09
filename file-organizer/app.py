"""ファイル整理アシスタント — ブラウザで判断するローカルWebアプリ。
起動: python app.py  →  http://127.0.0.1:5123
"""
import json
import os
import subprocess
import sys
import threading
import traceback
import webbrowser
from datetime import datetime

from flask import Flask, abort, g, jsonify, render_template, request, send_file
from werkzeug.exceptions import HTTPException

import db
import executor
import rules
import scanner

BASE = os.path.dirname(os.path.abspath(__file__))
PORT = 5123
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg"}
TEXT_EXTS = {".txt", ".md", ".csv", ".log", ".json", ".xml", ".ini", ".py", ".js", ".html", ".css"}

app = Flask(__name__)
lock = threading.Lock()  # スキャン・実行・取り消しは同時に1つだけ
DB_FILE = os.environ.get("ORGANIZER_DB") or db.DB_PATH
ERROR_LOG = os.path.join(BASE, "error.log")


class _Conn:
    """リクエストごとに別の接続を使う（スレッド間で接続を共有しない）。"""
    def __getattr__(self, name):
        if "conn" not in g:
            g.conn = db.connect(DB_FILE)
        return getattr(g.conn, name)


conn = _Conn()


@app.teardown_appcontext
def _close(_exc):
    c = g.pop("conn", None)
    if c:
        c.close()


@app.errorhandler(Exception)
def _error(e):
    if isinstance(e, HTTPException):
        return e
    tb = traceback.format_exc()
    with open(ERROR_LOG, "a", encoding="utf-8") as f:
        f.write(f"===== {datetime.now():%Y-%m-%d %H:%M:%S} {request.path}\n{tb}\n")
    return f"エラーが発生しました（詳細は file-organizer\\error.log）\n{type(e).__name__}: {e}", 500


def _busy():
    return "別の処理（スキャン・実行・取り消し）が動いています。終わるまでお待ちください。", 409


def load_config():
    with open(os.path.join(BASE, "config.json"), encoding="utf-8") as f:
        return json.load(f)


def _proposal(pid):
    row = conn.execute("SELECT * FROM proposals WHERE id=?", (pid,)).fetchone()
    if not row:
        abort(404)
    return row


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/scan")
def api_scan():
    cfg = load_config()
    if not lock.acquire(blocking=False):
        return _busy()
    try:
        # 「残す」と判断済みのものを記録してから、未実行の提案を作り直す
        conn.execute("""INSERT OR REPLACE INTO kept(path, mtime)
                        SELECT path, mtime FROM proposals WHERE decision='keep'""")
        kept = {os.path.normcase(r["path"]): r["mtime"] for r in conn.execute("SELECT * FROM kept")}
        # 承認・退避の判断も、ファイルが変わっていなければ再スキャン後に引き継ぐ
        prev = {r["path"]: (r["decision"], r["mtime"]) for r in conn.execute(
            "SELECT path, decision, mtime FROM proposals WHERE executed=0 AND decision IN ('approve','trash')")}
        files = scanner.scan(cfg)
        props = rules.classify(files, cfg, kept)
        conn.execute("DELETE FROM proposals")
        conn.executemany(
            """INSERT INTO proposals(path,size,mtime,group_key,group_label,action,dest,reason,confidence)
               VALUES(:path,:size,:mtime,:group_key,:group_label,:action,:dest,:reason,:confidence)""",
            props)
        conn.executemany("UPDATE proposals SET decision=? WHERE path=? AND ABS(mtime-?)<1",
                         [(d, p, m) for p, (d, m) in prev.items()])
        conn.commit()
    finally:
        lock.release()
    return jsonify({"files": len(files), "proposals": len(props)})


@app.get("/api/groups")
def api_groups():
    rows = conn.execute("""
        SELECT group_key, group_label, confidence, action,
               COUNT(*) AS total, SUM(size) AS size,
               SUM(decision='pending') AS pending, SUM(decision IN ('approve','trash')) AS approved,
               SUM(decision='keep') AS kept
        FROM proposals WHERE executed=0
        GROUP BY group_key
        ORDER BY CASE confidence WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END, size DESC""").fetchall()
    return jsonify([dict(r) for r in rows])


@app.get("/api/items")
def api_items():
    group = request.args.get("group")
    only_pending = request.args.get("pending") == "1"
    sql = "SELECT * FROM proposals WHERE executed=0 AND group_key=?"
    if only_pending:
        sql += " AND decision='pending'"
    rows = conn.execute(sql + " ORDER BY size DESC", (group,)).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/decide")
def api_decide():
    data = request.get_json()
    decision = data["decision"]
    if decision not in ("pending", "approve", "keep", "trash"):
        abort(400)
    if "group" in data:
        conn.execute("""UPDATE proposals SET decision=? WHERE group_key=? AND executed=0
                        AND decision='pending'""", (decision, data["group"]))
    else:
        conn.executemany("UPDATE proposals SET decision=? WHERE id=? AND executed=0",
                         [(decision, i) for i in data["ids"]])
    conn.commit()
    return jsonify({"ok": True})


@app.get("/api/preview/<int:pid>")
def api_preview(pid):
    path = _proposal(pid)["path"]
    ext = os.path.splitext(path)[1].lower()
    if not os.path.isfile(path):
        return "", 204
    if ext in IMAGE_EXTS:
        return send_file(path)
    if ext == ".pdf":
        return send_file(path, mimetype="application/pdf")
    if ext in TEXT_EXTS:
        with open(path, "rb") as f:
            raw = f.read(3000)
        for enc in ("utf-8", "cp932"):
            try:
                return raw.decode(enc), 200, {"Content-Type": "text/plain; charset=utf-8"}
            except UnicodeDecodeError:
                pass
    return "", 204


def _open_explorer(args):
    if sys.platform == "win32":
        subprocess.Popen(["explorer", *args])


@app.post("/api/reveal/<int:pid>")
def api_reveal(pid):
    _open_explorer([f"/select,{_proposal(pid)['path']}"])
    return jsonify({"ok": True})


@app.get("/api/summary")
def api_summary():
    rows = conn.execute("""SELECT * FROM proposals WHERE decision IN ('approve','trash') AND executed=0
                           ORDER BY action, size DESC""").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/execute")
def api_execute():
    if not lock.acquire(blocking=False):
        return _busy()
    try:
        return jsonify(executor.execute(conn, load_config()))
    finally:
        lock.release()


@app.get("/api/history")
def api_history():
    rows = conn.execute("""SELECT batch, MIN(ts) AS ts, COUNT(*) AS total,
                                  SUM(action='trash') AS trashed, SUM(action='move') AS moved,
                                  SUM(undone) AS undone
                           FROM history GROUP BY batch ORDER BY batch DESC""").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/undo/<batch>")
def api_undo(batch):
    if not lock.acquire(blocking=False):
        return _busy()
    try:
        return jsonify(executor.undo(conn, batch))
    finally:
        lock.release()


@app.post("/api/open-trash")
def api_open_trash():
    path = scanner.expand(load_config()["trash_dir"])
    os.makedirs(path, exist_ok=True)
    _open_explorer([path])
    return jsonify({"path": path})


if __name__ == "__main__":
    threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{PORT}")).start()
    try:
        app.run(host="127.0.0.1", port=PORT, threaded=True)
    except OSError:
        print(f"\n[エラー] ポート {PORT} が使用中です。前に起動したツールが動いたままの可能性があります。")
        print("黒い画面をすべて閉じるか、パソコンを再起動してから start.bat を実行してください。")
