#!/usr/bin/env python3
"""デジタル業界ニュースを RSS から収集し、Slack に投稿するスクリプト。"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import feedparser
import requests
from dateutil import parser as date_parser

JST = timezone(timedelta(hours=9))
STATE_FILE = Path(__file__).resolve().parent / "last_run.json"
REQUEST_TIMEOUT = 20
FIRST_RUN_LOOKBACK_HOURS = 24
SLACK_TEXT_LIMIT = 2900  # Slack section text の 3000 文字制限に対する安全マージン
SUMMARY_LIMIT = 300

FEEDS: dict[str, str] = {
    "TechCrunch Japan": "https://jp.techcrunch.com/feed/",
    "GIGAZINE": "https://gigazine.net/news/rss_2.0/",
    "Qiita": "https://qiita.com/feed.atom",
    "日経xTECH": "https://xtech.nikkei.com/rss/atom.xml",
    "GitHub Blog": "https://github.blog/feed/",
}

# カテゴリはリストの先頭から順に判定し、最もキーワード一致数が多いものを採用する。
CATEGORIES: list[tuple[str, list[str]]] = [
    (
        "🤖 AI・機械学習",
        [
            "ai", "人工知能", "機械学習", "ディープラーニング", "深層学習", "llm",
            "chatgpt", "gpt-", "gpt4", "gpt5", "claude", "gemini", "生成ai",
            "machine learning", "deep learning", "neural", "openai", "anthropic",
            "画像生成", "自然言語処理", "nlp", "copilot", "エージェント",
        ],
    ),
    (
        "💻 Web技術・プログラミング",
        [
            "プログラミング", "javascript", "typescript", "python", "ruby",
            "go言語", "golang", "rust", "react", "vue", "next.js", "nuxt",
            "フレームワーク", "ライブラリ", "開発者", "プログラム", "web技術",
            "html", "css", "node.js", "api", "エンジニア", "コーディング",
        ],
    ),
    (
        "☁️ インフラ・クラウド",
        [
            "クラウド", "aws", "azure", "gcp", "google cloud", "インフラ",
            "サーバー", "kubernetes", "docker", "コンテナ", "devops", "sre",
            "ネットワーク", "データセンター",
        ],
    ),
    (
        "🔒 セキュリティ",
        [
            "セキュリティ", "脆弱性", "攻撃", "ハッキング", "マルウェア",
            "ランサムウェア", "情報漏洩", "不正アクセス", "フィッシング",
            "security", "vulnerability", "exploit", "cve", "サイバー",
        ],
    ),
    (
        "📊 経営・DX・ビジネス",
        [
            "dx", "経営", "買収", "資金調達", "ipo", "上場", "投資",
            "ビジネス", "戦略", "業績", "決算", "スタートアップ", "m&a",
            "提携", "組織", "人事",
        ],
    ),
]
DEFAULT_CATEGORY = "🔧 その他技術"


def load_state() -> dict[str, Any]:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_state(state: dict[str, Any]) -> None:
    STATE_FILE.write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def parse_published(entry: Any) -> datetime | None:
    for key in ("published", "updated", "created"):
        value = entry.get(key)
        if value:
            try:
                dt = date_parser.parse(value)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.astimezone(timezone.utc)
            except (ValueError, OverflowError):
                continue

    for key in ("published_parsed", "updated_parsed"):
        value = entry.get(key)
        if value:
            try:
                return datetime(*value[:6], tzinfo=timezone.utc)
            except (TypeError, ValueError):
                continue
    return None


def truncate_summary(summary: str) -> str:
    if len(summary) <= SUMMARY_LIMIT:
        return summary
    return summary[:SUMMARY_LIMIT] + "..."


def normalize_title(title: str) -> str:
    normalized = re.sub(r"\s+", "", title).lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def categorize(title: str, summary: str) -> str:
    text = f"{title} {summary}".lower()
    best_category = DEFAULT_CATEGORY
    best_score = 0
    for category, keywords in CATEGORIES:
        score = sum(text.count(keyword) for keyword in keywords)
        if score > best_score:
            best_score = score
            best_category = category
    return best_category


def fetch_feed(source: str, url: str) -> list[dict[str, Any]]:
    articles: list[dict[str, Any]] = []
    try:
        response = requests.get(
            url,
            timeout=REQUEST_TIMEOUT,
            headers={"User-Agent": "digital-news-slack-bot/1.0"},
        )
        response.raise_for_status()
        parsed = feedparser.parse(response.content)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] {source} の取得に失敗しました: {exc}", file=sys.stderr)
        return articles

    for entry in parsed.entries:
        title = entry.get("title", "").strip()
        link = entry.get("link", "").strip()
        if not title or not link:
            continue

        summary = re.sub(r"<[^>]+>", "", entry.get("summary", "")).strip()
        published = parse_published(entry)

        articles.append(
            {
                "title": title,
                "link": link,
                "summary": summary,
                "source": source,
                "published": published,
            }
        )
    return articles


def collect_new_articles(since: datetime) -> list[dict[str, Any]]:
    all_articles: list[dict[str, Any]] = []
    for source, url in FEEDS.items():
        all_articles.extend(fetch_feed(source, url))

    seen_titles: set[str] = set()
    new_articles: list[dict[str, Any]] = []
    for article in all_articles:
        published = article["published"]
        if published is not None and published <= since:
            continue

        title_hash = normalize_title(article["title"])
        if title_hash in seen_titles:
            continue
        seen_titles.add(title_hash)

        article["category"] = categorize(article["title"], article["summary"])
        new_articles.append(article)

    new_articles.sort(
        key=lambda a: a["published"] or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    return new_articles


def build_slack_blocks(articles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    today_jst = datetime.now(JST).strftime("%Y-%m-%d")
    blocks: list[dict[str, Any]] = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": f"📰 デジタル業界ニュース ({today_jst})"},
        },
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"新着記事 {len(articles)} 件"}],
        },
        {"type": "divider"},
    ]

    grouped: dict[str, list[dict[str, Any]]] = {}
    for article in articles:
        grouped.setdefault(article["category"], []).append(article)

    category_order = [c for c, _ in CATEGORIES] + [DEFAULT_CATEGORY]
    for category in category_order:
        items = grouped.get(category)
        if not items:
            continue

        blocks.append(
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"*{category}* ({len(items)}件)"},
            }
        )

        lines = []
        for article in items:
            published = article["published"]
            time_str = published.astimezone(JST).strftime("%m/%d %H:%M") if published else ""
            line = f"• <{article['link']}|{article['title']}>"
            if article["summary"]:
                line += f"\n  {truncate_summary(article['summary'])}"
            line += f"\n  _{article['source']}"
            line += f" - {time_str}_" if time_str else "_"
            lines.append(line)

        chunk = ""
        for line in lines:
            if chunk and len(chunk) + len(line) + 1 > SLACK_TEXT_LIMIT:
                blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": chunk}})
                chunk = ""
            chunk = f"{chunk}\n{line}" if chunk else line
        if chunk:
            blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": chunk}})

        blocks.append({"type": "divider"})

    if blocks and blocks[-1]["type"] == "divider":
        blocks.pop()

    return blocks


def chunk_blocks(blocks: list[dict[str, Any]], max_blocks: int = 50) -> list[list[dict[str, Any]]]:
    return [blocks[i : i + max_blocks] for i in range(0, len(blocks), max_blocks)] or [[]]


def post_to_slack(webhook_url: str, articles: list[dict[str, Any]]) -> None:
    blocks = build_slack_blocks(articles)
    for part in chunk_blocks(blocks):
        response = requests.post(
            webhook_url,
            json={"blocks": part},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()


def main() -> None:
    state = load_state()
    last_run_str = state.get("last_run")
    if last_run_str:
        since = datetime.fromisoformat(last_run_str)
    else:
        since = datetime.now(timezone.utc) - timedelta(hours=FIRST_RUN_LOOKBACK_HOURS)

    run_time = datetime.now(timezone.utc)
    new_articles = collect_new_articles(since)

    print(f"[INFO] 前回実行: {since.isoformat()}")
    print(f"[INFO] 新着記事: {len(new_articles)} 件")

    if new_articles:
        webhook_url = os.environ.get("SLACK_WEBHOOK_URL")
        if not webhook_url:
            print("[ERROR] 環境変数 SLACK_WEBHOOK_URL が設定されていません。", file=sys.stderr)
            sys.exit(1)
        post_to_slack(webhook_url, new_articles)
        print("[INFO] Slack に投稿しました。")
    else:
        print("[INFO] 新着記事がないため、Slack への投稿はスキップしました。")

    save_state({"last_run": run_time.isoformat()})


if __name__ == "__main__":
    main()
