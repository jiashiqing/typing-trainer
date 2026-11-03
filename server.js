'use strict';
/*
 * 全县中小学生打字练习系统 —— 教师机服务端
 * ------------------------------------------------------------------
 * 零第三方依赖（只用 Node 内置模块）：
 *   · 托管 public/ 下的学生端、教师端、大屏看板
 *   · 接收学生端心跳与成绩，服务端统一计算得分与排行榜
 *   · SSE 长连接，把变化实时推给教师端 / 大屏 / 学生端榜单
 *   · 内置二维码编码，大屏直接显示学生入口码
 *
 * 启动：node server.js   （或双击 start.bat）
 * 端口：默认 8090，可用环境变量 PORT 覆盖
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const QR = require('./lib/qrcode.js');
const XL = require('./lib/xlsx.js');

/* node:sqlite 目前标着实验特性，启动会打一行告警。只静音这一条，其他告警照常输出。 */
const _emitWarning = process.emitWarning;
process.emitWarning = function (w) {
  const msg = typeof w === 'string' ? w : (w && w.message) || '';
  if (/SQLite is an experimental feature/i.test(msg)) return;
  return _emitWarning.apply(process, arguments);
};
const store = require('./lib/store.js');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.sqlite');   // 运行数据库
const DATA_FILE = path.join(DATA_DIR, 'db.json');   // 旧版数据文件，仅用于一次性迁移
const START_PORT = parseInt(process.env.PORT || '8090', 10);
const BOOT_AT = Date.now();        // 启动时刻，/api/ping 里回传，方便判断是不是"今早那个实例"

/* 部署相关（默认值 = 现在的局域网用法，不设任何变量照样能跑） */
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');  // 例 https://dazi.example.com
const BIND_HOST = String(process.env.BIND_HOST || '0.0.0.0');                  // 公网部署建议 127.0.0.1
const CORS_ORIGIN = String(process.env.CORS_ORIGIN || '');                     // 留空 = 只允许同源
const HIDE_CODES = process.env.HIDE_CODES === '1';                              // 日志里不打访问码
const ENABLE_SHUTDOWN = process.env.ENABLE_SHUTDOWN !== '0';                    // 设 0 彻底关掉本机停止接口

const ONLINE_TTL = 60 * 1000;      // 超过 60s 没心跳视为离线（学生停下来听讲时不至于"消失"）
const DROP_TTL = 20 * 60 * 1000;   // 离线超 20 分钟从实时列表移除
const FEED_MAX = 80;
const ACC_GATE = 0.60;             // 准确率门槛：低于此值不计入排行榜（60% 以下只记账，不进榜、不计分）
/* 改这个值之后，同步改这三处静态说明文案（搜「准确率」即可找到）：
 *   public/index.html · public/teacher.html · public/screen.html
 * 计算与判断逻辑已全部改为引用本常量，只有给人看的句子是写死的。 */
const MIN_SAMPLE = 30;             // 最少有效字符数，样本太小不算成绩

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8'
};

/* ============================ 难度系数表 ============================ */
/* 单次得分 = 有效CPM × 难度系数。有效CPM 只为正确字符计速，乱打不涨分。 */
const DIFF = {
  'key:1': 0.80, 'key:2': 0.85, 'key:3': 0.90, 'key:4': 1.00, 'key:5': 1.10,
  'falling': 1.00,
  'speed:keys': 0.90, 'speed:word': 1.05, 'speed:num': 1.10, 'speed:text': 1.20,
  'wordrush:1': 1.00, 'wordrush:2': 1.10, 'wordrush:3': 1.20,
  /* 中文按"字/分钟"计速，与英文 CPM 不是一个量纲，所以单独排行、单独给系数 */
  'zh:1': 1.00, 'zh:2': 1.10, 'zh:3': 1.20
};
const MODE_NAME = {
  key: '键位闯关', falling: '落字游戏', speed: '速度练习', wordrush: '单词冲刺',
  zh: '中文跟打'
};
/* 参与总分的四种模式；落字游戏只进手速榜（随机性大，横向不可比） */
const SCORING_MODES = ['key', 'speed', 'wordrush', 'zh'];
/* 中文样本门槛比英文低一些：30 个字差不多就是 40 秒的练习量 */
const MIN_SAMPLE_ZH = 20;
/* 速度上限（防刷）：正常小学生中文 20—60 字/分、英文 80—200 字符/分，
   超过这个数只可能是粘贴或脚本。超限的成绩照收但不进榜，动态流里标出来。 */
const CPM_CAP = { zh: 250, speed: 1000, wordrush: 1000, key: 1000 };
function capOf(mode) { return CPM_CAP[mode] || 1000; }

function diffOf(mode, level) {
  return DIFF[mode + ':' + level] || DIFF[level] || 1.0;
}

/* ============================ 默认学校班级 ============================ */
/* 这是占位模板，请教师在「课堂管理 → 学校班级」里改成本县真实名单 */
const DEFAULT_SCHOOLS = [
  { name: '第一实验小学', classes: ['三年级1班', '三年级2班', '四年级1班', '四年级2班', '五年级1班', '六年级1班'] },
  { name: '第二实验小学', classes: ['三年级1班', '四年级1班', '五年级1班', '六年级1班'] },
  { name: '城关中心小学', classes: ['三年级1班', '三年级2班', '四年级1班', '五年级1班'] },
  { name: '新城学校', classes: ['三年级1班', '四年级1班', '五年级1班', '七年级1班'] },
  { name: '第一初级中学', classes: ['七年级1班', '七年级2班', '八年级1班', '八年级2班', '九年级1班'] },
  { name: '实验初级中学', classes: ['七年级1班', '八年级1班', '九年级1班'] }
];

/* ============================ 账号与权限 ============================ */
/* 两档角色：admin（超级管理员，可导入/修改学校班级）、teacher（普通教师，只能用课堂功能）
   访问码保存在 data/db.json 的 auth 字段里，第一次启动自动写入下面这两个默认值，
   之后请自行修改（方法见《使用说明.md》）。 */
const DEFAULT_AUTH = {
  adminCode: 'admin888',
  teacherCode: 'teacher888',
  secret: ''
};
const ROLE_NAME = { admin: '超级管理员', teacher: '普通教师' };
const TOKEN_HOURS = 12;

/* ============================ 数据层 ============================ */
let db = {
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  schools: DEFAULT_SCHOOLS,
  unified: { on: false, mode: 'speed', level: 'text', sec: 120 },
  auth: Object.assign({}, DEFAULT_AUTH),
  materials: [],                    // 教师导入的练习文本（中文/英文）
  feed: []                          // 动态流（环形缓冲，只留最近 80 条）
};
let live = Object.create(null);   // id -> 实时状态（内存，不落盘）
let feedSeq = 0;

function nowISO() { return new Date().toISOString(); }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function hhmmss(d) {
  const t = d || new Date();
  return pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
}
function makeId(school, cls, name) {
  return [String(school || '').trim(), String(cls || '').trim(), String(name || '').trim()]
    .join('|');
}

/* ============================ 登录令牌 ============================ */
/* 用内置 crypto 做 HMAC 签名，不落盘、不入库：role + 过期时间 + 签名。
   重启服务不会让签名失效（密钥存 db.auth.secret），改访问码也不会。 */
