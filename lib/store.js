/* 打字练习系统 · SQLite 存储层（零依赖，用 Node 22 内置 node:sqlite）
 *
 * 为什么要换掉 JSON 文件：
 *   原来是每次提交成绩就把整份 db.json 重写一遍。5,000 名学生练一学期约 30 万条记录，
 *   文件 355 MB，一次写入要 4.4 秒且阻塞事件循环 —— 一个班 50 人提交就卡死几分钟。
 *   换成 SQLite 后每次只追加一行（约 1.5 ms），写入耗时与历史数据量无关。
 *
 * 设计要点（不是把 JSON 原样塞进库里，那样等于只解决了"写"）：
 *   1. record  只追加，永不改 —— 原始成绩明细，导出/审计用。
 *   2. person  每人一行的汇总（各模式最高分、最快 CPM、最低反应、速度时序），
 *              提交成绩时顺手更新。榜单直接读这张表，不再每次扫全表。
 *   3. key_hit / key_err  错键聚合，按（学校,班级,字符）累加。学情分析读它，
 *              不再每次把 30 万条记录的错键明细重算一遍。
 *   4. meta    学校名单、练习文本、统一测评、访问码、动态流等小配置，整块存 JSON。
 *              这些东西只有几 KB，改一次写一次，不影响性能。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let db = null;
let filePath = '';
const cache = new Map();      // 预编译语句缓存：SQL 文本 -> StatementSync

function prep(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}

/* ============================ 建表 ============================ */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     k TEXT PRIMARY KEY,
     v TEXT NOT NULL
   )`,

  /* 每人一行的汇总。榜单、统计只读这张表。 */
  `CREATE TABLE IF NOT EXISTS person (
     id          TEXT PRIMARY KEY,          -- 学校|班级|姓名
     school      TEXT NOT NULL DEFAULT '',
     cls         TEXT NOT NULL DEFAULT '',
     name        TEXT NOT NULL DEFAULT '',
     attempts    INTEGER NOT NULL DEFAULT 0,
     first_ts    TEXT,
     last_ts     TEXT,
     key_score      REAL NOT NULL DEFAULT 0,
     speed_score    REAL NOT NULL DEFAULT 0,
     wordrush_score REAL NOT NULL DEFAULT 0,
     zh_score       REAL NOT NULL DEFAULT 0,
     falling_score  REAL NOT NULL DEFAULT 0,
     speed_cpm   REAL NOT NULL DEFAULT 0,
     speed_acc   REAL NOT NULL DEFAULT 0,
     zh_cpm      REAL NOT NULL DEFAULT 0,
     zh_acc      REAL NOT NULL DEFAULT 0,
     reaction_ms INTEGER,
     max_streak  INTEGER,
     key_level   INTEGER NOT NULL DEFAULT 0,
     speed_seq   TEXT NOT NULL DEFAULT '[]'
   )`,
  `CREATE INDEX IF NOT EXISTS i_person_cls ON person(school, cls)`,

  /* 原始成绩明细：只追加 */
  `CREATE TABLE IF NOT EXISTS record (
     rid        INTEGER PRIMARY KEY AUTOINCREMENT,
     person_id  TEXT NOT NULL,
     school     TEXT NOT NULL DEFAULT '',
     cls        TEXT NOT NULL DEFAULT '',
     name       TEXT NOT NULL DEFAULT '',
     mode       TEXT NOT NULL,
     mode_name  TEXT,
     level      TEXT,
     cpm        REAL NOT NULL DEFAULT 0,
     wpm        REAL NOT NULL DEFAULT 0,
     acc        REAL NOT NULL DEFAULT 0,
     correct    INTEGER NOT NULL DEFAULT 0,
     wrong      INTEGER NOT NULL DEFAULT 0,
     sec        INTEGER NOT NULL DEFAULT 0,
     diff       REAL NOT NULL DEFAULT 1,
     score      REAL NOT NULL DEFAULT 0,
     qualified  INTEGER NOT NULL DEFAULT 0,
     over_cap   INTEGER NOT NULL DEFAULT 0,
     unified    INTEGER NOT NULL DEFAULT 0,
     material   TEXT NOT NULL DEFAULT '',
     reaction_ms INTEGER,
     max_streak  INTEGER,
     keys_json  TEXT,
     ts         TEXT NOT NULL,
     ts_ms      INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS i_rec_ts ON record(ts_ms)`,
  `CREATE INDEX IF NOT EXISTS i_rec_cls ON record(school, cls, ts_ms)`,
  `CREATE INDEX IF NOT EXISTS i_rec_person ON record(person_id, ts_ms)`,

  /* 错键聚合：正确按键次数 */
  `CREATE TABLE IF NOT EXISTS key_hit (
     school TEXT NOT NULL DEFAULT '',
     cls    TEXT NOT NULL DEFAULT '',
     ch     TEXT NOT NULL,
     n      INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (school, cls, ch)
   )`,

  /* 错键聚合：某键被打成了什么 */
  `CREATE TABLE IF NOT EXISTS key_err (
     school   TEXT NOT NULL DEFAULT '',
     cls      TEXT NOT NULL DEFAULT '',
     ch       TEXT NOT NULL,
     wrong_ch TEXT NOT NULL,
     n        INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (school, cls, ch, wrong_ch)
   )`
];

function initSchema() {
  for (const sql of SCHEMA) db.exec(sql);
}

/* ============================ 打开 / 关闭 ============================ */

function open(fp) {
  filePath = fp;
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  db = new DatabaseSync(fp);
  /* WAL：读写可以同时进行；NORMAL 让每次提交不必等磁盘 fsync */
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA temp_store = MEMORY');
  initSchema();
  return api;
}

function close() {
  if (db) { try { db.close(); } catch (e) { } db = null; }
  cache.clear();
}

let bulkDepth = 0;   // >0 表示已在一个批量事务里，内层不再自己开事务

function tx(fn) {
  if (bulkDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { } throw e; }
}

/* 批量导入用：几十万条一个事务，比逐条提交快一个数量级 */
function beginBulk() { db.exec('BEGIN IMMEDIATE'); bulkDepth++; }
function endBulk() {
  bulkDepth--;
  if (bulkDepth === 0) db.exec('COMMIT');
}

/* ============================ meta（小配置） ============================ */

function metaGet(k, dflt) {
  const row = prep('SELECT v FROM meta WHERE k = ?').get(k);
  if (!row) return dflt;
  try { return JSON.parse(row.v); } catch (e) { return dflt; }
}

function metaSet(k, v) {
  prep('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(k, JSON.stringify(v));
}

/* ============================ 写入一条成绩 ============================ */

/**
 * 追加一条成绩，并同步更新 person 汇总与错键聚合。整个过程在一个事务里。
 *
 * @param {object} r   computeResult 产出的记录
 * @param {object} [opts]
 * @param {boolean} [opts.count=true]
 *   是否计入汇总（榜单）。未达标（准确率不够/样本不足）或速度超上限的记录
 *   **只进明细、不进汇总** —— 与旧版 buildBoard 的过滤口径一致，
 *   否则不达标成绩也会顶掉最高分。错键统计不受此开关影响（旧版统计全部记录）。
 */
function addRecord(r, opts) {
  const pid = String(r.id || '');
  if (!pid) throw new Error('缺少身份 id');
  const count = !(opts && opts.count === false);

  const tsMs = Date.parse(r.ts) || Date.now();
  const lv = parseInt(String(r.level || '').replace(/[^\d]/g, ''), 10) || 0;
  const keysHit = (r.keys && r.keys.hits) || {};
  const keysErr = (r.keys && r.keys.errs) || {};

  tx(() => {
    /* 1) 明细 */
    prep(`INSERT INTO record
      (person_id,school,cls,name,mode,mode_name,level,cpm,wpm,acc,correct,wrong,sec,diff,
       score,qualified,over_cap,unified,material,reaction_ms,max_streak,keys_json,ts,ts_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      pid, r.school || '', r.cls || '', r.name || '', r.mode, r.modeName || r.mode,
      String(r.level == null ? '' : r.level), Number(r.cpm) || 0, Number(r.wpm) || 0,
      Number(r.acc) || 0, Number(r.correct) || 0, Number(r.wrong) || 0, Number(r.sec) || 0,
      Number(r.diff) || 1, Number(r.score) || 0, r.qualified ? 1 : 0, r.overCap ? 1 : 0,
      r.unified ? 1 : 0, r.material || '',
      r.reactionMs == null ? null : Math.round(Number(r.reactionMs) || 0),
      r.maxStreak == null ? null : Math.round(Number(r.maxStreak) || 0),
      JSON.stringify(r.keys || {}), r.ts, tsMs
    );

    /* 2) 取汇总行（没有就建）—— 即使不计入汇总也要建，
          这样"参与人数"能统计到只交过未达标成绩的学生 */
    let p = prep('SELECT * FROM person WHERE id = ?').get(pid);
    if (!p) {
      prep(`INSERT INTO person(id,school,cls,name,attempts,first_ts,last_ts)
            VALUES (?,?,?,?,0,?,?)`)
        .run(pid, r.school || '', r.cls || '', r.name || '', r.ts, r.ts);
      p = prep('SELECT * FROM person WHERE id = ?').get(pid);
    }
    if (!count) {
      /* 只记账，不参与榜单汇总 */
      updateKeyAgg(r, keysHit, keysErr);
      return;
    }

    /* 3) 逐字段按原规则累加 —— 与内存版 buildBoard 的口径完全一致 */
    const upd = {
      attempts: (p.attempts || 0) + 1,
      first_ts: !p.first_ts || r.ts < p.first_ts ? r.ts : p.first_ts,
      last_ts: !p.last_ts || r.ts > p.last_ts ? r.ts : p.last_ts,
      key_score: p.key_score, speed_score: p.speed_score,
      wordrush_score: p.wordrush_score, zh_score: p.zh_score, falling_score: p.falling_score,
      speed_cpm: p.speed_cpm, speed_acc: p.speed_acc,
      zh_cpm: p.zh_cpm, zh_acc: p.zh_acc,
      reaction_ms: p.reaction_ms, max_streak: p.max_streak, key_level: p.key_level,
      speed_seq: p.speed_seq || '[]'
    };

    /* 各模式最高分：严格大于才替换（同分保留较早那条，和原来一致） */
    const score = Number(r.score) || 0;
    const isBest = score > (Number(upd[r.mode + '_score']) || 0);
    if (isBest) upd[r.mode + '_score'] = score;

    if (r.mode === 'speed') {
      const cpm = Number(r.cpm) || 0;
      /* 榜单上显示的 CPM 与准确率，取的是「最高分那一次」的数值，不是历史最大值
         —— 这是旧版 buildBoard 的口径（rows.cpm 用的是 best.speed.cpm），必须照抄 */
      if (isBest) {
        upd.speed_cpm = cpm;
        upd.speed_acc = Number(r.acc) || 0;
      }
      /* 速度时序：只留最近 12 次，按时间升序 —— 进步榜要用首尾差 */
      let seq = [];
      try { seq = JSON.parse(upd.speed_seq) || []; } catch (e) { seq = []; }
      seq.push({ ts: r.ts, score: score, cpm: cpm });
      seq.sort((a, b) => a.ts < b.ts ? -1 : 1);
      if (seq.length > 12) seq = seq.slice(-12);
      upd.speed_seq = JSON.stringify(seq);
    }

    if (r.mode === 'zh') {
      const cpm = Number(r.cpm) || 0;
      if (cpm > upd.zh_cpm) { upd.zh_cpm = cpm; upd.zh_acc = Number(r.acc) || 0; }
      else if (cpm === upd.zh_cpm && Number(r.acc) > upd.zh_acc) upd.zh_acc = Number(r.acc) || 0;
    }

    if (r.mode === 'falling') {
      const rt = Number(r.reactionMs) || 0;
      if (rt > 0 && (upd.reaction_ms == null || rt < upd.reaction_ms)) upd.reaction_ms = rt;
      const st = Number(r.maxStreak) || 0;
      if (st > (upd.max_streak || 0)) upd.max_streak = st;
    }

    if (r.mode === 'key') {
      if (lv > upd.key_level) upd.key_level = lv;
    }

    prep(`UPDATE person SET attempts=?, first_ts=?, last_ts=?,
            key_score=?, speed_score=?, wordrush_score=?, zh_score=?, falling_score=?,
            speed_cpm=?, speed_acc=?, zh_cpm=?, zh_acc=?,
            reaction_ms=?, max_streak=?, key_level=?, speed_seq=?
          WHERE id = ?`).run(
      upd.attempts, upd.first_ts, upd.last_ts,
      upd.key_score, upd.speed_score, upd.wordrush_score, upd.zh_score, upd.falling_score,
      upd.speed_cpm, upd.speed_acc, upd.zh_cpm, upd.zh_acc,
      upd.reaction_ms, upd.max_streak, upd.key_level, upd.speed_seq, pid
    );

    /* 4) 错键聚合 */
    updateKeyAgg(r, keysHit, keysErr);
  });
}

