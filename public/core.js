/* ==========================================================================
 * 学生端 · 核心层（core.js）
 * --------------------------------------------------------------------------
 * 负责四件事，各练习模块只管"怎么练"，不管"怎么连"：
 *   ① 身份：学校 / 班级 / 姓名，存在 sessionStorage —— 关掉页面即失效，
 *      机房一台电脑多人轮流用，不能把上一位同学留给下一位
 *   ② 通信：GET/POST 封装 + SSE 实时订阅（掉线自动降级为轮询）
 *   ③ 击键采集：每个键打对几次、打错成什么 —— 错键热力图的原始数据
 *   ④ 公共 UI：虚拟键盘渲染、成绩单弹层、轻提示
 * ========================================================================== */
(function () {
  'use strict';

  var TY = {};
  window.TY = TY;

  /* ============================ 全局状态 ============================ */
  var S = TY.S = {
    school: '', cls: '', name: '',
    board: [], live: [], feed: [],
    schools: [], unified: null,
    materials: [],                 // 教师导入的练习文本（摘要 + 正文）
    diffTable: {}, accGate: 0.60, minSample: 30,
    online: 0,
    connected: false
  };
  TY.views = ['login', 'hall', 'practice', 'rank'];
  TY.curView = 'login';
  var cleanups = [];

  /* 准确率门槛的百分比整数，例如 60。各练习模式的提示文案统一用它，
   * 不再写死数字 —— 门槛只认服务端下发的 S.accGate。 */
  TY.accPct = function () { return Math.round((S.accGate || 0.60) * 100); };

  /* 练习页切换时统一回收定时器 / 事件监听，避免"上个模式的计时器还在跑" */
  TY.onCleanup = function (fn) { cleanups.push(fn); };
  TY.cleanup = function () {
    for (var i = 0; i < cleanups.length; i++) { try { cleanups[i](); } catch (e) { } }
    cleanups = [];
  };

  /* ============================ 本地存储 ============================ */
  /* 身份存 sessionStorage，不存 localStorage：
   *   关标签页 / 关浏览器 → 清空 → 下一位同学必须重新登记（机房一台机器多人用）
   *   按 F5 刷新         → 保留 → 不至于手一抖就白练一局
   * 键名换成 v2，让老用户 localStorage 里的 v1 彻底作废。 */
  var SS_KEY = 'typing_student_v2';
  var OLD_LS_KEY = 'typing_student_v1';

  TY.store = {
    load: function () {
      try {
        var raw = sessionStorage.getItem(SS_KEY);
        if (!raw) return null;
        var o = JSON.parse(raw);
        if (o && o.name) return o;
      } catch (e) { }
      return null;
    },
    save: function () {
      try {
        sessionStorage.setItem(SS_KEY, JSON.stringify({
          school: S.school, cls: S.cls, name: S.name, ts: Date.now()
        }));
      } catch (e) { }
    },
    clear: function () {
      try { sessionStorage.removeItem(SS_KEY); } catch (e) { }
    }
  };

  /* 升级后清掉老版本留在 localStorage 里的身份，别让它继续自动登录 */
  try { localStorage.removeItem(OLD_LS_KEY); } catch (e) { }

  /* ---------------------------------------------------------------
   * 上一台同学用过的学校 / 班级：只存这两个，**不含姓名**。
   * 换了人重开页面，学校班级预选好，学生只需写自己的名字 ——
   * 既不泄露上一位是谁，也省掉每节课重复点两次下拉。
   * --------------------------------------------------------------- */
  var ROOM_KEY = 'typing_room_v1';
  TY.room = {
    load: function () {
      try {
        var o = JSON.parse(localStorage.getItem(ROOM_KEY) || 'null');
        if (o && o.school) return o;
      } catch (e) { }
      return null;
    },
    save: function (school, cls) {
      if (!school) return;
      try {
        localStorage.setItem(ROOM_KEY, JSON.stringify({ school: school, cls: cls || '' }));
      } catch (e) { }
    },
    clear: function () {
      try { localStorage.removeItem(ROOM_KEY); } catch (e) { }
    }
  };

  /* ---------------------------------------------------------------
   * 机位 id：标识「这台电脑」，与「坐在这儿的是谁」无关，所以存 localStorage。
   * 心跳带上它，服务端就能把同一机位的上一位学生立刻下线 ——
   * 否则教师端进度墙会把上一节课的人挂 20 分钟（DROP_TTL）。
   * --------------------------------------------------------------- */
  var SEAT_KEY = 'typing_seat_v1';
  function seatId() {
    try {
      var s = localStorage.getItem(SEAT_KEY);
      if (!s || s.length < 8) {
        s = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        localStorage.setItem(SEAT_KEY, s);
      }
      return s;
    } catch (e) { return ''; }
  }
  TY.seatId = seatId;

  /* ============================ 网络 ============================ */
  var BASE = location.origin;
  TY.net = {
    get: function (p) {
      return fetch(BASE + p, { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .catch(function () { return null; });
    },
    post: function (p, body) {
      return fetch(BASE + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (r) { return r.json(); })
        .catch(function () { return { ok: false, offline: true }; });
    }
  };

  /* SSE 订阅：服务端有任何变化推过来；断线自动重连（EventSource 内置） */
  var es = null, esFails = 0, pollTimer = null;
  TY.net.connect = function (handlers) {
    if (!window.EventSource) { startPolling(handlers); return; }
    try {
      es = new EventSource(BASE + '/api/stream');
    } catch (e) { startPolling(handlers); return; }

    function apply(d) {
      if (!d) return;
      if (d.board) S.board = d.board;
      if (d.live) { if (window.LIVE) LIVE.set(S.live, d.live); else S.live = d.live; }
      if (d.feed) S.feed = d.feed;
      if (d.schools) S.schools = d.schools;
      if (d.unified) S.unified = d.unified;
      if (d.diffTable) S.diffTable = d.diffTable;
      if (d.accGate) S.accGate = d.accGate;
      if (d.minSample) S.minSample = d.minSample;
      if (d.stats && typeof d.stats.online === 'number') S.online = d.stats.online;
      S.connected = true;
      esFails = 0;
    }

    /* 在线列表的统一入口：服务端可能推整表（init）也可能只推变化的那几条 */
    function applyLive(d) {
      if (d.live) { if (window.LIVE) LIVE.set(S.live, d.live); else S.live = d.live; }
      if (window.LIVE) {
        if (d.liveRow) LIVE.merge(S.live, d.liveRow);
        if (d.liveUpd) LIVE.mergeAll(S.live, d.liveUpd);
        if (d.liveDel) LIVE.drop(S.live, d.liveDel);
      }
      S.online = (typeof d.online === 'number') ? d.online
        : (window.LIVE ? LIVE.online(S.live) : S.live.filter(function (x) { return x.online; }).length);
    }

    es.addEventListener('init', function (e) {
      var d = JSON.parse(e.data); apply(d);
      S.online = (d.stats && typeof d.stats.online === 'number') ? d.stats.online
        : (d.live || []).filter(function (x) { return x.online; }).length;
      handlers.onState && handlers.onState(d);
    });
    es.addEventListener('live', function (e) {
      var d = JSON.parse(e.data);
      applyLive(d);
      handlers.onLive && handlers.onLive(d);
    });
    es.addEventListener('result', function (e) {
      var d = JSON.parse(e.data);
      /* 服务端只推变化的那一行，榜单其余部分保持不变，名次由 BOARD 重算 */
      if (d.row) { if (window.BOARD) BOARD.merge(S.board, d.row); }
      else if (d.board) S.board = d.board;
      applyLive(d);
      handlers.onResult && handlers.onResult(d);
    });
    es.addEventListener('config', function (e) {
      var d = JSON.parse(e.data);
      if (d.schools) S.schools = d.schools;
      if (d.unified) S.unified = d.unified;
      handlers.onConfig && handlers.onConfig(d);
    });
    es.addEventListener('reset', function (e) {
      var d = JSON.parse(e.data);
      if (d.state) apply(d.state);
      handlers.onReset && handlers.onReset(d);
    });
    es.onerror = function () {
      esFails++;
      S.connected = false;
      handlers.onOffline && handlers.onOffline();
      /* 连续 3 次连不上 → 降级为 8 秒轮询，保证机房网络抖动时界面不僵 */
      if (esFails >= 3 && !pollTimer) startPolling(handlers);
    };
  };

  function startPolling(handlers) {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      TY.net.get('/api/state').then(function (d) {
        if (!d) { S.connected = false; return; }
        S.board = d.board || [];
        S.live = d.live || [];
        S.feed = d.feed || [];
        S.online = d.stats ? d.stats.online : 0;
        S.connected = true;
        handlers.onState && handlers.onState(d);
      });
    }, 8000);
  }

  /* ============================ 击键采集 ============================ */
  /*
   * hits：目标键被打对的次数         —— 分母
   * errs：目标键被打错成什么、几次   —— 分子
   * 教师端的错键热力图完全依赖这两个字典，别在这里省事。
   */
  function Tracker() { this.hits = {}; this.errs = {}; this.keys = 0; this.errCount = 0; }
  Tracker.prototype.ok = function (ch) {
    if (!ch) return;
    this.hits[ch] = (this.hits[ch] || 0) + 1;
    this.keys++;
  };
  Tracker.prototype.err = function (want, got) {
    if (!want || !got) return;
    if (!this.errs[want]) this.errs[want] = {};
    this.errs[want][got] = (this.errs[want][got] || 0) + 1;
    this.keys++;
    this.errCount++;
  };
  Tracker.prototype.dump = function () { return { hits: this.hits, errs: this.errs }; };
  Tracker.prototype.reset = function () { this.hits = {}; this.errs = {}; this.keys = 0; this.errCount = 0; };
  TY.Tracker = Tracker;
  TY.track = new Tracker();

  /* 统一键盘事件入口：过滤修饰键、输入法组合、忽略不可打印键 */
  TY.onKey = function (handler) {
    function fn(e) {
      /* 中文输入法组合中会产生 key='Process' / keyCode 229，直接放掉，
         否则学生切到中文输入法后每个键都会被记成"打错" */
      if (e.isComposing || e.keyCode === 229 || e.key === 'Process') return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      var k = e.key;
      if (k == null) return;
      if (k.length === 1 || k === 'Backspace' || k === 'Tab' || k === 'Enter' || k === 'Escape') {
        handler(k, e);
      }
    }
    window.addEventListener('keydown', fn);
    TY.onCleanup(function () { window.removeEventListener('keydown', fn); });
    return fn;
  };

  /* ============================ 虚拟键盘 ============================ */
  var kbEl = null, kbMap = null;

  TY.kb = {
    build: function (container, opts) {
      opts = opts || {};
      var D = window.TDATA;
      container.innerHTML = '';
      container.className = 'kb';
      kbMap = {};
      for (var r = 0; r < D.KB_ROWS.length; r++) {
        var row = document.createElement('div');
        row.className = 'kb-row';
        for (var i = 0; i < D.KB_ROWS[r].length; i++) {
          var ch = D.KB_ROWS[r][i];
          var el = document.createElement('div');
          el.className = 'kb-key';
          var f = D.FINGER[ch];
          if (f != null) el.classList.add(f <= 3 ? 'hand-l' : 'hand-r');
          if (D.HOME_KEYS.indexOf(ch) >= 0) el.classList.add('home');
          el.textContent = ch;
          el.setAttribute('data-k', ch);
          row.appendChild(el);
          kbMap[ch] = el;
        }
        container.appendChild(row);
      }
      kbEl = container;
      return container;
    },
    mark: function (ch) {
      if (!kbMap) return;
      for (var k in kbMap) kbMap[k].classList.remove('target');
      if (ch && kbMap[ch]) kbMap[ch].classList.add('target');
    },
    flash: function (ch, cls) {
      if (!kbMap || !kbMap[ch]) return;
      var el = kbMap[ch];
      el.classList.remove('hit', 'miss');
      void el.offsetWidth;
      el.classList.add(cls === 'miss' ? 'miss' : 'hit');
      setTimeout(function () { el.classList.remove('hit', 'miss'); }, 160);
    },
    fingerOf: function (ch) {
      var D = window.TDATA;
      var f = D.FINGER[ch];
      if (f == null) return { name: '—', color: '#6b7280' };
      return { name: D.FINGER_NAME[f], color: D.FINGER_COLOR[f] };
    }
  };

  /* ============================ 上报 ============================ */
  var lastBeat = 0, beatTimer = null, beatInfo = {};

  /* 练习过程中更新"当前在做什么"，心跳会带上 */
  TY.setBeat = function (o) {
    for (var k in o) beatInfo[k] = o[k];
  };

  TY.startBeat = function () {
    if (beatTimer) return;
    beatTimer = setInterval(beat, 5000);
    beat();
  };
  TY.stopBeat = function () {
    if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
  };
  function beat() {
    if (!S.name) return;
    var now = Date.now();
    if (now - lastBeat < 3000) return;
    lastBeat = now;
    TY.net.post('/api/heartbeat', {
      学校: S.school, 班级: S.cls, 姓名: S.name,
      模式: beatInfo.mode || '', 模式名: beatInfo.modeName || '',
      进度: beatInfo.progress || 0,
      CPM: beatInfo.cpm || 0,
      准确率: beatInfo.acc || 0,
      击键: beatInfo.keys || 0,
      状态: beatInfo.status || '练习中',
      座位: seatId()
    });
  }

  /* 提交成绩：返回 Promise，resolve 服务端返回体（含名次） */
  TY.submit = function (rec) {
    var body = {
      学校: S.school, 班级: S.cls, 姓名: S.name,
      mode: rec.mode, level: rec.level,
      correct: rec.correct, wrong: rec.wrong, sec: rec.sec,
      unified: !!(S.unified && S.unified.on),
      keys: rec.keys,
      reactionMs: rec.reactionMs, maxStreak: rec.maxStreak, gameScore: rec.gameScore
    };
    return TY.net.post('/api/result', body).then(function (r) {
      if (r && r.ok) {
        if (r.row && window.BOARD) BOARD.merge(S.board, r.row);
        else if (r.board) S.board = r.board;
        return r;
      }
      return { ok: false, offline: !r || r.offline, error: r && r.error };
    });
  };

  /* ============================ 成绩单 ============================ */
  var modal = null;

  TY.showResult = function (o) {
    if (!modal) modal = document.getElementById('modal-result');
    document.getElementById('mr-badge').textContent = o.badge || '成绩单';
    document.getElementById('mr-title').textContent = o.title || '';
    document.getElementById('mr-score').textContent = o.score != null ? o.score : '—';
    document.getElementById('mr-cpm').textContent = o.cpm || '—';
    /* 中文练习的单位是"字/分钟"，不是 CPM */
    var cpmK = document.getElementById('mr-cpm-k');
    if (cpmK) cpmK.textContent = o.cpmLabel || '速度 CPM';
    document.getElementById('mr-acc').textContent = o.acc || '—';
    document.getElementById('mr-cw').textContent = o.cw || '—';
    document.getElementById('mr-rank').textContent = o.rank ? ('第 ' + o.rank + ' 名') : '暂未上榜';

    var note = document.getElementById('mr-note');
    note.textContent = o.note || '';
    note.className = 'mr-note' + (o.good ? ' good' : '');

    var againBtn = document.getElementById('mr-again');
    againBtn.textContent = o.againText || '再来一次';
    againBtn.onclick = function () {
      modal.classList.remove('show');
      if (o.onAgain) o.onAgain();
    };
    document.getElementById('mr-done').onclick = function () {
      modal.classList.remove('show');
      if (o.onDone) o.onDone();
    };
    /* 成绩单上直接换人：机房一台电脑轮流用，练完不用再绕回顶栏 */
    var swBtn = document.getElementById('mr-switch');
    if (swBtn) swBtn.onclick = function () {
      modal.classList.remove('show');
      if (window.APP && APP.switchStudent) APP.switchStudent();
    };
    modal.classList.add('show');
  };
  TY.hideResult = function () { if (modal) modal.classList.remove('show'); };

  /* ============================ 轻提示 ============================ */
  var toastTimer = null;
  TY.toast = function (msg, ms) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, ms || 2400);
  };

  /* ============================ 小工具 ============================ */
  TY.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };
  TY.pct = function (n) { return Math.round((Number(n) || 0) * 100) + '%'; };
  TY.fmt = function (n, d) {
    var v = Number(n) || 0;
    return v.toFixed(d == null ? 1 : d).replace(/\.0$/, '');
  };
  /* 显示用字符（空格要在界面上可见） */
  TY.showCh = function (ch) {
    if (ch === ' ') return '\u00b7';
    return ch;
  };
})();