function signToken(role) {
  const exp = Date.now() + TOKEN_HOURS * 3600 * 1000;
  const body = role + '.' + exp;
  const sig = crypto.createHmac('sha256', db.auth.secret).update(body).digest('base64url');
  return Buffer.from(body, 'utf8').toString('base64url') + '.' + sig;
}

function verifyToken(tok) {
  if (!tok || typeof tok !== 'string' || tok.indexOf('.') < 0) return null;
  const parts = tok.split('.');
  if (parts.length !== 2) return null;
  let body;
  try { body = Buffer.from(parts[0], 'base64url').toString('utf8'); } catch (e) { return null; }
  const expect = crypto.createHmac('sha256', db.auth.secret).update(body).digest('base64url');
  const a = Buffer.from(expect), b = Buffer.from(parts[1]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const idx = body.lastIndexOf('.');
  const role = body.slice(0, idx), exp = Number(body.slice(idx + 1));
  if (!ROLE_NAME[role] || !(exp > Date.now())) return null;
  return { role: role, exp: exp };
}

/* 取请求里的身份；不给 token 就返回 null */
function whoAmI(req, url) {
  const h = req.headers['x-token'] || (url && url.searchParams.get('token')) || '';
  return verifyToken(String(h).trim());
}

/**
 * 权限拦截。
 * @param {'teacher'|'admin'} need  teacher = 登录即可；admin = 必须是超级管理员
 * @returns {boolean} true = 不通过（响应已写回，调用方直接 return）
 */
function blocked(res, me, need) {
  if (!me) { sendJSON(res, { ok: false, error: '请先登录教师端', needLogin: true }, 401); return true; }
  if (need === 'admin' && me.role !== 'admin') {
    sendJSON(res, { ok: false, error: '只有超级管理员才能修改学校班级名单', needAdmin: true }, 403);
    return true;
  }
  return false;
}

function loadData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  store.open(DB_FILE);

  /* 配置类数据（学校名单/练习文本/统一测评/访问码/动态流）很小，整块存 meta 表 */
  const cfg = store.metaGet('config', null);

  if (cfg) {
    applyConfig(cfg);
  } else {
    /* 第一次启用 SQLite：如果旧版 db.json 还在，把成绩和配置一起接管过来 */
    let legacy = null;
    if (fs.existsSync(DATA_FILE)) {
      try { legacy = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { legacy = null; }
      if (legacy) {
        const mig = store.migrateRecords(legacy.records, function (r) {
          /* 与旧版榜单口径一致：未达标或超速的记录只记账、不计入汇总 */
          return !!r.qualified && !(Number(r.cpm) > capOf(r.mode));
        });
        if (mig) {
          console.log('  已从 db.json 迁移 ' + mig.records + ' 条成绩（' +
            mig.students + ' 名学生，耗时 ' + (mig.ms / 1000).toFixed(1) + ' s）');
        }
        /* 迁移完立刻松手，别让几百 MB 的对象一直占着内存 */
        legacy.records = null;
      }
    }
    applyConfig({
      schools: (legacy && Array.isArray(legacy.schools) && legacy.schools.length)
        ? legacy.schools : db.schools,
      unified: Object.assign({}, db.unified, (legacy && legacy.unified) || {}),
      auth: (legacy && legacy.auth) || null,
      materials: (legacy && Array.isArray(legacy.materials)) ? legacy.materials : [],
      feed: (legacy && Array.isArray(legacy.feed)) ? legacy.feed.slice(0, FEED_MAX) : [],
      createdAt: (legacy && legacy.createdAt) || db.createdAt
    });
    save();
    /* 迁移完把旧文件改名留底，不删 —— 万一要回退还能用 */
    if (legacy) {
      const bak = DATA_FILE.replace(/\.json$/, '.migrated-' +
        new Date().toISOString().slice(0, 10) + '.json');
      try { fs.renameSync(DATA_FILE, bak); console.log('  旧数据文件已改名留底：' + path.basename(bak)); }
      catch (e) { console.log('  [提示] 旧数据文件改名失败，可手动删除 db.json'); }
    }
  }

  /* 密钥只生成一次：换掉它等于让所有已登录的教师端重新登录 */
  if (!db.auth.secret) { db.auth.secret = crypto.randomBytes(24).toString('hex'); save(); }

  const st = store.stats();
  console.log('  已载入历史成绩：' + st.totalRecords + ' 条，参与学生 ' + st.students + ' 人');
}

/* 把 meta 里那块配置装回内存 */
function applyConfig(c) {
  if (!c || typeof c !== 'object') return;
  if (Array.isArray(c.schools) && c.schools.length) db.schools = c.schools;
  if (Array.isArray(c.materials)) db.materials = c.materials;
  if (Array.isArray(c.feed)) db.feed = c.feed.slice(0, FEED_MAX);
  if (c.unified) db.unified = Object.assign(db.unified, c.unified);
  if (c.auth && typeof c.auth === 'object') {
    db.auth.adminCode = String(c.auth.adminCode || DEFAULT_AUTH.adminCode);
    db.auth.teacherCode = String(c.auth.teacherCode || DEFAULT_AUTH.teacherCode);
    db.auth.secret = String(c.auth.secret || '');
  }
  if (c.createdAt) db.createdAt = c.createdAt;
  feedSeq = db.feed.reduce(function (m, x) { return Math.max(m, Number(x.id) || 0); }, 0);
}

let saveTimer = null;

/* 只存配置（几 KB），成绩走 store 里的 INSERT，不再整份重写 */
function save() {
  db.updatedAt = nowISO();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    try { flush(); } catch (e) { console.error('[警告] 配置写入失败：' + e.message); }
  }, 300);
}

function flush() {
  try {
    store.metaSet('config', {
      version: db.version,
      createdAt: db.createdAt,
      updatedAt: db.updatedAt,
      schools: db.schools,
      unified: db.unified,
      auth: db.auth,
      materials: db.materials,
      feed: db.feed
    });
    return true;
  } catch (e) { return false; }
}

function pushFeed(name, text, kind, meta) {
  const item = {
    id: ++feedSeq, ts: nowISO(), time: hhmmss(), name: name || '',
    text: text, kind: kind || 'info', meta: meta || null
  };
  db.feed.unshift(item);
  if (db.feed.length > FEED_MAX) db.feed.length = FEED_MAX;
  return item;
}

/* ============================ 成绩计算 ============================ */
/*
 * 学生端只上报原始数据（正确字符、错误字符、用时、错键明细），
 * 得分与是否达标全部在服务端算 —— 前端改一个数不产生任何好处。
 */
