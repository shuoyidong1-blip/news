/**
 * 就活管理：Googleカレンダー ⇄ Notion「予定」DB 双方向同期
 *
 * 必要なスクリプトプロパティ：
 *   NOTION_TOKEN … Notion 内部インテグレーションのシークレット
 * 初回は setup() を実行（10分ごとのトリガーを作成）
 */

const CONFIG = {
  CALENDAR_ID: 'primary',
  EVENTS_DS: '41a5be33-7cb7-8165-a72e-000b8beba09a',   // 予定
  COMPANIES_DS: 'aa6e3ec2-7f42-45a7-8cde-540fcf1c319c', // 企業マスター
  NOTION_VERSION: '2025-09-03',
  TZ: 'Asia/Tokyo',
  INITIAL_PAST_DAYS: 60,
  TRIGGER_MINUTES: 10,
};

// 就活予定とみなすキーワード（タイトル）
const SHUKATSU_TITLE_RE = /説明会|面接|面談|ES|エントリーシート|インターン|仕事体験|選考|Web.?テスト|WEBテスト|適性検査|SPI|玉手箱|GD|グループディスカッション|内定|OB訪問|OG訪問|座談会|セミナー|ウェビナー|オープンカンパニー|業界研究|仕事研究|#就活/i;
const MYNAVI_DESC_RE = /job\.mynavi\.jp|マイナビ/;

const P = { // Notion プロパティ名
  title: '予定名', date: '日時', type: '種別', company: '企業', format: '形式',
  place: '場所・URL', status: '状態', exclude: '対象外', eventId: 'GCalイベントID', syncedAt: '最終同期日時',
};

// ===================== エントリーポイント =====================

function setup() {
  if (!getToken_()) throw new Error('スクリプトプロパティ NOTION_TOKEN を設定してください');
  notion_('get', '/data_sources/' + CONFIG.EVENTS_DS);     // 接続確認
  notion_('get', '/data_sources/' + CONFIG.COMPANIES_DS);
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sync')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(CONFIG.TRIGGER_MINUTES).create();
  Logger.log('セットアップ完了。初回同期を実行します。');
  sync();
}

function sync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const pages = loadEventPages_();
    const byEventId = {};
    pages.forEach(p => { const id = p.eventId; if (id) byEventId[id] = p; });
    const companies = loadCompanies_();

    pullFromCalendar_(pages, byEventId, companies);
    pushToCalendar_(pages);
    markDone_(pages);
  } finally {
    lock.releaseLock();
  }
}

/** 同期状態をリセット（全件を取り直したいとき用） */
function resetSyncState() {
  PropertiesService.getScriptProperties().getKeys()
    .filter(k => k === 'syncToken' || k.indexOf('fp:') === 0 || k.indexOf('dup:') === 0)
    .forEach(k => PropertiesService.getScriptProperties().deleteProperty(k));
}

// ===================== Gカレンダー → Notion =====================

function pullFromCalendar_(pages, byEventId, companies) {
  const props = PropertiesService.getScriptProperties();
  const events = listChangedEvents_();

  events.forEach(ev => {
    const page = byEventId[ev.id];

    if (ev.status === 'cancelled') {
      if (page && page.status !== 'キャンセル') {
        updatePage_(page, { [P.status]: { select: { name: 'キャンセル' } } });
      }
      return;
    }
    if (page && page.exclude) return;
    if (!page && !isShukatsu_(ev, companies)) return;
    if (!page && props.getProperty('dup:' + ev.id)) return;

    const evFp = fpFromEvent_(ev);
    const stored = props.getProperty('fp:' + ev.id);

    if (page) {
      if (evFp === stored) return; // 自分の push の反映、または変更なし
      const pageFp = fpFromPage_(page);
      if (stored && pageFp !== stored && new Date(page.lastEdited) > new Date(ev.updated)) {
        return; // 両方編集 → Notion が新しいので push 側で反映
      }
      updatePage_(page, eventToProps_(ev));
      props.setProperty('fp:' + ev.id, evFp);
      return;
    }

    // 重複（同じタイトル・同じ開始時刻）
    // マイナビは「(株)〇〇」だけの短い予定を別に作ることがあるので、片方を含むものも重複扱い
    const evTitle = (ev.summary || '').trim();
    const dup = pages.find(p => sameStart_(p, ev) &&
      (p.title === evTitle || (p.title && evTitle && (p.title.indexOf(evTitle) >= 0 || evTitle.indexOf(p.title) >= 0))));
    if (dup) { props.setProperty('dup:' + ev.id, '1'); return; }

    const created = createPage_(ev, companies);
    pages.push(created);
    byEventId[ev.id] = created;
    props.setProperty('fp:' + ev.id, evFp);
  });
}