/* 错键累加：正确次数按（学校,班级,字符），错误次数再细分"打成了什么" */
function updateKeyAgg(r, keysHit, keysErr) {
  const hitStmt = prep(`INSERT INTO key_hit(school, cls, ch, n) VALUES(?,?,?,?)
                        ON CONFLICT(school, cls, ch) DO UPDATE SET n = n + excluded.n`);
  const errStmt = prep(`INSERT INTO key_err(school, cls, ch, wrong_ch, n) VALUES(?,?,?,?,?)
                        ON CONFLICT(school, cls, ch, wrong_ch) DO UPDATE SET n = n + excluded.n`);
  for (const ch of Object.keys(keysHit || {})) {
    const n = Math.round(Number(keysHit[ch]) || 0);
    if (n > 0) hitStmt.run(r.school || '', r.cls || '', ch, n);
  }
  for (const ch of Object.keys(keysErr || {})) {
    const sub = keysErr[ch] || {};
    for (const w of Object.keys(sub)) {
      const n = Math.round(Number(sub[w]) || 0);
      if (n > 0) errStmt.run(r.school || '', r.cls || '', ch, w, n);
    }
  }
}

/* ============================ 榜单数据 ============================ */

/* person 表很小（一人一行），动态 where 直接拼；语句按 SQL 文本缓存 */
function personRows(sql, args) {
  return prep(sql).all(...args);
}