function computeResult(raw) {
  const mode = String(raw.mode || '').trim();
  const level = String(raw.level || '').trim();
  if (!MODE_NAME[mode]) return { ok: false, error: '未知练习模式' };

  const correct = Math.max(0, Math.round(Number(raw.correct) || 0));
  const wrong = Math.max(0, Math.round(Number(raw.wrong) || 0));
  const sec = Math.max(1, Number(raw.sec) || 0);
  const total = correct + wrong;
  const acc = total > 0 ? correct / total : 0;

  /* 有效 CPM：只算正确字符 / 用时（分钟）；中文即"字/分钟" */
  const cpm = Math.round(correct / (sec / 60) * 10) / 10;
  const wpm = Math.round(cpm / 5 * 10) / 10;
  const diff = diffOf(mode, level);
  const score = Math.round(cpm * diff * 10) / 10;
  const needSample = mode === 'zh' ? MIN_SAMPLE_ZH : MIN_SAMPLE;
  const cap = capOf(mode);
  const overCap = cpm > cap;
  const qualified = (acc >= ACC_GATE) && (correct >= needSample) && !overCap;

  return {
    ok: true,
    record: {
      id: '', school: '', cls: '', name: '',
      mode: mode, modeName: MODE_NAME[mode], level: level,
      cpm: cpm, wpm: wpm, acc: Math.round(acc * 1000) / 1000,
      correct: correct, wrong: wrong, sec: sec,
      diff: diff, score: score, qualified: qualified,
      overCap: overCap,
      unified: !!raw.unified,
      /* 中文跟打记下用的是哪篇文本，教师端和导出 CSV 里能看出练的什么 */
      material: mode === 'zh' ? String(raw.material || '').slice(0, 40) : '',
      keys: sanitizeKeys(raw.keys),
      ts: nowISO(), time: hhmmss()
    }
  };
}

/* 错键明细白名单化，只留字符 → 次数，防止脏数据 */
function sanitizeKeys(keys) {
  const outH = {}, outE = {};
  if (!keys || typeof keys !== 'object') return { hits: outH, errs: outE };
  const hits = keys.hits || {}, errs = keys.errs || {};
  for (const k of Object.keys(hits).slice(0, 200)) {
    const n = Math.round(Number(hits[k]) || 0);
    if (n > 0 && k.length <= 4) outH[k] = Math.min(n, 99999);
  }
  for (const k of Object.keys(errs).slice(0, 200)) {
    if (k.length > 4) continue;
    const m = errs[k];
    if (!m || typeof m !== 'object') continue;
    const sub = {};
    for (const c of Object.keys(m).slice(0, 60)) {
      const n = Math.round(Number(m[c]) || 0);
      if (n > 0 && c.length <= 4) sub[c] = Math.min(n, 9999);
    }
    if (Object.keys(sub).length) outE[k] = sub;
  }
  return { hits: outH, errs: outE };
}

/* ============================ 排行榜 ============================ */
/*
 * 个人总分 = 键位闯关最高分 + 速度练习最高分 + 单词冲刺最高分
 *   · 同一模式只取最高一次 → 重复刷同一段文本不会累加（防刷）
 *   · 键位闯关按通过的最高一关计入，不叠加各关
 *   · 准确率 < 85% 的成绩不进榜
 */
function buildBoard(opts) {
  opts = opts || {};
  const school = opts.school || '';
  const cls = opts.cls || '';
  const onlyUnified = !!opts.onlyUnified;

  /* 榜单数据直接从 SQLite 的 person 汇总表读（一人一行），
     不再每次把全部成绩扫一遍 —— 30 万条规模下这一步从 81 ms 降到 1 ms 量级 */
  const rows = store.boardRows({ school: school, cls: cls, onlyUnified: onlyUnified });

  /* 默认按总分排；同分同速时按 id 兜底，保证多次刷新名次稳定 */
  rows.sort((a, b) => b.total - a.total || b.cpm - a.cpm || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  /* 附带各分榜的名次，前端一次拿全 */
  const rankBy = (key, asc) => {
    const arr = rows.filter(r => r[key] != null && r[key] > 0).slice();
    arr.sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]);
    const m = {};
    arr.forEach((r, i) => { m[r.id] = i + 1; });
    return m;
  };
  const rankSpeed = rankBy('cpm', false);
  const rankAcc = rankBy('acc', false);
  const rankReact = rankBy('reaction', true);
  const rankZh = rankBy('zhCpm', false);

  rows.forEach((r, i) => {
    r.rank = i + 1;
    r.rankSpeed = rankSpeed[r.id] || 0;
    r.rankAcc = rankAcc[r.id] || 0;
    r.rankReact = rankReact[r.id] || 0;
    r.rankZh = rankZh[r.id] || 0;
  });

  return rows;
}

/* ============================ 错键聚合 ============================ */
function buildKeyStats(opts) {
  opts = opts || {};
  const school = opts.school || '';
  const cls = opts.cls || '';
  /* 错键数据取自实时维护的聚合表，不再每次把全部记录的错键明细重算一遍 */
  const agg = store.keyStats({ school: school, cls: cls });
  const hits = agg.hits, errs = agg.errs;
  const scanned = agg.scanned;

  /* 汇总成：每键 正确数 / 错误数 / 错误率 / 最常误打成什么 */
  const chars = {};
  const all = new Set([...Object.keys(hits), ...Object.keys(errs)]);
  let totalErr = 0, totalHit = 0;
  for (const ch of all) {
    let en = 0, top = '', topN = 0;
    const sub = errs[ch] || {};
    for (const c of Object.keys(sub)) {
      en += sub[c];
      if (sub[c] > topN) { topN = sub[c]; top = c; }
    }
    const hn = hits[ch] || 0;
    chars[ch] = {
      hit: hn, err: en, total: hn + en,
      rate: (hn + en) > 0 ? Math.round(en / (hn + en) * 1000) / 10 : 0,
      top: top, topN: topN
    };
    totalErr += en; totalHit += hn + en;
  }

  const list = Object.keys(chars)
    .map(ch => Object.assign({ ch: ch }, chars[ch]))
    .filter(x => x.total >= 3)
    .sort((a, b) => b.err - a.err || b.rate - a.rate);

  return {
    scanned: scanned,
    chars: chars,
    top: list.slice(0, 20),
    totalErr: totalErr,
    totalHit: totalHit,
    avgRate: totalHit > 0 ? Math.round(totalErr / totalHit * 1000) / 10 : 0
  };
}

/* ============================ 实时列表 ============================ */
/*
 * 一条在线记录。抽出来是为了「增量推送」：
 *   一次心跳 / 一次提交只推自己这一条（约 300 B），不再推整张在线列表。
 *   120 人在线时整张列表是 36 KB，5,000 人就是 1.5 MB —— 每 6 秒推给每个客户端，
 *   比整份榜单还贵。这里改成谁变了推谁。
 */
function liveRow(id) {
  const v = live[id];
  if (!v) return null;
  const now = Date.now();
  return {
    id: id,
    school: v.school || '', cls: v.cls || '', name: v.name || '',
    mode: v.mode || '', modeName: MODE_NAME[v.mode] || '',
    progress: Math.max(0, Math.min(1, Number(v.progress) || 0)),
    cpm: Number(v.cpm) || 0,
    acc: Number(v.acc) || 0,
    keys: Number(v.keys) || 0,
    status: v.status || '',
    dup: !!v.dup,
    online: (now - v.lastSeen) < ONLINE_TTL
  };
}

function cmpLive(a, b) {
  if ((a.cls || '') !== (b.cls || '')) return String(a.cls).localeCompare(String(b.cls), 'zh');
  return String(a.name).localeCompare(String(b.name), 'zh');
}

/* 全量列表只在 init 快照里用 */
function liveList() {
  return Object.keys(live).map(liveRow).filter(Boolean).sort(cmpLive);
}

function onlineCount() {
  const now = Date.now();
  let n = 0;
  for (const k of Object.keys(live)) if (now - live[k].lastSeen < ONLINE_TTL) n++;
  return n;
}

/* 增量推送用的「可显示状态指纹」：只有这些字段变了才值得推一次。
   特意不含 lastSeen —— 它每次心跳都变，含进去就等于每次都推。 */
