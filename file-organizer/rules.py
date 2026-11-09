"""スキャン結果から「提案」を作る。ここではファイルに一切触らない。"""
import os
import re
import time
from datetime import datetime

from scanner import expand, _is_under

DAY = 86400
COPY_PATTERN = re.compile(r"(\(\d+\)|コピー|- copy|\bcopy\b|のコピー)", re.I)


def _fmt_date(ts):
    return datetime.fromtimestamp(ts).strftime("%Y/%m/%d")


def _keep_score(f, download_dirs):
    """重複の中で「残す1つ」を選ぶ。小さいほど残す優先。"""
    return (
        1 if COPY_PATTERN.search(os.path.splitext(f["name"])[0]) else 0,  # コピーっぽい名前は退避側
        1 if _is_under(f["path"], download_dirs) else 0,                  # ダウンロード内のものは退避側
        f["mtime"],                                                       # 古い方（原本）を残す
    )


def classify(files, cfg, kept=None):
    """files: scanner.scan() の結果 / kept: {path(normcase): mtime} 残すと判断済みのもの"""
    kept = kept or {}
    now = time.time()
    proposals = {}
    move_from = [expand(p) for p in cfg["move_from"]]
    download_dirs = [expand("~/Downloads")]
    sorted_dir = expand(cfg["sorted_dir"])

    def add(f, **kw):
        k = os.path.normcase(f["path"])
        if k in proposals:
            return
        if k in kept and abs(kept[k] - f["mtime"]) < 1:
            return
        proposals[k] = {"path": f["path"], "size": f["size"], "mtime": f["mtime"], "dest": None, **kw}

    # 1. 重複（確信度：高）
    from scanner import find_duplicates
    for group in find_duplicates(files):
        group.sort(key=lambda f: _keep_score(f, download_dirs))
        keep = group[0]
        for f in group[1:]:
            add(f, group_key="dup", group_label="重複ファイル（中身が完全に同じ）", action="trash",
                confidence="high",
                reason=f"「{keep['name']}」と中身が同じ（残す方: {os.path.dirname(keep['path'])}）")

    temp_exts = set(cfg["temp_exts"])
    inst_exts = set(cfg["installer_exts"])
    arc_exts = set(cfg["archive_exts"])
    cat_of = {e: cat for cat, exts in cfg["move_categories"].items() for e in exts}

    for f in files:
        age = (now - f["mtime"]) / DAY
        last_used = max(f["mtime"], f["atime"])

        # 2. 一時ファイル（高）
        if f["ext"] in temp_exts or f["name"].startswith("~$"):
            add(f, group_key="temp", group_label="一時ファイル・ログ・未完了ダウンロード", action="trash",
                confidence="high", reason=f"一時ファイル系の拡張子（{f['ext'] or '~$'}）")
        # 3. 古いインストーラー（高）
        elif f["ext"] in inst_exts and age > cfg["installer_days"]:
            add(f, group_key="installer", group_label=f"古いインストーラー（{cfg['installer_days']}日以上前）",
                action="trash", confidence="high",
                reason=f"インストーラー。{_fmt_date(f['mtime'])} 取得")
        # 4. ダウンロード内の古い圧縮ファイル（中）
        elif f["ext"] in arc_exts and age > cfg["archive_days"] and _is_under(f["path"], download_dirs):
            add(f, group_key="archive", group_label=f"Downloads の古い圧縮ファイル（{cfg['archive_days']}日以上前）",
                action="trash", confidence="mid",
                reason=f"圧縮ファイル。{_fmt_date(f['mtime'])} 取得（展開済みなら不要なことが多い）")
        # 5. Downloads / デスクトップ → 種類別フォルダへ移動（中）
        elif f["ext"] in cat_of and _is_under(f["path"], move_from):
            cat = cat_of[f["ext"]]
            add(f, group_key=f"move:{cat}", group_label=f"Downloads・デスクトップの{cat} → 整理済み\\{cat}",
                action="move", confidence="mid", dest=os.path.join(sorted_dir, cat, f["name"]),
                reason=f"{cat}ファイルを種類別フォルダへまとめる")
        # 6. 長期間使っていない（低）
        elif (now - last_used) / DAY > cfg["unused_days"]:
            add(f, group_key="unused", group_label=f"長期間使っていないファイル（{cfg['unused_days']}日以上）",
                action="trash", confidence="low",
                reason=f"最終使用 {_fmt_date(last_used)}")

    return list(proposals.values())