/**
 * 返回榜单原始行（未排序、未加名次），字段口径与旧版 buildBoard 的中间结果一致。
 */
function boardRows(opts) {
  opts = opts || {};
  if (opts.onlyUnified) return unifiedBoardRows(opts);

  /* attempts = 0 的是"只交过未达标成绩"的学生，不进榜单（与旧版一致） */
  const where = ['attempts > 0'], args = [];
  if (opts.school) { where.push('school = ?'); args.push(opts.school); }
  if (opts.cls) { where.push('cls = ?'); args.push(opts.cls); }
  const sql = 'SELECT * FROM person WHERE ' + where.join(' AND ');
  return personRows(sql, args).map(rowToPerson).map(p => personToBoard(p));
}

/* 统一测评榜：只统计带 unified 标记的记录。
   这是个偶发查询（教师切"只看统一测评"时才走），直接从明细表聚合，不维护第二套汇总。
   注：准确率取该模式下最大值而非"最高分那次的准确率"，差异极小，仅用于这个视图。 */
function unifiedBoardRows(opts) {
  const where = ['qualified = 1', 'unified = 1'], args = [];
  if (opts.school) { where.push('school = ?'); args.push(opts.school); }
  if (opts.cls) { where.push('cls = ?'); args.push(opts.cls); }
  const sql = `SELECT person_id AS id, MAX(school) AS school, MAX(cls) AS cls, MAX(name) AS name,
      COUNT(*) AS attempts,
      MAX(CASE WHEN mode='key' THEN score END) AS key_score,
      MAX(CASE WHEN mode='speed' THEN score END) AS speed_score,
      MAX(CASE WHEN mode='wordrush' THEN score END) AS wordrush_score,
      MAX(CASE WHEN mode='zh' THEN score END) AS zh_score,
      MAX(CASE WHEN mode='falling' THEN score END) AS falling_score,
      MAX(CASE WHEN mode='speed' THEN cpm END) AS speed_cpm,
      MAX(CASE WHEN mode='speed' AND correct >= 100 THEN acc END) AS speed_acc,
      MAX(CASE WHEN mode='zh' THEN cpm END) AS zh_cpm,
      MAX(CASE WHEN mode='zh' THEN acc END) AS zh_acc,
      MIN(CASE WHEN mode='falling' AND reaction_ms > 0 THEN reaction_ms END) AS reaction_ms,
      MAX(max_streak) AS max_streak,
      MAX(CASE WHEN mode='key' THEN level END) AS key_level_raw,
      MIN(ts) AS first_ts, MAX(ts) AS last_ts
    FROM record WHERE ${where.join(' AND ')}
    GROUP BY person_id`;
  return prep(sql).all(...args).map(r => {
    r.key_level = parseInt(String(r.key_level_raw || '').replace(/[^\d]/g, ''), 10) || 0;
    r.speed_seq = '[]';
    return personToBoard(rowToPerson(r));
  });
}