function liveSig(r) {
  return r.mode + '|' + r.progress + '|' + r.cpm + '|' + r.acc + '|' + r.keys +
    '|' + r.status + '|' + (r.dup ? 1 : 0) + '|' + (r.online ? 1 : 0) +
    '|' + r.school + '|' + r.cls + '|' + r.name;
}
const liveSigMap = new Map();

function snapshot() {
  return {
    updatedAt: db.updatedAt,
    serverTime: nowISO(),
    schools: db.schools,
    unified: db.unified,
    /* 只给摘要：正文走 /api/materials，避免每次推送都带几十 KB 文本 */
    materials: db.materials.map(matSummary),
    diffTable: DIFF,
    accGate: ACC_GATE,
    minSample: MIN_SAMPLE,
    live: liveList(),
    board: buildBoard({}),
    keys: buildKeyStats({}),
    feed: db.feed,
    stats: (function () {
      const st = store.stats();
      return {
        totalRecords: st.totalRecords,
        students: st.students,
        online: onlineCount()
      };
    })(),
    net: netInfo()
  };
}

/* ============================ SSE ============================ */
const clients = new Set();

function writeEvent(res, type, data) {
  try { res.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
  catch (e) { clients.delete(res); }
}
function broadcast(type, data) {
  for (const r of Array.from(clients)) writeEvent(r, type, data);
}

setInterval(() => {
  for (const r of Array.from(clients)) {
    try { r.write(': ping\n\n'); } catch (e) { clients.delete(r); }
  }
}, 15000);

/* 定时清理离线 + 增量广播在线状态
 * 只推「状态指纹变了的那几条」和「被移除的那几个」，不再每 6 秒推整张列表。 */
setInterval(() => {
  const now = Date.now();
  const removed = [];
  for (const k of Object.keys(live)) {
    if (now - live[k].lastSeen > DROP_TTL) { delete live[k]; liveSigMap.delete(k); removed.push(k); }
  }
  if (!clients.size) return;

  const upd = [];
  for (const k of Object.keys(live)) {
    const r = liveRow(k);
    const s = liveSig(r);
    if (liveSigMap.get(k) !== s) { liveSigMap.set(k, s); upd.push(r); }
  }
  if (!upd.length && !removed.length) return;
  broadcast('live', { liveUpd: upd, liveDel: removed, online: onlineCount() });
}, 6000);

/* ============================ 工具 ============================ */
function sendJSON(res, obj, code) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Accept-Encoding'
  };
  /* 默认不发 CORS 头：前端和接口同源，不需要跨域。
     以前写死 origin:* 等于"任何网站都能读走全校学生数据"，公网上是硬伤。
     真要让别的域来调，设 CORS_ORIGIN=https://xxx 显式放行那一个。 */
  if (CORS_ORIGIN) headers['Access-Control-Allow-Origin'] = CORS_ORIGIN;
  /* 榜单在几千人规模下有 2 MB，压缩后只占十分之一 —— 局域网也经不起每次刷新都传 2 MB */
  const ae = String((res.req && res.req.headers && res.req.headers['accept-encoding']) || '');
  if (body.length >= 2048 && ae.indexOf('gzip') >= 0) {
    zlib.gzip(body, { level: 6 }, (err, gz) => {
      if (err || res.headersSent) {
        headers['Content-Length'] = body.length;
        res.writeHead(code || 200, headers);
        return res.end(body);
      }
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = gz.length;
      res.writeHead(code || 200, headers);
      res.end(gz);
    });
    return;
  }
  headers['Content-Length'] = body.length;
  res.writeHead(code || 200, headers);
  res.end(body);
}
function sendText(res, text, code, mime) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code || 200, {
    'Content-Type': mime || 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { resolve({ __raw: raw }); }
    });
    req.on('error', reject);
  });
}

function netInfo() {
  const list = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) list.push({ name: name, address: ni.address });
    }
  }
  const score = a => {
    if (/^192\.168\./.test(a)) return 0;
    if (/^10\./.test(a)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return 2;
    if (/^169\.254\./.test(a)) return 9;
    return 5;
  };
  list.sort((a, b) => score(a.address) - score(b.address));
  const port = server && server.address() ? server.address().port : START_PORT;
  const primary = list.length ? list[0].address : 'localhost';
  /* 部署在公网上时，二维码和提示必须指向公网域名 —— 局域网的 192.168.x.x
     学生手机扫了打不开。设 PUBLIC_URL 就整体切过去。 */
  const base = PUBLIC_URL || ('http://' + primary + ':' + port);
  return {
    port: port,
    ips: list,
    primary: primary,
    publicBase: PUBLIC_URL || '',
    studentUrl: base + '/',
    teacherUrl: base + '/teacher',
    screenUrl: base + '/screen'
  };
}

/* 名单清洗：统一在这里做长度限制 / 去重，POST 与导入两条路都走它 */
function normSchools(list) {
  const seen = Object.create(null);
  const out = [];
  for (const s of list || []) {
    if (!s) continue;
    const name = String(s.name || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!name || seen[name]) {
      if (name && seen[name]) {
        /* 同名学校合并班级，别让导入把一所学校拆成两行 */
        for (const c of s.classes || []) {
          const cc = String(c).replace(/\s+/g, ' ').trim().slice(0, 30);
          if (cc && seen[name].classes.indexOf(cc) < 0) seen[name].classes.push(cc);
        }
      }
      continue;
    }
    const item = { name: name, classes: [] };
    for (const c of (Array.isArray(s.classes) ? s.classes : [])) {
      const cc = String(c).replace(/\s+/g, ' ').trim().slice(0, 30);
      if (cc && item.classes.indexOf(cc) < 0 && item.classes.length < 60) item.classes.push(cc);
    }
    seen[name] = item;
    out.push(item);
  }
  return out;
}

/* ============================ 练习文本库 ============================ */
/* 教师在「课堂管理 → 练习文本库」里导入的中文/英文语料，学生端可直接选来练。 */
function matSummary(m) {
  return {
    id: m.id, title: m.title, lang: m.lang, level: m.level,
    words: m.words, by: m.by || '', ts: m.ts
  };
}