function listChangedEvents_() {
  const props = PropertiesService.getScriptProperties();
  let syncToken = props.getProperty('syncToken');
  const out = [];
  let pageToken;
  let res;
  do {
    const opts = { singleEvents: true, maxResults: 250, pageToken: pageToken, showDeleted: true };
    if (syncToken) {
      opts.syncToken = syncToken;
    } else {
      opts.timeMin = new Date(Date.now() - CONFIG.INITIAL_PAST_DAYS * 864e5).toISOString();
    }
    try {
      res = Calendar.Events.list(CONFIG.CALENDAR_ID, opts);
    } catch (e) {
      if (String(e).indexOf('410') >= 0 || /sync token/i.test(String(e))) {
        props.deleteProperty('syncToken'); // トークン失効 → 全件取り直し
        return listChangedEvents_();
      }
      throw e;
    }
    (res.items || []).forEach(i => out.push(i));
    pageToken = res.nextPageToken;
  } while (pageToken);
  if (res.nextSyncToken) props.setProperty('syncToken', res.nextSyncToken);
  return out;
}

function isShukatsu_(ev, companies) {
  const title = ev.summary || '';
  if (MYNAVI_DESC_RE.test(ev.description || '')) return true;
  if (SHUKATSU_TITLE_RE.test(title)) return true;
  return !!matchCompany_(title, companies);
}

function createPage_(ev, companies) {
  const props = eventToProps_(ev);
  const title = ev.summary || '';
  props[P.type] = { select: { name: classify_(title) } };
  props[P.status] = { select: { name: '予定' } };
  props[P.eventId] = richText_(ev.id);
  const fmt = detectFormat_(ev);
  if (fmt) props[P.format] = { select: { name: fmt } };
  const company = matchCompany_(title, companies);
  if (company) props[P.company] = { relation: [{ id: company.id }] };

  const children = [];
  if (ev.description) {
    children.push(heading_('元の予定の説明'));
    chunk_(stripHtml_(ev.description), 1900).forEach(t => children.push(para_(t)));
  }
  children.push(...memoTemplate_());

  const res = notion_('post', '/pages', {
    parent: { type: 'data_source_id', data_source_id: CONFIG.EVENTS_DS },
    properties: props,
    children: children,
  });
  return parsePage_(res);
}

function eventToProps_(ev) {
  return {
    [P.title]: { title: [{ text: { content: (ev.summary || '(無題)').slice(0, 1900) } }] },
    [P.date]: { date: eventToNotionDate_(ev) },
    [P.place]: richText_(ev.location || ''),
    [P.syncedAt]: { date: { start: nowIso_() } },
  };
}

// ===================== Notion → Gカレンダー =====================

function pushToCalendar_(pages) {
  const props = PropertiesService.getScriptProperties();
  pages.forEach(page => {
    if (page.exclude || page.status === 'キャンセル' || !page.date) return;
    const fp = fpFromPage_(page);

    if (!page.eventId) {
      const ev = Calendar.Events.insert(pageToEvent_(page, true), CONFIG.CALENDAR_ID);
      const upd = { [P.eventId]: richText_(ev.id), [P.syncedAt]: { date: { start: nowIso_() } } };
      if (!page.status) upd[P.status] = { select: { name: '予定' } };
      updatePage_(page, upd);
      props.setProperty('fp:' + ev.id, fp);
      return;
    }
    if (props.getProperty('fp:' + page.eventId) === fp) return;
    try {
      Calendar.Events.patch(pageToEvent_(page, false), CONFIG.CALENDAR_ID, page.eventId);
      updatePage_(page, { [P.syncedAt]: { date: { start: nowIso_() } } });
      props.setProperty('fp:' + page.eventId, fp);
    } catch (e) {
      Logger.log('カレンダー更新失敗 ' + page.title + ': ' + e);
    }
  });
}