function rowToPerson(r) {
  const out = {
    id: r.id, school: r.school, cls: r.cls, name: r.name,
    attempts: r.attempts || 0,
    firstTs: r.first_ts, lastTs: r.last_ts,
    keyLevel: r.key_level || 0,
    speedCpm: r.speed_cpm || 0, speedAcc: r.speed_acc || 0,
    zhCpm: r.zh_cpm || 0, zhAcc: r.zh_acc || 0,
    reaction: r.reaction_ms == null ? null : r.reaction_ms,
    streak: r.max_streak || 0,
    speedSeq: []
  };
  try { out.speedSeq = JSON.parse(r.speed_seq || '[]') || []; } catch (e) { out.speedSeq = []; }
  out.best = {
    key: { score: r.key_score || 0 },
    speed: { score: r.speed_score || 0, cpm: r.speed_cpm || 0, acc: r.speed_acc || 0 },
    wordrush: { score: r.wordrush_score || 0 },
    zh: { score: r.zh_score || 0, cpm: r.zh_cpm || 0, acc: r.zh_acc || 0 },
    falling: { score: r.falling_score || 0 }
  };
  return out;
}

/* 把汇总行摊成旧版 buildBoard 里那个 rows 元素，排名逻辑一行不改 */
function personToBoard(p) {
  const SCORING = ['key', 'speed', 'wordrush', 'zh'];
  let total = 0;
  const parts = {};
  for (const m of SCORING) {
    const s = p.best[m] ? p.best[m].score : 0;
    parts[m] = s;
    total += s;
  }
  let progress = null;
  if (p.speedSeq.length >= 2) {
    const seq = p.speedSeq.slice().sort((a, b) => a.ts < b.ts ? -1 : 1);
    progress = Math.round((seq[seq.length - 1].score - seq[0].score) * 10) / 10;
  }
  return {
    id: p.id, school: p.school, cls: p.cls, name: p.name,
    total: Math.round(total * 10) / 10,
    part: parts,
    cpm: Math.round((p.best.speed ? p.best.speed.cpm : 0) * 10) / 10,
    acc: Math.round((p.best.speed ? p.best.speed.acc : 0) * 1000) / 10,
    keyLevel: p.keyLevel,
    zhCpm: Math.round(p.zhCpm * 10) / 10,
    zhAcc: Math.round(p.zhAcc * 1000) / 10,
    reaction: p.reaction,
    streak: p.streak,
    fallScore: p.best.falling ? p.best.falling.score : 0,
    progress: progress,
    attempts: p.attempts,
    lastTs: p.lastTs
  };
}