function cleanBody(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countWords(text, lang) {
  if (lang === 'en') return String(text).trim().split(/\s+/).filter(Boolean).length;
  /* 中文按"字"算：去掉空白与换行，标点也算一个输入单位 */
  return String(text).replace(/\s+/g, '').length;
}

/* 文本要能当练习语料：中文至少 20 字、英文至少 20 词；上限 3000 字防止塞进一本书 */
function normMaterial(b) {
  const lang = b.lang === 'en' ? 'en' : 'zh';
  const title = String(b.title || '').trim().slice(0, 30);
  const body = cleanBody(b.body);
  const level = ['1', '2', '3'].indexOf(String(b.level)) >= 0 ? String(b.level) : '2';
  const words = countWords(body, lang);

  if (!title) return { error: '请填写一个标题，学生端下拉框里要显示它' };
  if (words < 20) return { error: '文本太短了（至少 20 个' + (lang === 'en' ? '单词' : '字') + '），学生一分钟就打完了' };
  if (words > 3000) return { error: '文本超过 3000 字，请拆成几篇分别导入' };
  return {
    id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: title, lang: lang, level: level, body: body, words: words,
    by: String(b.by || '').slice(0, 20), ts: nowISO()
  };
}

/* ============================ API ============================ */
async function handleAPI(req, res, url) {
  const p = url.pathname;
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Token'
    });
    return res.end();
  }

  /* --- 健康探针：判断某个端口上跑的是不是本系统（用于防重复启动） --- */
  if (p === '/api/ping' && method === 'GET') {
    const a = server.address();
    return sendJSON(res, {
      app: 'typing-trainer', pid: process.pid, port: a ? a.port : null,
      online: onlineCount(), records: 0, startedAt: BOOT_AT
    });
  }

  /* --- 本机停止：给「停止服务.bat」用 ---
   * 只接受来自本机回环地址的请求，且**不看 X-Forwarded-For**（那个头能伪造）。
   * 能在这台机器上发请求的人本来就能结束进程，所以不额外要令牌。 */
  if (p === '/api/shutdown' && method === 'POST') {
    if (!ENABLE_SHUTDOWN) {
      return sendJSON(res, { ok: false, error: '本接口已关闭，请用 systemctl stop 停止服务' }, 403);
    }
    /* 关键：经反向代理进来的请求一律不认。
       Nginx 转发后 socket.remoteAddress 会变成 127.0.0.1，只看它等于"公网谁都能停服务"。 */
    const viaProxy = !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['forwarded']);
    const ra = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (viaProxy || !(ra === '127.0.0.1' || ra === '::1')) {
      return sendJSON(res, { ok: false, error: '只允许本机直接操作' }, 403);
    }
    sendJSON(res, { ok: true, pid: process.pid });
    setTimeout(() => gracefulExit('收到本机停止指令。'), 400);
    return;
  }

  /* --- 全量状态 --- */
  if (p === '/api/state' && method === 'GET') return sendJSON(res, snapshot());

  /* --- 实时推送 --- */
  if (p === '/api/stream' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    writeEvent(res, 'init', snapshot());
    req.on('close', () => clients.delete(res));
    req.on('error', () => clients.delete(res));
    return;
  }

  if (p === '/api/netinfo' && method === 'GET') return sendJSON(res, netInfo());

  /* --- 登录：凭访问码换令牌 --- */
  if (p === '/api/auth' && method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    const code = String(b.code || '').trim();
    if (!code) return sendJSON(res, { ok: false, error: '请输入访问码' }, 400);

    let role = '';
    if (code === db.auth.adminCode) role = 'admin';
    else if (code === db.auth.teacherCode) role = 'teacher';
    if (!role) {
      console.log('  [' + hhmmss() + '] 教师端登录失败（访问码不对）');
      return sendJSON(res, { ok: false, error: '访问码不对，请向管理员确认' }, 401);
    }
    const token = signToken(role);
    console.log('  [' + hhmmss() + '] 教师端登录：' + ROLE_NAME[role]);
    return sendJSON(res, {
      ok: true, role: role, roleName: ROLE_NAME[role], token: token,
      expires: Date.now() + TOKEN_HOURS * 3600 * 1000
    });
  }

  /* --- 用现有令牌换回身份（刷新页面不失忆） --- */
  if (p === '/api/auth/me' && method === 'GET') {
    const me = whoAmI(req, url);
    if (!me) return sendJSON(res, { ok: false, needLogin: true }, 401);
    return sendJSON(res, { ok: true, role: me.role, roleName: ROLE_NAME[me.role], expires: me.exp });
  }

  /* --- 二维码 --- */
  if (p === '/api/qr' && method === 'GET') {
    const text = url.searchParams.get('text') || netInfo().studentUrl;
    const ecc = (url.searchParams.get('ecc') || 'M').toUpperCase();
    try {
      const q = QR.encode(text, ecc);
      return sendJSON(res, { text: text, version: q.version, ecc: q.ecc, size: q.size, modules: q.modules });
    } catch (e) {
      return sendJSON(res, { error: e.message }, 400);
    }
  }

  /* --- 名单：学校 + 班级（读取不设限，学生登录页要用） --- */
  if (p === '/api/schools' && method === 'GET') return sendJSON(res, { schools: db.schools });

  if (p === '/api/schools' && method === 'POST') {
    if (blocked(res, whoAmI(req, url), 'admin')) return;
    const b = await readBody(req);
    if (!Array.isArray(b.schools)) return sendJSON(res, { ok: false, error: '格式错误' }, 400);
    db.schools = normSchools(b.schools);
    save();
    broadcast('config', { schools: db.schools, unified: db.unified });
    console.log('  [' + hhmmss() + '] 管理员更新学校班级名单：' + db.schools.length + ' 所学校');
    return sendJSON(res, { ok: true, schools: db.schools });
  }

  /* --- Excel / CSV 名单：先预览（不落盘），确认后再导入 --- */
  if (p === '/api/schools/preview' && method === 'POST') {
    if (blocked(res, whoAmI(req, url), 'admin')) return;
    const b = await readBody(req).catch(() => ({}));
    const file = String(b.file || '');
    if (!file) return sendJSON(res, { ok: false, error: '没有收到文件' }, 400);

    let buf;
    try { buf = Buffer.from(file, 'base64'); } catch (e) { return sendJSON(res, { ok: false, error: '文件读取失败' }, 400); }
    if (!buf.length) return sendJSON(res, { ok: false, error: '文件是空的' }, 400);
    if (buf.length > 4 * 1024 * 1024) return sendJSON(res, { ok: false, error: '文件超过 4MB，请精简后再导入' }, 400);

    try {
      const r = XL.parseFile(buf, b.name || '');
      console.log('  [' + hhmmss() + '] 解析名单文件 ' + (b.name || '') +
        ' → ' + r.schools.length + ' 所学校 / ' + r.totalClasses + ' 个班');
      return sendJSON(res, {
        ok: true, format: r.format, rows: r.rows,
        schools: r.schools, totalClasses: r.totalClasses, warnings: r.warnings
      });
    } catch (e) {
      return sendJSON(res, { ok: false, error: e.message }, 400);
    }
  }

  /* --- 确认导入 --- */
  if (p === '/api/schools/import' && method === 'POST') {
    if (blocked(res, whoAmI(req, url), 'admin')) return;
    const b = await readBody(req).catch(() => ({}));
    const incoming = normSchools(Array.isArray(b.schools) ? b.schools : []);
    if (!incoming.length) return sendJSON(res, { ok: false, error: '没有可导入的学校' }, 400);
    const mode = b.mode === 'replace' ? 'replace' : 'merge';

    if (mode === 'replace') {
      db.schools = incoming;
    } else {
      /* 合并：同名学校合并班级（去重），新学校追加在后面，原有顺序不变 */
      const map = Object.create(null);
      const merged = db.schools.map(s => {
        const c = Object.assign({}, s, { classes: (s.classes || []).slice() });
        map[c.name] = c;
        return c;
      });
      for (const s of incoming) {
        if (map[s.name]) {
          for (const c of s.classes) if (map[s.name].classes.indexOf(c) < 0) map[s.name].classes.push(c);
        } else {
          const item = { name: s.name, classes: s.classes.slice() };
          map[s.name] = item;
          merged.push(item);
        }
      }
      db.schools = merged;
    }

    save();
    broadcast('config', { schools: db.schools, unified: db.unified });
    const total = db.schools.reduce((n, s) => n + (s.classes || []).length, 0);
    pushFeed('管理员', (mode === 'replace' ? '覆盖导入' : '追加导入') + '学校名单：' +
      db.schools.length + ' 所学校 / ' + total + ' 个班', 'system');
    broadcast('feed', { item: db.feed[0] });
    console.log('  [' + hhmmss() + '] 导入名单（' + mode + '）：现在共 ' +
      db.schools.length + ' 所学校 / ' + total + ' 个班');
    return sendJSON(res, { ok: true, schools: db.schools, mode: mode });
  }

  /* --- 练习文本库：读公开（学生端要取正文），增删仅超级管理员 --- */
  if (p === '/api/materials' && method === 'GET') {
    return sendJSON(res, {
      materials: db.materials.map(m => Object.assign(matSummary(m), { body: m.body }))
    });
  }

  if (p === '/api/materials' && method === 'POST') {
    const me = whoAmI(req, url);
    if (blocked(res, me, 'admin')) return;
    const b = await readBody(req).catch(() => ({}));
    if (db.materials.length >= 100) {
      return sendJSON(res, { ok: false, error: '最多保存 100 篇文本，请先删掉一些不用的' }, 400);
    }
    const m = normMaterial(b);
    if (m.error) return sendJSON(res, { ok: false, error: m.error }, 400);
    m.by = ROLE_NAME[me.role] || '';
    db.materials.unshift(m);
    save();
    broadcast('config', {
      schools: db.schools, unified: db.unified,
      materials: db.materials.map(matSummary)
    });
    pushFeed('教师', '新增练习文本《' + m.title + '》· ' + m.words +
      (m.lang === 'en' ? ' 词' : ' 字'), 'system');
    broadcast('feed', { item: db.feed[0] });
    console.log('  [' + hhmmss() + '] 导入练习文本《' + m.title + '》' + m.words + ' 字');
    return sendJSON(res, {
      ok: true, material: m, materials: db.materials.map(matSummary)
    });
  }

  if (p === '/api/materials/delete' && method === 'POST') {
    const me = whoAmI(req, url);
    if (blocked(res, me, 'admin')) return;
    const b = await readBody(req).catch(() => ({}));
    const id = String(b.id || '');
    const i = db.materials.findIndex(m => m.id === id);
    if (i < 0) return sendJSON(res, { ok: false, error: '找不到这篇文本，可能已被删除' }, 404);
    const gone = db.materials.splice(i, 1)[0];
    save();
    broadcast('config', {
      schools: db.schools, unified: db.unified,
      materials: db.materials.map(matSummary)
    });
    console.log('  [' + hhmmss() + '] 删除练习文本《' + gone.title + '》');
    return sendJSON(res, { ok: true, materials: db.materials.map(matSummary) });
  }

  /* --- 访问码：查看与修改（仅超级管理员） --- */
  if (p === '/api/codes' && method === 'GET') {
    if (blocked(res, whoAmI(req, url), 'admin')) return;
    return sendJSON(res, {
      ok: true, adminCode: db.auth.adminCode, teacherCode: db.auth.teacherCode
    });
  }

  if (p === '/api/codes' && method === 'POST') {
    if (blocked(res, whoAmI(req, url), 'admin')) return;
    const b = await readBody(req);
    const ac = String(b.adminCode == null ? '' : b.adminCode).trim();
    const tc = String(b.teacherCode == null ? '' : b.teacherCode).trim();
    if (ac.length < 4 || ac.length > 32) {
      return sendJSON(res, { ok: false, error: '超级管理员访问码要 4—32 位' }, 400);
    }
    if (tc.length < 4 || tc.length > 32) {
      return sendJSON(res, { ok: false, error: '普通教师访问码要 4—32 位' }, 400);
    }
    if (ac === tc) {
      return sendJSON(res, { ok: false, error: '两个访问码不能相同，否则分不出权限' }, 400);
    }
    /* 只改访问码，不动签名密钥 —— 已经登录的教师端不会掉线 */
    db.auth.adminCode = ac;
    db.auth.teacherCode = tc;
    save();
    pushFeed('管理员', '修改了教师端访问码', 'system');
    broadcast('feed', { item: db.feed[0] });
    console.log('  [' + hhmmss() + '] 管理员修改了访问码');
    return sendJSON(res, { ok: true, adminCode: ac, teacherCode: tc });
  }

  /* --- 统一测评参数 --- */
  if (p === '/api/unified' && method === 'POST') {
    if (blocked(res, whoAmI(req, url), 'teacher')) return;
    const b = await readBody(req);
    const umode = b.mode === 'zh' ? 'zh' : 'speed';
    let ulevel = String(b.level || (umode === 'zh' ? 'builtin' : 'text'));
    /* 中文测评可以指定用哪篇导入的文本；文本被删了就退回内置语料 */
    if (umode === 'zh' && ulevel !== 'builtin' && !db.materials.some(m => m.id === ulevel)) {
      ulevel = 'builtin';
    }
    db.unified = {
      on: !!b.on,
      mode: umode,
      level: ulevel,
      sec: Math.max(30, Math.min(600, Number(b.sec) || 120))
    };
    save();
    broadcast('config', { schools: db.schools, unified: db.unified, materials: db.materials.map(matSummary) });
    const txt = db.unified.on
      ? '开启统一测评（' + MODE_NAME[db.unified.mode] + ' · ' + db.unified.sec + ' 秒）'
      : '关闭统一测评，恢复自由练习';
    pushFeed('教师', txt, 'system');
    broadcast('feed', { item: db.feed[0] });
    console.log('  [' + hhmmss() + '] ' + txt);
    return sendJSON(res, { ok: true, unified: db.unified });
  }

  /* --- 心跳：实时进度 --- */
  if (p === '/api/heartbeat' && method === 'POST') {
    const b = await readBody(req);
    const id = makeId(b.学校, b.班级, b.姓名);
    if (!id || id === '||') return sendJSON(res, { ok: false, error: '缺少身份信息' }, 400);
    /* 机位 id：同一台电脑的标识，用来把「上一位同学」从在线列表摘掉 */
    const seat = String(b.座位 || '').slice(0, 48);

    const isNew = !live[id];
    /* 同一身份 3 分钟内从两台不同机器登录 → 标黄，老师一眼看出"张三用了李四的机位" */
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    let dup = live[id] ? !!live[id].dup : false;
    if (live[id] && live[id].ip && ip && ip !== live[id].ip &&
      Date.now() - live[id].lastSeen < 3 * 60 * 1000) dup = true;

    live[id] = {
      id: id,
      school: String(b.学校 || '').trim(),
      cls: String(b.班级 || '').trim(),
      name: String(b.姓名 || '').trim(),
      mode: String(b.模式 || ''),
      progress: Number(b.进度) || 0,
      cpm: Number(b.CPM) || 0,
      acc: Number(b.准确率) || 0,
      keys: Number(b.击键) || 0,
      status: String(b.状态 || ''),
      ip: ip, dup: dup,
      seat: seat || (live[id] && live[id].seat) || '',
      firstSeen: live[id] ? live[id].firstSeen : Date.now(),
      lastSeen: Date.now()
    };

    /* 同一台机器换了人：本机位上的其他人（上一节课的学生）立刻下线。
     * 不做这件事，教师端进度墙会一路堆到课后 20 分钟才自然消失。 */
    const ghosts = [];
    if (seat) {
      for (const k of Object.keys(live)) {
        if (k !== id && live[k].seat === seat) {
          delete live[k];
          liveSigMap.delete(k);
          ghosts.push(k);
        }
      }
    }

    const me = liveRow(id);
    liveSigMap.set(id, liveSig(me));
    const payload = { liveRow: me, online: onlineCount() };
    if (ghosts.length) payload.liveDel = ghosts;
    if (isNew) {
      payload.feedItem = pushFeed(live[id].name, '进入练习（' + live[id].cls + '）', 'join');
      save();
    }
    broadcast('live', payload);
    return sendJSON(res, { ok: true, online: Object.keys(live).length });
  }

  /* --- 提交成绩 --- */
  if (p === '/api/result' && method === 'POST') {
    const b = await readBody(req);
    const c = computeResult(b);
    if (!c.ok) return sendJSON(res, c, 400);

    const rec = c.record;
    rec.id = makeId(b.学校, b.班级, b.姓名);
    if (!rec.id || rec.id === '||') return sendJSON(res, { ok: false, error: '缺少身份信息' }, 400);
    rec.school = String(b.学校 || '').trim();
    rec.cls = String(b.班级 || '').trim();
    rec.name = String(b.姓名 || '').trim();

    /* 落字游戏额外指标 */
    if (rec.mode === 'falling') {
      rec.reactionMs = Math.round(Number(b.reactionMs) || 0);
      rec.maxStreak = Math.round(Number(b.maxStreak) || 0);
      rec.score = Math.round(Number(b.gameScore) || 0);   // 游戏分数只做展示，不参与总分
      rec.cpm = 0;
    }

    /* 写库：明细一条 INSERT；只有达标且未超速的才计入榜单汇总（与旧版口径一致） */
    store.addRecord(rec, { count: !!rec.qualified && !(rec.cpm > capOf(rec.mode)) });
    save();

    if (live[rec.id]) {
      live[rec.id].lastSeen = Date.now();
      live[rec.id].status = '已提交成绩';
      live[rec.id].progress = 1;
    }

    /* 动态流 */
    let text = '';
    /* 中文的单位是"字/分钟"，英文是"CPM 字符/分钟"，文案要分开写 */
    const unit = rec.mode === 'zh' ? ' 字/分' : ' CPM';
    if (rec.mode === 'falling') {
      text = '落字游戏 ' + rec.score + ' 分 · 最高连击 ' + (rec.maxStreak || 0) +
        (rec.reactionMs ? ' · 反应 ' + rec.reactionMs + 'ms' : '');
    } else if (rec.overCap) {
      text = MODE_NAME[rec.mode] + ' ' + rec.cpm + unit + '，速度明显异常（上限 ' +
        capOf(rec.mode) + '），不计入排行榜';
    } else if (!rec.qualified) {
      text = MODE_NAME[rec.mode] + ' ' + rec.cpm + unit + '，但准确率 ' +
        Math.round(rec.acc * 100) + '% 未达 ' + Math.round(ACC_GATE * 100) + '%，不计入排行榜';
    } else {
      text = MODE_NAME[rec.mode] + ' ' + rec.cpm + unit + ' · 准确率 ' +
        Math.round(rec.acc * 100) + '% · 得分 ' + rec.score;
    }
    const item = pushFeed(rec.name, text, rec.qualified ? 'record' : 'weak', {
      score: rec.score, cpm: rec.cpm, mode: rec.mode
    });
    save();

    /* 只推「变化的那一行」+「自己的在线状态那一行」，不再把整份榜单和整张在线列表推给每个客户端。
       5,000 人规模下整份榜单 2 MB、在线列表 1.5 MB；改成单行之后一次提交只有 1 KB 出头，
       前端把它并进本地榜单再用 BOARD.recompute 自己重算名次。 */
    const board = buildBoard({});
    const me = board.find(r => r.id === rec.id) || null;
    const keys = buildKeyStats({});

    const myLive = liveRow(rec.id);
    if (myLive) liveSigMap.set(rec.id, liveSig(myLive));

    broadcast('result', {
      record: { id: rec.id, name: rec.name, mode: rec.mode, cpm: rec.cpm, acc: rec.acc,
        qualified: rec.qualified, overCap: rec.overCap },
      item: item,
      row: me,                    // ← 只有这一行变了；null = 这次没进榜
      total: board.length,
      keys: keys,
      liveRow: myLive,            // ← 只有自己这个人在线状态变了；null = 没在实时列表里
      online: onlineCount(),
      rank: me ? me.rank : 0
    });
    broadcast('feed', { item: item });

    console.log('  [' + hhmmss() + '] ' + rec.cls + ' ' + rec.name + ' · ' +
      MODE_NAME[rec.mode] + ' ' + rec.cpm + ' CPM / ' +
      Math.round(rec.acc * 100) + '%' + (rec.qualified ? ' · 得分 ' + rec.score : ' · 未达标'));

    return sendJSON(res, {
      ok: true, record: rec, rank: me ? me.rank : 0,
      total: board.length, row: me, keys: keys
    });
  }

  /* --- 排行榜查询（可带筛选） --- */
  if (p === '/api/board' && method === 'GET') {
    const school = url.searchParams.get('school') || '';
    const cls = url.searchParams.get('cls') || '';
    const onlyUnified = url.searchParams.get('unified') === '1';
    return sendJSON(res, {
      board: buildBoard({ school: school, cls: cls, onlyUnified: onlyUnified }),
      keys: buildKeyStats({ school: school, cls: cls })
    });
  }

  /* --- 导出 CSV --- */
  if (p === '/api/export.csv' && method === 'GET') {
    const rows = [['学校', '班级', '姓名', '模式', '关卡/语料', '文本', 'CPM', 'WPM', '准确率',
      '正确字符', '错误字符', '用时(秒)', '难度系数', '得分', '是否达标', '统一测评', '时间']];
    for (const r of store.allRecords()) {
      rows.push([r.school, r.cls, r.name, MODE_NAME[r.mode] || r.mode, r.level, r.material || '',
        r.cpm, r.wpm, Math.round(r.acc * 100) + '%', r.correct, r.wrong, r.sec,
        r.diff, r.score, r.qualified ? '达标' : '未达标', r.unified ? '是' : '',
        r.ts.replace('T', ' ').slice(0, 19)]);
    }
    const csv = '\ufeff' + rows.map(r =>
      r.map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')
    ).join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="typing-records-' +
        new Date().toISOString().slice(0, 10) + '.csv"'
    });
    return res.end(Buffer.from(csv, 'utf8'));
  }

  /* --- 备份数据库（管理员）：导出一个一致的 .sqlite 副本，运行中也能做 --- */
  if (p === '/api/backup' && method === 'GET') {
    if (blocked(res, whoAmI(req, url), 'admin')) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const name = 'typing-backup-' + stamp + '.sqlite';
    const target = path.join(DATA_DIR, name);
    let size = 0;
    try {
      size = store.backupTo(target);
    } catch (e) {
      return sendJSON(res, { ok: false, error: '备份失败：' + e.message }, 500);
    }
    const buf = fs.readFileSync(target);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': buf.length,
      'Content-Disposition': 'attachment; filename="' + name + '"'
    });
    res.end(buf);
    console.log('  [' + hhmmss() + '] 管理员导出数据库备份 ' + name + '（' +
      (size / 1048576).toFixed(1) + ' MB）');
    return;
  }

  /* --- 重置 --- */
  if (p === '/api/reset' && method === 'POST') {
    if (blocked(res, whoAmI(req, url), 'teacher')) return;
    const b = await readBody(req).catch(() => ({}));
    const scope = b.scope || 'live';
    if (scope === 'all') { store.clearRecords(); db.feed = []; live = Object.create(null); }
    else if (scope === 'live') { live = Object.create(null); }
    else if (scope === 'records') { store.clearRecords(); }
    liveSigMap.clear();
    save();
    broadcast('reset', { scope: scope, state: snapshot() });
    console.log('  [' + hhmmss() + '] 教师端清空数据（范围：' + scope + '）');
    return sendJSON(res, { ok: true });
  }

  return sendJSON(res, { error: 'not found' }, 404);
}