function pageToEvent_(page, isNew) {
  const d = page.date;
  const ev = { summary: page.title, location: page.place || '' };
  if (isTimed_(d.start)) {
    const end = d.end || new Date(new Date(d.start).getTime() + 3600e3).toISOString();
    ev.start = { dateTime: d.start, timeZone: CONFIG.TZ };
    ev.end = { dateTime: end, timeZone: CONFIG.TZ };
  } else {
    ev.start = { date: d.start };
    ev.end = { date: addDays_(d.end || d.start, 1) };
  }
  if (isNew) {
    ev.description = 'Notionで作成: ' + page.url;
    ev.extendedProperties = { private: { notionPageId: page.id } };
  }
  return ev;
}

// 終わった予定を自動で「完了」に
function markDone_(pages) {
  const now = Date.now();
  pages.forEach(p => {
    if (p.status !== '予定' || !p.date) return;
    const end = p.date.end || p.date.start;
    const endMs = isTimed_(end) ? new Date(end).getTime() : new Date(addDays_(end, 1) + 'T00:00:00+09:00').getTime();
    if (endMs < now) updatePage_(p, { [P.status]: { select: { name: '完了' } } });
  });
}

// ===================== 判定ロジック =====================

function classify_(t) {
  if (/最終/.test(t)) return '最終面接';
  if (/二次|2次/.test(t)) return '二次面接';
  if (/一次|1次|面接/.test(t)) return '一次面接';
  if (/Web.?テスト|WEBテスト|適性検査|SPI|玉手箱/i.test(t)) return 'Webテスト';
  if (/GD|グループディスカッション/.test(t)) return 'GD';
  if (/ES|エントリーシート|締切|締め切り/.test(t)) return 'ES締切';
  if (/インターン|仕事体験/.test(t)) return 'インターン';
  if (/面談|OB訪問|OG訪問|座談会/.test(t)) return '面談';
  if (/説明会|セミナー|ウェビナー|オープンカンパニー|業界研究|仕事研究|仕事を知る/.test(t)) return '説明会';
  return 'その他';
}

function detectFormat_(ev) {
  const s = (ev.summary || '') + ' ' + (ev.location || '');
  if (/WEB|オンライン|online|zoom|teams|meet\.google/i.test(s)) return 'オンライン';
  if (ev.location) return '対面';
  return null;
}

function normName_(s) {
  return (s || '').replace(/株式会社|有限会社|合同会社|[(（]株[)）]|[\s　]/g, '').toLowerCase();
}

function matchCompany_(title, companies) {
  const t = normName_(title);
  let best = null;
  companies.forEach(c => {
    if (c.norm.length >= 2 && t.indexOf(c.norm) >= 0 && (!best || c.norm.length > best.norm.length)) best = c;
  });
  return best;
}

// ===================== 指紋（変更検知） =====================

function fpFromEvent_(ev) {
  let s, e;
  if (ev.start.date) {
    s = ev.start.date; e = addDays_(ev.end.date, -1);
    if (e < s) e = s;
    return JSON.stringify([(ev.summary || '').trim(), 'D', s, e, (ev.location || '').trim()]);
  }
  s = new Date(ev.start.dateTime).getTime();
  e = new Date(ev.end.dateTime).getTime();
  return JSON.stringify([(ev.summary || '').trim(), 'T', s, e, (ev.location || '').trim()]);
}

function fpFromPage_(p) {
  const d = p.date;
  if (!d) return '';
  if (!isTimed_(d.start)) return JSON.stringify([p.title, 'D', d.start, d.end || d.start, p.place]);
  const s = new Date(d.start).getTime();
  const e = d.end ? new Date(d.end).getTime() : s + 3600e3;
  return JSON.stringify([p.title, 'T', s, e, p.place]);
}