/* ============================ 错键统计 ============================ */

/**
 * 返回 { hits: {ch: 正确次数}, errs: {ch: {错打成的字: 次数}}, scanned: 参与统计的记录数 }
 */
function keyStats(opts) {
  opts = opts || {};
  const where = [], args = [];
  if (opts.school) { where.push('school = ?'); args.push(opts.school); }
  if (opts.cls) { where.push('cls = ?'); args.push(opts.cls); }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const hits = {}, errs = {};
  for (const r of prep('SELECT ch, SUM(n) AS n FROM key_hit' + w + ' GROUP BY ch').all(...args)) {
    hits[r.ch] = r.n;
  }
  for (const r of prep('SELECT ch, wrong_ch, SUM(n) AS n FROM key_err' + w +
    ' GROUP BY ch, wrong_ch').all(...args)) {
    if (!errs[r.ch]) errs[r.ch] = {};
    errs[r.ch][r.wrong_ch] = r.n;
  }

  const rw = where.length ? ' AND ' + where.join(' AND ') : '';
  const scanned = (prep('SELECT COUNT(*) AS n FROM record WHERE 1=1' + rw).get(...args) || {}).n || 0;
  return { hits: hits, errs: errs, scanned: scanned };
}

/* ============================ 统计 / 列表 / 维护 ============================ */

function stats() {
  const recs = (prep('SELECT COUNT(*) AS n FROM record').get() || {}).n || 0;
  const stu = (prep('SELECT COUNT(*) AS n FROM person').get() || {}).n || 0;
  return { totalRecords: recs, students: stu };
}

