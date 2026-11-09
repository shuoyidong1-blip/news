"""指定フォルダを走査してファイル情報を集め、重複を検出する。"""
import hashlib
import os
from collections import defaultdict

# OneDrive の「オンラインのみ」ファイル。読むとダウンロードが走るのでハッシュ計算しない
CLOUD_ATTRS = 0x1000 | 0x40000 | 0x400000  # OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS


def expand(p):
    return os.path.normpath(os.path.expandvars(os.path.expanduser(p)))


def _is_under(path, roots):
    path = os.path.normcase(path)
    for r in roots:
        r = os.path.normcase(r)
        if path == r or path.startswith(r + os.sep):
            return True
    return False


def scan(cfg):
    targets = [t for t in dict.fromkeys(expand(t) for t in cfg["targets"]) if os.path.isdir(t)]
    # 実体が同じフォルダ（大文字小文字違い・リンク）を重複させない
    targets = list({os.path.normcase(os.path.realpath(t)): t for t in targets}.values())
    excluded_paths = [expand(p) for p in cfg.get("exclude_paths", [])]
    excluded_paths += [expand(cfg["trash_dir"]), expand(cfg["sorted_dir"])]
    # このツール自身のフォルダは、どこに置かれていても絶対に対象にしない
    excluded_paths.append(os.path.dirname(os.path.abspath(__file__)))
    excl_dirs = {d.lower() for d in cfg.get("exclude_dirs", [])}
    excl_dirs.add("file-organizer")  # 別の場所に展開したツールのコピーも対象外
    excl_exts = {e.lower() for e in cfg.get("exclude_exts", [])}

    files, seen = [], set()
    for root in targets:
        if _is_under(root, excluded_paths):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [
                d for d in dirnames
                if d.lower() not in excl_dirs and not d.startswith(".")
                and not _is_under(os.path.join(dirpath, d), excluded_paths)
            ]
            for name in filenames:
                path = os.path.join(dirpath, name)
                key = os.path.normcase(path)
                ext = os.path.splitext(name)[1].lower()
                if key in seen or ext in excl_exts or name.lower() == "desktop.ini":
                    continue
                seen.add(key)
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                files.append({
                    "path": path,
                    "name": name,
                    "ext": ext,
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "atime": st.st_atime,
                    "cloud": bool(getattr(st, "st_file_attributes", 0) & CLOUD_ATTRS),
                })
    return files


def _hash(path, limit=None):
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            if limit:
                h.update(f.read(limit))
            else:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
    except OSError:
        return None
    return h.hexdigest()


def find_duplicates(files):
    """中身が完全に同じファイルのグループを返す（サイズ → 先頭64KB → 全体 の順に絞り込む）。"""
    by_size = defaultdict(list)
    for f in files:
        if f["size"] > 0 and not f["cloud"]:
            by_size[f["size"]].append(f)

    groups = []
    for same_size in by_size.values():
        if len(same_size) < 2:
            continue
        by_head = defaultdict(list)
        for f in same_size:
            h = _hash(f["path"], 65536)
            if h:
                by_head[h].append(f)
        for cands in by_head.values():
            if len(cands) < 2:
                continue
            by_full = defaultdict(list)
            for f in cands:
                h = _hash(f["path"]) if f["size"] > 65536 else "small"
                if h:
                    by_full[h].append(f)
            groups += [g for g in by_full.values() if len(g) > 1]
    return groups