/* ============================ 静态托管 ============================ */
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/teacher') rel = '/teacher.html';
  if (rel === '/screen') rel = '/screen.html';
  if (rel === '/student') rel = '/index.html';

  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return sendText(res, '403 Forbidden', 403);

  fs.readFile(file, (err, buf) => {
    if (err) return sendText(res, '404 Not Found：' + rel, 404);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname.startsWith('/api/')) {
    handleAPI(req, res, url).catch(e => {
      console.error('[错误]', e);
      if (!res.headersSent) sendJSON(res, { error: e.message }, 500);
    });
    return;
  }
  serveStatic(req, res, url);
});

/* ============================ 启动 ============================ */
function banner(port) {
  const ni = netInfo();
  const line = '='.repeat(64);
  const p = s => '  ' + s;
  console.log('\n' + line);
  console.log('  全县中小学生打字练习系统   已启动');
  console.log(line);
  console.log(p('教师端（本机）   http://localhost:' + port + '/teacher'));
  console.log(p('大屏看板（投影） http://localhost:' + port + '/screen'));
  if (PUBLIC_URL) {
    console.log('  ' + '-'.repeat(60));
    console.log(p('★ 公网入口       ' + PUBLIC_URL + '/'));
    console.log(p('   （二维码和学生地址都会用这个，不再显示内网 IP）'));
  } else if (ni.ips.length) {
    console.log('  ' + '-'.repeat(60));
    console.log(p('★ 学生端入口（把这个地址给学生，或用大屏二维码）'));
    ni.ips.forEach(ip => console.log(p('   http://' + ip.address + ':' + port + '/     [' + ip.name + ']')));
  } else {
    console.log('  [提示] 没有检测到局域网 IP，学生可能无法访问，请检查网络。');
  }
  console.log('  ' + '-'.repeat(60));
  const _st = store.stats();
  console.log(p('已载入成绩 ' + _st.totalRecords + ' 条，学生 ' + _st.students +
    ' 人，学校 ' + db.schools.length + ' 所'));
  if (HIDE_CODES) {
    console.log(p('教师端访问码：已隐藏（服务端日志会留档，公网上不打印）'));
  } else {
    console.log(p('教师端访问码：超级管理员 ' + db.auth.adminCode + '    普通教师 ' + db.auth.teacherCode));
  }
  console.log(p('按 Ctrl + C 停止服务（会自动保存数据）'));
  console.log(line + '\n');
}

