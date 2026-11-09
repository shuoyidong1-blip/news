"""承認済みの提案だけを実行する。削除はせず、退避フォルダへ移動するだけ。"""
import os
import shutil
import time
from datetime import datetime

from scanner import expand


def _unique(path):
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    n = 2
    while os.path.exists(f"{base} ({n}){ext}"):
        n += 1
    return f"{base} ({n}){ext}"


def _trash_dest(trash_root, batch, src):
    # C:\Users\me\Downloads\a.txt → <退避>\<batch>\C\Users\me\Downloads\a.txt （元の場所が分かるように）
    drive, rest = os.path.splitdrive(os.path.abspath(src))
    drive = drive.replace(":", "").strip("\\/").replace("\\", "_").replace("/", "_")
    return os.path.join(trash_root, batch, drive, rest.lstrip("\\/"))


def execute(conn, cfg):
    batch = datetime.now().strftime("%Y%m%d_%H%M%S")
    trash_root = expand(cfg["trash_dir"])
    rows = conn.execute(
        "SELECT * FROM proposals WHERE decision='approve' AND executed=0").fetchall()
    done, skipped = 0, []
    for r in rows:
        src = r["path"]
        try:
            st = os.stat(src)
        except OSError:
            skipped.append((src, "ファイルが見つからない"))
            continue
        if st.st_size != r["size"] or abs(st.st_mtime - r["mtime"]) >= 1:
            skipped.append((src, "スキャン後に変更されたため保留（再スキャンしてください）"))
            continue
        dst = r["dest"] if r["action"] == "move" else _trash_dest(trash_root, batch, src)
        dst = _unique(dst)
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
        except OSError as e:
            skipped.append((src, f"移動できない: {e}"))
            continue
        conn.execute("INSERT INTO history(batch, action, src, dst, ts) VALUES(?,?,?,?,?)",
                     (batch, r["action"], src, dst, time.time()))
        conn.execute("UPDATE proposals SET executed=1 WHERE id=?", (r["id"],))
        done += 1
    conn.commit()
    return {"batch": batch, "done": done, "skipped": skipped}


def undo(conn, batch):
    rows = conn.execute(
        "SELECT * FROM history WHERE batch=? AND undone=0", (batch,)).fetchall()
    restored, failed = 0, []
    for r in rows:
        if not os.path.exists(r["dst"]):
            failed.append((r["src"], "退避先にファイルがない"))
            continue
        if os.path.exists(r["src"]):
            failed.append((r["src"], "元の場所に同名ファイルがある"))
            continue
        try:
            os.makedirs(os.path.dirname(r["src"]), exist_ok=True)
            shutil.move(r["dst"], r["src"])
        except OSError as e:
            failed.append((r["src"], str(e)))
            continue
        conn.execute("UPDATE history SET undone=1 WHERE id=?", (r["id"],))
        conn.execute("UPDATE proposals SET executed=0, decision='pending' WHERE path=?", (r["src"],))
        restored += 1
    conn.commit()
    return {"restored": restored, "failed": failed}
