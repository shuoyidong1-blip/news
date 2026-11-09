import os
import sqlite3

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "organizer.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS proposals(
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE,
  size INTEGER,
  mtime REAL,
  group_key TEXT,
  group_label TEXT,
  action TEXT,          -- 'trash' | 'move'
  dest TEXT,
  reason TEXT,
  confidence TEXT,      -- 'high' | 'mid' | 'low'
  decision TEXT DEFAULT 'pending',  -- 'pending' | 'approve' | 'keep'
  executed INTEGER DEFAULT 0
);
-- 「残す」と判断したファイル。更新されない限り再提案しない
CREATE TABLE IF NOT EXISTS kept(path TEXT PRIMARY KEY, mtime REAL);
CREATE TABLE IF NOT EXISTS history(
  id INTEGER PRIMARY KEY,
  batch TEXT,
  action TEXT,
  src TEXT,
  dst TEXT,
  ts REAL,
  undone INTEGER DEFAULT 0
);
"""


def connect(path=None):
    conn = sqlite3.connect(path or DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    return conn