function sameStart_(page, ev) {
  if (!page.date) return false;
  const evStart = ev.start.date || ev.start.dateTime;
  if (!isTimed_(evStart)) return page.date.start === evStart;
  return new Date(page.date.start).getTime() === new Date(evStart).getTime();
}

function eventToNotionDate_(ev) {
  if (ev.start.date) {
    const end = addDays_(ev.end.date, -1);
    return { start: ev.start.date, end: end > ev.start.date ? end : null };
  }
  return { start: ev.start.dateTime, end: ev.end.dateTime };
}

// ===================== Notion 読み込み =====================

function loadEventPages_() {
  return queryAll_(CONFIG.EVENTS_DS).map(parsePage_);
}

function loadCompanies_() {
  return queryAll_(CONFIG.COMPANIES_DS).map(r => {
    const titleProp = Object.values(r.properties).find(v => v.type === 'title');
    const name = plain_(titleProp && titleProp.title);
    return { id: r.id, name: name, norm: normName_(name) };
  }).filter(c => c.name);
}

function queryAll_(dsId) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = notion_('post', '/data_sources/' + dsId + '/query', body);
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return out;
}

function parsePage_(r) {
  const pr = r.properties;
  const d = pr[P.date] && pr[P.date].date;
  return {
    id: r.id,
    url: r.url,
    lastEdited: r.last_edited_time,
    title: plain_(pr[P.title] && pr[P.title].title).trim(),
    date: d ? { start: d.start, end: d.end } : null,
    place: plain_(pr[P.place] && pr[P.place].rich_text).trim(),
    status: pr[P.status] && pr[P.status].select ? pr[P.status].select.name : null,
    exclude: !!(pr[P.exclude] && pr[P.exclude].checkbox),
    eventId: plain_(pr[P.eventId] && pr[P.eventId].rich_text).trim(),
  };
}

function updatePage_(page, properties) {
  const res = notion_('patch', '/pages/' + page.id, { properties: properties });
  Object.assign(page, parsePage_(res));
}

// ===================== Notion API =====================

function getToken_() {
  return PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
}

function notion_(method, path, body) {
  const opts = {
    method: method,
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + getToken_(), 'Notion-Version': CONFIG.NOTION_VERSION },
  };
  if (body) opts.payload = JSON.stringify(body);
  for (let i = 0; i < 4; i++) {
    const res = UrlFetchApp.fetch('https://api.notion.com/v1' + path, opts);
    const code = res.getResponseCode();
    if (code === 429 || code >= 500) { Utilities.sleep(1000 * (i + 1)); continue; }
    if (code >= 300) throw new Error('Notion API ' + code + ' ' + path + ': ' + res.getContentText());
    Utilities.sleep(350); // レート制限（3回/秒）対策
    return JSON.parse(res.getContentText());
  }
  throw new Error('Notion API リトライ上限: ' + path);
}

// ===================== ユーティリティ =====================

function memoTemplate_() {
  return [
    heading_('準備メモ'), para_(''),
    heading_('聞かれた質問'), bullet_(''),
    heading_('自分の回答'), para_(''),
    heading_('振り返り'), para_(''),
  ];
}
function heading_(t) { return { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: t } }] } }; }
function para_(t) { return { object: 'block', type: 'paragraph', paragraph: { rich_text: t ? [{ text: { content: t } }] : [] } }; }
function bullet_(t) { return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: t ? [{ text: { content: t } }] : [] } }; }
function richText_(t) { return { rich_text: t ? [{ text: { content: String(t).slice(0, 1900) } }] : [] }; }
function plain_(arr) { return (arr || []).map(x => x.plain_text).join(''); }
function isTimed_(s) { return !!s && s.indexOf('T') >= 0; }
function nowIso_() { return Utilities.formatDate(new Date(), CONFIG.TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function addDays_(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function stripHtml_(s) { return s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''); }
function chunk_(s, n) { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; }