function openBrowser(port) {
  if (process.env.NO_OPEN === '1') return;
  if (process.platform !== 'win32') return;   // 服务器上没有浏览器，别去执行 start
  if (PUBLIC_URL) return;                     // 公网部署时打开的是别人家服务器，不归我管
  try {
    require('child_process').exec('start "" "http://localhost:' + port + '/teacher"',
      { windowsHide: true }, () => { });
  } catch (e) { /* 忽略 */ }
}

function addFirewallRule(port) {
  if (process.platform !== 'win32') return;   // netsh 是 Windows 的，Linux 用 ufw/firewalld
  if (BIND_HOST === '127.0.0.1') return;      // 只给本机用时不用开防火墙
  try {
    const { exec } = require('child_process');
    exec('netsh advfirewall firewall add rule name="TypingTrainer-' + port +
      '" dir=in action=allow protocol=TCP localport=' + port,
      { windowsHide: true }, () => { });
  } catch (e) { /* 忽略 */ }
}

/* 尝试占用端口：成功 true；被占用 false；其他错误直接抛 */
function tryBind(port) {
  return new Promise((resolve, reject) => {
    function onError(err) {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') resolve(false);
      else reject(err);
    }
    function onListening() {
      server.removeListener('error', onError);
      resolve(true);
    }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, BIND_HOST);
  });
}