/* CSV 导出用：按时间升序全量取（字段名对齐旧版） */
function allRecords() {
  return prep(`SELECT person_id AS id, school, cls, name, mode, mode_name AS modeName,
      level, cpm, wpm, acc, correct, wrong, sec, diff, score,
      qualified, over_cap AS overCap, unified, material, ts
    FROM record ORDER BY ts_ms ASC`).all().map(r => ({
      id: r.id, school: r.school, cls: r.cls, name: r.name, mode: r.mode,
      modeName: r.modeName, level: r.level, cpm: r.cpm, wpm: r.wpm, acc: r.acc,
      correct: r.correct, wrong: r.wrong, sec: r.sec, diff: r.diff, score: r.score,
      qualified: !!r.qualified, overCap: !!r.overCap, unified: !!r.unified,
      material: r.material, ts: r.ts
    }));
}

/* 某班最新记录（教师端看板"最近提交"用；当前版本未使用，留给后续） */
function recentRecords(limit) {
  return prep('SELECT * FROM record ORDER BY ts_ms DESC LIMIT ?').all(limit || 50);
}

function clearRecords() {
  tx(() => {
    db.exec('DELETE FROM record');
    db.exec('DELETE FROM person');
    db.exec('DELETE FROM key_hit');
    db.exec('DELETE FROM key_err');
  });
}

/* 数据库体检：页数、碎片，启动时打一行日志，方便判断要不要 VACUUM */
function dbInfo() {
  const pageCount = (prep('PRAGMA page_count').get() || {}).page_count || 0;
  const pageSize = (prep('PRAGMA page_size').get() || {}).page_size || 0;
  const freeList = (prep('PRAGMA freelist_count').get() || {}).freelist_count || 0;
  return {
    bytes: pageCount * pageSize,
    freeBytes: freeList * pageSize,
    file: filePath
  };
}

/* 热备份：SQLite 官方推荐的 VACUUM INTO，导出一个一致的副本，运行中也能做 */
function backupTo(target) {
  try { fs.unlinkSync(target); } catch (e) { }
  prep('VACUUM INTO ?').run(target);
  return fs.statSync(target).size;
}

/* ============================ 从旧版 db.json 迁移 ============================ */

/**
 * 把旧版 db.json 里的成绩数组导入 SQLite，并回填 person / 错键聚合。
 * 传数组而不是文件路径 —— 调用方已经为了读配置解析过一次，
 * 这里再解析一遍会让 300 MB 级的文件内存峰值翻倍（实测直接堆溢出）。
 * @returns {{records:number, students:number, ms:number}|null}  null = 没有可迁移的数据
 */
function migrateRecords(recs, countFn) {
  if (!Array.isArray(recs) || !recs.length) return null;

  const t0 = Date.now();
  beginBulk();
  try {
  let done = 0;
  for (const r of recs) {
    /* 几十万条要跑一两分钟，每 5 万条打一行，免得看着像卡死 */
    if (++done % 50000 === 0) {
      console.log('    迁移进度 ' + done + ' / ' + recs.length +
        '（' + ((Date.now() - t0) / 1000).toFixed(0) + ' s）');
    }
    /* 旧数据可能缺字段，补默认值后再走同一套累加逻辑 */
    const full = Object.assign({
      key: '', school: '', cls: '', name: '', mode: 'speed', modeName: '',
      level: '', cpm: 0, wpm: 0, acc: 0, correct: 0, wrong: 0, sec: 0,
      diff: 1, score: 0, qualified: false, overCap: false, unified: false,
      material: '', keys: { hits: {}, errs: {} }, ts: new Date().toISOString()
    }, r);
    /* 计入榜单的口径由调用方给（未达标/超速的只记账） */
    const count = typeof countFn === 'function' ? !!countFn(full) : !!full.qualified;
    addRecord(full, { count: count });
  }
  } catch (e) { bulkDepth = 0; try { db.exec('ROLLBACK'); } catch (e2) { } throw e; }
  endBulk();
  return { records: recs.length, students: stats().students, ms: Date.now() - t0 };
}

/* 关库但不上抛异常：给退出流程用 */
function closeQuiet() {
  try { close(); return true; } catch (e) { return false; }
}

const api = {
  open, close, closeQuiet, metaGet, metaSet,
  addRecord, boardRows, keyStats, stats,
  allRecords, recentRecords, clearRecords,
  dbInfo, backupTo, migrateRecords
};

module.exports = api;