/* 问一下这个端口上跑的是不是「自己」 */
async function probeSelf(port) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 800);
    const r = await fetch('http://127.0.0.1:' + port + '/api/ping', { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.app === 'typing-trainer') ? j : null;
  } catch (e) { return null; }
}

async function listen(port, attempt) {
  let bound = false;
  try {
    bound = await tryBind(port);
  } catch (e) {
    console.error('启动失败：' + e.message);
    process.exit(1);
  }

  if (bound) {
    banner(port);
    openBrowser(port);
    addFirewallRule(port);
    return;
  }

  /* 端口被占：先确认是不是本系统已经在跑 —— 是就不再起第二个实例 */
  const self = await probeSelf(port);
  if (self) {
    const line = '='.repeat(64);
    console.log('\n' + line);
    console.log('  系统已经在运行了，不用重复启动');
    console.log(line);
    console.log('  正在运行的实例：http://localhost:' + port + '/teacher   （进程 ' + self.pid + '）');
    console.log('  这里已经帮你把它打开，本窗口可以直接关闭。');
    console.log('');
    console.log('  · 想停止？双击「停止服务.bat」；或者找到原来那个黑色命令行窗口按 Ctrl + C。');
    console.log('  · 想看它跑在哪、几个人在线？双击「查看服务状态.bat」。');
    console.log('  · 开两个实例会各存各的成绩，名单和排行榜对不上，务必只留一个。');
    console.log(line + '\n');
    openBrowser(port);
    process.exit(0);
  }

  if (attempt >= 20) {
    console.error('启动失败：从 ' + START_PORT + ' 开始的 20 个端口都被其他程序占用。');
    console.error('可以用 set PORT=9000 换个起始端口再启动。');
    process.exit(1);
  }
  console.log('  端口 ' + port + ' 被其他程序占用，换用 ' + (port + 1) + ' ...');
  return listen(port + 1, attempt + 1);
}

loadData();
listen(START_PORT, 0).catch(e => {
  console.error('启动失败：' + e.message);
  process.exit(1);
});

/* 统一的退出路径：SIGINT（Ctrl+C）和 /api/shutdown（停止服务.bat）都走这里，
   保证数据库刷盘 + 安全关闭，不留下 -wal 半个事务。 */
function gracefulExit(reason) {
  if (reason) console.log('\n' + reason);
  console.log('正在保存并关闭数据库 ...');
  const okCfg = flush();
  const okDb = store.closeQuiet();
  console.log(okCfg && okDb ? '已安全关闭，数据在 ' + path.relative(ROOT, DB_FILE) : '关闭时有异常，请检查 data 目录');
  process.exit(0);
}

process.on('SIGINT', () => gracefulExit(null));
process.on('SIGTERM', () => { flush(); store.closeQuiet(); process.exit(0); });
