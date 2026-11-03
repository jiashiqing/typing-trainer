/* ==========================================================================
 * 教师端（teacher.js）
 * --------------------------------------------------------------------------
 * 四个面板：课堂总览 / 排行榜 / 学情分析 / 课堂管理
 * 数据全部由服务端算好（得分、榜单、错键聚合），这里只负责展示与筛选。
 * ========================================================================== */
(function () {
  'use strict';

  var D = window.TDATA;

  var T = {
    live: [], board: [], keys: null, feed: [], schools: [], unified: null,
    materials: [],
    stats: { online: 0, totalRecords: 0, students: 0 },
    net: null,
    panel: 'overview',
    bdKind: 'total', bdSchool: '', bdCls: '',
    anSchool: '', anCls: '',
    search: '', onlyOnline: true,
    raf: 0, anTimer: 0, accGate: 0.60
  };

  function $(id) { return document.getElementById(id); }
  /* 准确率门槛百分比，跟服务端 ACC_GATE 走；教师端不写死数字 */
  function accPct() { return Math.round((T.accGate || 0.60) * 100); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmt(n, d) {
    var v = Number(n) || 0;
    return v.toFixed(d == null ? 1 : d).replace(/\.0$/, '');
  }
  function toast(msg) {
    var el = $('toast2');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  /* ============================ 登录与权限 ============================ */
  /* 令牌存 sessionStorage：关掉标签页就要重新输访问码，机房电脑不会一直被上一个人占着 */
  var TK = 'typing_teacher_token';
  var ROLE_TXT = { admin: '超级管理员', teacher: '普通教师' };

  function getToken() { try { return sessionStorage.getItem(TK) || ''; } catch (e) { return ''; } }
  function setToken(t) {
    try { t ? sessionStorage.setItem(TK, t) : sessionStorage.removeItem(TK); } catch (e) { }
  }

  /* 统一 POST：自动带令牌，401 直接退回登录门 */
  function apiPost(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Token': getToken() },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        j.__status = r.status;
        return j;
      });
    }).catch(function () { return { ok: false, error: '连不上服务端' }; });
  }

  /* 统一 GET：同样自动带令牌 */
  function apiGet(path) {
    return fetch(path, { headers: { 'X-Token': getToken() } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          j.__status = r.status;
          return j;
        });
      }).catch(function () { return { ok: false, error: '连不上服务端' }; });
  }

  function showGate(msg) {
    $('gate').classList.remove('hidden');
    $('gate-err').textContent = msg || '';
    setTimeout(function () { $('gate-code').focus(); }, 80);
  }
  function hideGate() { $('gate').classList.add('hidden'); }

  function applyRole(role) {
    T.role = role;
    var isAdmin = role === 'admin';
    $('chip-role').hidden = false;
    $('role-text').textContent = ROLE_TXT[role] || role;
    $('chip-role').classList.toggle('admin', isAdmin);
    $('btn-logout').hidden = false;
    $('mg-card').hidden = !isAdmin;
    $('imp-card').hidden = !isAdmin;
    $('mat-card').hidden = !isAdmin;
    $('code-card').hidden = !isAdmin;
    $('mg-lock').hidden = isAdmin;

    /* 普通教师整个「课堂管理」页签都不显示。
     * 里面的卡片虽然已按角色隐藏，但留着空页签点进去更让人困惑。 */
    var tabMg = document.querySelector('.tab[data-panel="manage"]');
    if (tabMg) tabMg.hidden = !isAdmin;
    if (!isAdmin && T.panel === 'manage') {
      T.panel = 'overview';
      document.querySelectorAll('.tab').forEach(function (x) {
        x.classList.toggle('on', x.getAttribute('data-panel') === 'overview');
      });
      document.querySelectorAll('.panel').forEach(function (p) {
        p.classList.toggle('hidden', p.id !== 'panel-overview');
      });
    }

    if (isAdmin) loadCodes();
  }

  function doLogin() {
    var code = ($('gate-code').value || '').trim();
    if (!code) { $('gate-err').textContent = '请输入访问码'; return; }
    $('gate-go').disabled = true;
    fetch('/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    }).then(function (r) { return r.json(); }).then(function (r) {
      $('gate-go').disabled = false;
      if (!r || !r.ok) { $('gate-err').textContent = (r && r.error) || '登录失败'; return; }
      setToken(r.token);
      $('gate-code').value = '';
      $('gate-err').textContent = '';
      hideGate();
      applyRole(r.role);
      toast('已登录：' + r.roleName);
      boot();
    }).catch(function () {
      $('gate-go').disabled = false;
      $('gate-err').textContent = '连不上服务端，请确认服务是否在运行';
    });
  }

  function logout() {
    setToken('');
    T.role = '';
    $('chip-role').hidden = true;
    $('btn-logout').hidden = true;
    showGate('');
  }

  /* ============================ 数据接入 ============================ */
  /* 在线列表可能是整表（init）也可能是增量（心跳/提交/定时扫描推来的那几条），统一走这里 */
  function applyLive(d) {
    if (d.live) { if (window.LIVE) LIVE.set(T.live, d.live); else T.live = d.live; }
    if (window.LIVE) {
      if (d.liveRow) LIVE.merge(T.live, d.liveRow);
      if (d.liveUpd) LIVE.mergeAll(T.live, d.liveUpd);
      if (d.liveDel) LIVE.drop(T.live, d.liveDel);
    }
    T.stats.online = (typeof d.online === 'number') ? d.online
      : (window.LIVE ? LIVE.online(T.live) : T.live.filter(function (x) { return x.online; }).length);
  }

  function apply(d) {
    if (!d) return;
    applyLive(d);
    if (d.board) T.board = d.board;
    if (d.keys) T.keys = d.keys;
    if (d.feed) T.feed = d.feed;
    if (d.schools) T.schools = d.schools;
    if (d.unified) T.unified = d.unified;
    if (d.materials) T.materials = d.materials;
    if (d.stats) T.stats = d.stats;
    if (d.net) T.net = d.net;
    if (d.accGate) T.accGate = d.accGate;
  }

  function connect() {
    var es = new EventSource('/api/stream');
    es.addEventListener('init', function (e) {
      apply(JSON.parse(e.data));
      initManage();
      mark();
    });
    es.addEventListener('live', function (e) {
      var d = JSON.parse(e.data);
      applyLive(d);
      if (d.feedItem) T.feed.unshift(d.feedItem);
      mark();
    });
    es.addEventListener('result', function (e) {
      var d = JSON.parse(e.data);
      if (d.row && window.BOARD) BOARD.merge(T.board, d.row);
      else if (d.board) T.board = d.board;
      if (d.keys) T.keys = d.keys;
      applyLive(d);
      if (d.item) T.feed.unshift(d.item);
      if (d.record) {
        T.stats.totalRecords++;
        T.stats.students = T.board.length;
      }
      mark();
      if (T.panel === 'analysis') scheduleAnalysis();
    });
    es.addEventListener('feed', function (e) {
      var d = JSON.parse(e.data);
      if (d.item && (!T.feed.length || T.feed[0].id !== d.item.id)) T.feed.unshift(d.item);
      if (T.feed.length > 80) T.feed.length = 80;
      mark();
    });
    es.addEventListener('config', function (e) {
      var d = JSON.parse(e.data);
      if (d.schools) { T.schools = d.schools; fillSchoolSelects(); }
      if (d.unified) T.unified = d.unified;
      mark();
    });
    es.addEventListener('reset', function (e) {
      var d = JSON.parse(e.data);
      if (d.state) apply(d.state);
      mark();
    });
    es.onerror = function () { /* EventSource 自动重连 */ };
  }

  function mark() {
    if (T.raf) return;
    T.raf = requestAnimationFrame(function () {
      T.raf = 0;
      paint();
    });
  }

  function paint() {
    paintTop();
    if (T.panel === 'overview') { paintKPI(); paintWall(); paintFeed(); }
    else if (T.panel === 'board') paintBoard();
    else if (T.panel === 'analysis') scheduleAnalysis();
  }

  /* ============================ 顶栏 ============================ */
  function paintTop() {
    var on = T.live.filter(function (x) { return x.online; }).length;
    $('t-online').textContent = on;
    $('t-records').textContent = T.stats.totalRecords || 0;
    var u = T.unified;
    $('tb2-sub').textContent = u && u.on
      ? '统一测评进行中 · ' + secText(u.sec) + ' · 全班同一套参数'
      : '全县中小学生键盘技能训练';
  }

  function secText(s) {
    s = Number(s) || 0;
    return s >= 60 ? (s / 60) + ' 分钟' : s + ' 秒';
  }

  /* ============================ KPI ============================ */
  function paintKPI() {
    var on = T.live.filter(function (x) { return x.online; });
    $('k-online').textContent = on.length;
    $('k-online-x').textContent = on.length
      ? ('共 ' + T.live.length + ' 人登录过本课')
      : '等待学生登录…';

    /* 平均速度 / 准确率：只统计正在练且已有数值的人，避免"没开始的人拉低平均" */
    var cpms = [], accs = [];
    on.forEach(function (x) {
      if (x.cpm > 0) cpms.push(x.cpm);
      if (x.acc > 0) accs.push(x.acc);
    });
    var avgCpm = cpms.length ? cpms.reduce(function (a, b) { return a + b; }, 0) / cpms.length : 0;
    var avgAcc = accs.length ? accs.reduce(function (a, b) { return a + b; }, 0) / accs.length : 0;

    $('k-cpm').textContent = cpms.length ? Math.round(avgCpm) : '0';
    $('k-cpm-x').textContent = cpms.length ? (cpms.length + ' 人正在练习中') : '字符 / 分钟';
    /* live 里的准确率是 0—1 的小数，展示时统一 ×100 */
    $('k-acc').textContent = accs.length ? Math.round(avgAcc * 100) : '0';
    $('k-acc-x').textContent = accs.length
      ? (avgAcc * 100 >= accPct() ? '整体达标，可以提速度了'
        : '低于 ' + accPct() + '%，先降速求准')
      : '达标线 ' + accPct() + '%';

    var qual = T.board.filter(function (r) { return r.total > 0; }).length;
    $('k-qual').textContent = qual;
    $('k-qual-x').textContent = qual ? ('已有 ' + qual + ' 人进入榜单')
      : ('准确率 ≥ ' + accPct() + '% 才进榜');

    /* 指标卡配色 */
    colorKpi('k-acc', avgAcc * 100, accPct(), Math.max(0, accPct() - 15));
  }

  function colorKpi(id, v, good, bad) {
    var card = $(id).closest('.kpi');
    card.classList.remove('good', 'warn', 'bad');
    if (!v) return;
    if (v >= good) card.classList.add('good');
    else if (v >= bad) card.classList.add('warn');
    else card.classList.add('bad');
  }

  /* ============================ 进度墙 ============================ */
  var MODE_CLS = { key: '', falling: 'falling', speed: 'speed', wordrush: 'wordrush' };

  function paintWall() {
    var kw = T.search.trim().toLowerCase();
    var list = T.live.filter(function (x) {
      if (T.onlyOnline && !x.online) return false;
      if (!kw) return true;
      return (x.name + ' ' + x.cls + ' ' + (x.modeName || '')).toLowerCase().indexOf(kw) >= 0;
    });

    var wall = $('wall'), empty = $('wall-empty');
    if (!list.length) {
      wall.innerHTML = '';
      empty.hidden = false;
      empty.textContent = T.live.length
        ? '当前筛选条件下没有学生。'
        : '还没有学生进入练习。学生用手机或机房电脑打开入口地址，选择学校班级、填上姓名即可。';
      return;
    }
    empty.hidden = true;

    /* 按班级分组：一个班上课时只有一组，全校同时练时能一眼分开 */
    var groups = {}, order = [];
    list.forEach(function (x) {
      var k = x.cls || '未分班';
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(x);
    });
    order.sort();

    var multi = order.length > 1;
    var html = '';
    order.forEach(function (k) {
      var arr = groups[k];
      arr.sort(function (a, b) {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return String(a.name).localeCompare(String(b.name), 'zh');
      });
      html += '<div class="wg">';
      if (multi) html += '<div class="wg-h">' + esc(k) + '<i>' + arr.length + ' 人</i></div>';
      html += '<div class="wg-grid">';
      arr.forEach(function (x) { html += cardHTML(x); });
      html += '</div></div>';
    });
    wall.innerHTML = html;
  }

  function cardHTML(x) {
    var cls = 'sc';
    if (!x.online) cls += ' off';
    else if (x.mode) cls += ' work';
    if (x.dup) cls += ' dup';
    var modeTxt = x.modeName || '未开始';
    var mcls = x.mode ? (MODE_CLS[x.mode] || '') : 'idle';
    var pct = Math.round((x.progress || 0) * 100);
    return '<div class="' + cls + '">' +
      (x.dup ? '<span class="sc-dup">身份重复</span>' : '') +
      '<div class="sc-top"><span class="sc-dot"></span><span class="sc-nm">' + esc(x.name) + '</span></div>' +
      '<div class="sc-cls">' + esc(x.cls) + '</div>' +
      '<span class="sc-mode ' + mcls + '">' + esc(modeTxt) + '</span>' +
      '<div class="sc-bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="sc-nums">' +
        '<span>CPM <b>' + (x.cpm ? Math.round(x.cpm) : '—') + '</b></span>' +
        '<span>准 <b>' + (x.acc ? Math.round(x.acc * 100) + '%' : '—') + '</b></span>' +
      '</div>' +
    '</div>';
  }

  /* ============================ 动态流 ============================ */
  var KIND_CLS = {
    join: 'k-join', record: 'k-record', weak: 'k-weak',
    system: 'k-system', streak: 'k-streak', info: ''
  };

  function paintFeed() {
    var box = $('feed');
    var list = T.feed.slice(0, 40);
    if (!list.length) {
      box.innerHTML = '<div class="fd"><div class="fd-b"><span>暂无动态。学生开始练习后，这里会实时滚动。</span></div></div>';
      return;
    }
    box.innerHTML = list.map(function (f) {
      return '<div class="fd ' + (KIND_CLS[f.kind] || '') + '">' +
        '<div class="fd-t">' + esc(f.time) + '</div>' +
        '<div class="fd-b"><b>' + esc(f.name) + '</b> <span>' + esc(f.text) + '</span></div>' +
      '</div>';
    }).join('');
  }

  /* ============================ 排行榜 ============================ */
  var BD_DEF = {
    total: { label: '总分', head: ['名次', '姓名', '班级', '总分', '最高 CPM', '准确率', '键位关', '提交'] },
    speed: { label: 'CPM', head: ['名次', '姓名', '班级', '最高 CPM', '准确率', '用时样本', '键位关', '提交'] },
    zh: { label: '字/分钟', head: ['名次', '姓名', '班级', '中文字/分', '中文准确率', '中文得分', '键位关', '提交'] },
    acc: { label: '准确率', head: ['名次', '姓名', '班级', '准确率', '最高 CPM', '正确字符', '键位关', '提交'] },
    react: { label: '反应(ms)', head: ['名次', '姓名', '班级', '平均反应', '最高连击', '游戏最高分', '键位关', '提交'] },
    progress: { label: '进步', head: ['名次', '姓名', '班级', '本课进步', '当前 CPM', '准确率', '键位关', '提交'] }
  };

  function filteredBoard() {
    return T.board.filter(function (r) {
      if (T.bdSchool && r.school !== T.bdSchool) return false;
      if (T.bdCls && r.cls !== T.bdCls) return false;
      return true;
    });
  }

  function sortedBoard(kind) {
    var rows = filteredBoard().slice();
    if (kind === 'speed') {
      rows = rows.filter(function (r) { return r.cpm > 0; });
      rows.sort(function (a, b) { return b.cpm - a.cpm || b.acc - a.acc; });
    } else if (kind === 'zh') {
      rows = rows.filter(function (r) { return r.zhCpm > 0; });
      rows.sort(function (a, b) { return b.zhCpm - a.zhCpm || b.zhAcc - a.zhAcc; });
    } else if (kind === 'acc') {
      rows = rows.filter(function (r) { return r.acc > 0; });
      rows.sort(function (a, b) { return b.acc - a.acc || b.cpm - a.cpm; });
    } else if (kind === 'react') {
      rows = rows.filter(function (r) { return r.reaction > 0; });
      rows.sort(function (a, b) { return a.reaction - b.reaction; });
    } else if (kind === 'progress') {
      rows = rows.filter(function (r) { return r.progress != null && r.progress !== 0; });
      rows.sort(function (a, b) { return b.progress - a.progress; });
    } else {
      rows = rows.filter(function (r) { return r.total > 0; });
      rows.sort(function (a, b) { return b.total - a.total || b.cpm - a.cpm; });
    }
    return rows;
  }

  function paintBoard() {
    var rows = sortedBoard(T.bdKind);
    var def = BD_DEF[T.bdKind];
    var tbl = $('bd-tbl'), empty = $('bd-empty');

    $('bd-head').innerHTML = '<tr>' + def.head.map(function (h, i) {
      return '<th' + (i === 0 ? ' style="width:56px"' : '') + '>' + h + '</th>';
    }).join('') + '</tr>';

    if (!rows.length) {
      tbl.style.display = 'none';
      empty.hidden = false;
      empty.textContent = T.bdKind === 'progress'
        ? '还没有人做了两次以上速度练习。同一个学生练两次，就能算出本次课的进步。'
        : (T.bdKind === 'react'
          ? '还没有人玩过落字游戏。'
          : ('该范围下还没有达标成绩。准确率达到 ' + accPct() + '% 才会进榜。'));
      return;
    }
    tbl.style.display = '';
    empty.hidden = true;

    $('bd-body').innerHTML = rows.map(function (r, i) {
      var pos = i + 1;
      var pc = 'pos' + (pos <= 3 ? ' m' + pos : '');
      var cells = '';
      if (T.bdKind === 'total') {
        cells = '<td><b>' + fmt(r.total) + '</b></td>' +
          '<td>' + (r.cpm ? fmt(r.cpm) : '—') + '</td>' +
          '<td>' + (r.acc ? fmt(r.acc, 0) + '%' : '—') + '</td>';
      } else if (T.bdKind === 'speed') {
        cells = '<td><b>' + fmt(r.cpm) + '</b></td>' +
          '<td>' + (r.acc ? fmt(r.acc, 0) + '%' : '—') + '</td>' +
          '<td class="sub">' + r.attempts + ' 次</td>';
      } else if (T.bdKind === 'zh') {
        cells = '<td><b>' + fmt(r.zhCpm) + '</b></td>' +
          '<td>' + (r.zhAcc ? fmt(r.zhAcc, 0) + '%' : '—') + '</td>' +
          '<td class="sub">' + (r.part && r.part.zh ? fmt(r.part.zh) + ' 分' : '—') + '</td>';
      } else if (T.bdKind === 'acc') {
        cells = '<td><b>' + fmt(r.acc, 0) + '%</b></td>' +
          '<td>' + (r.cpm ? fmt(r.cpm) : '—') + '</td>' +
          '<td class="sub">' + (r.part && r.part.speed ? fmt(r.part.speed) + ' 分' : '—') + '</td>';
      } else if (T.bdKind === 'react') {
        cells = '<td><b>' + r.reaction + ' ms</b></td>' +
          '<td>' + (r.streak || 0) + '</td>' +
          '<td class="sub">' + (r.fallScore || 0) + '</td>';
      } else {
        var p = r.progress;
        cells = '<td><b style="color:' + (p > 0 ? 'var(--green)' : 'var(--red)') + '">' +
          (p > 0 ? '+' : '') + fmt(p) + '</b></td>' +
          '<td>' + (r.cpm ? fmt(r.cpm) : '—') + '</td>' +
          '<td>' + (r.acc ? fmt(r.acc, 0) + '%' : '—') + '</td>';
      }
      return '<tr>' +
        '<td class="' + pc + '">' + pos + '</td>' +
        '<td class="nm">' + esc(r.name) + '</td>' +
        '<td class="sub">' + esc(r.cls) + '</td>' +
        cells +
        '<td>' + (r.keyLevel ? ('第 ' + r.keyLevel + ' 关') : '—') + '</td>' +
        '<td class="sub">' + r.attempts + '</td>' +
        '</tr>';
    }).join('');
  }

  /* ============================ 学情分析 ============================ */
  /* 配色分档要细：全班错误率普遍在 3—6% 时，粗档会让整张键盘一个颜色，看不出重点 */
  var KEY_CLS = [
    { max: 0, bg: '#eef2f7', fg: '#5b6472' },
    { max: 2, bg: '#fff1f0', fg: '#b45309' },
    { max: 4, bg: '#fee2e2', fg: '#b91c1c' },
    { max: 6, bg: '#fca5a5', fg: '#7f1d1d' },
    { max: 9, bg: '#f87171', fg: '#ffffff' },
    { max: 999, bg: '#dc2626', fg: '#ffffff' }
  ];

  function colorOf(rate) {
    if (!rate) return KEY_CLS[0];
    for (var i = 1; i < KEY_CLS.length; i++) if (rate <= KEY_CLS[i].max) return KEY_CLS[i];
    return KEY_CLS[KEY_CLS.length - 1];
  }

  function scheduleAnalysis() {
    if (T.anTimer) return;
    T.anTimer = setTimeout(function () {
      T.anTimer = 0;
      fetchAnalysis();
    }, 350);
  }

  function fetchAnalysis() {
    var q = [];
    if (T.anSchool) q.push('school=' + encodeURIComponent(T.anSchool));
    if (T.anCls) q.push('cls=' + encodeURIComponent(T.anCls));
    fetch('/api/board?' + q.join('&'), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) { renderAnalysis(d.keys); })
      .catch(function () { renderAnalysis(T.keys); });
  }

  function renderAnalysis(K) {
    if (!K) K = { chars: {}, top: [], scanned: 0, avgRate: 0, totalErr: 0 };
    $('an-scanned').textContent = '已分析 ' + (K.scanned || 0) + ' 份成绩' +
      (K.totalErr ? ' · 共 ' + K.totalErr + ' 次错误' : '');

    /* --- 键盘热力图 --- */
    var html = '';
    D.KB_ROWS.forEach(function (row) {
      html += '<div class="kb-row">';
      row.forEach(function (ch) {
        var st = K.chars[ch];
        var rate = st ? st.rate : 0;
        var c = colorOf(rate);
        var hot = rate >= 5 ? ' hot' : '';
        html += '<div class="hk' + hot + '" style="background:' + c.bg + ';color:' + c.fg + '"' +
          ' title="' + ch + '：错误率 ' + rate + '%（错 ' + (st ? st.err : 0) + ' 次 / 共 ' +
          (st ? st.total : 0) + ' 次）+ ' + '">' +
          ch + (st && st.total >= 3 ? '<small>' + rate + '%</small>' : '') + '</div>';
      });
      html += '</div>';
    });
    $('an-keyboard').innerHTML = html;

    /* --- Top 错键 --- */
    var top = (K.top || []).slice(0, 10);
    if (!top.length) {
      $('an-top').innerHTML = '<div class="an-empty">还没有足够的击键数据。<br>学生练过一轮后，这里会出现全班最常打错的键。</div>';
    } else {
      var maxE = top[0].err || 1;
      $('an-top').innerHTML = top.map(function (x) {
        return '<div class="tp">' +
          '<span class="tp-k">' + esc(x.ch === ' ' ? '空格' : x.ch) + '</span>' +
          '<span class="tp-bar"><i style="width:' + Math.max(6, x.err / maxE * 100) + '%"></i></span>' +
          '<span class="tp-v">' + x.err + ' 次 · ' + x.rate + '%</span>' +
          '</div>';
      }).join('');
    }

    /* --- 混淆对 --- */
    var confs = [];
    Object.keys(K.chars).forEach(function (ch) {
      var st = K.chars[ch];
      if (st.top && st.topN > 0) {
        confs.push({ want: ch, got: st.top, n: st.topN, rate: st.rate });
      }
    });
    confs.sort(function (a, b) { return b.n - a.n; });
    confs = confs.slice(0, 10);
    if (!confs.length) {
      $('an-conf').innerHTML = '<div class="an-empty">还没有错键记录。</div>';
    } else {
      $('an-conf').innerHTML = confs.map(function (c) {
        return '<div class="cf">' +
          '<span class="cf-a">' + esc(c.want === ' ' ? '空格' : c.want) + '</span>' +
          '<span class="cf-ar">打成了</span>' +
          '<span class="cf-b">' + esc(c.got === ' ' ? '空格' : c.got) + '</span>' +
          '<span class="cf-n">' + c.n + ' 次</span>' +
          '</div>';
      }).join('');
    }

    /* --- 自动建议 --- */
    $('an-advice').innerHTML = buildAdvice(K, top, confs);
  }

  function buildAdvice(K, top, confs) {
    var out = [];
    var chars = K.chars || {};

    if (!top.length) {
      out.push({ t: 'ok', h: '还没有数据', b: '学生练起来之后，这里会自动给出针对本班的训练建议。' });
      return out.map(wrapAdv).join('');
    }

    /* 1. 最该补的键 */
    if (top[0] && top[0].err >= 8) {
      var names = top.slice(0, 3).map(function (x) { return '「' + (x.ch === ' ' ? '空格' : x.ch) + '」'; }).join('、');
      out.push({
        t: 'warn',
        h: '先补这三个键：' + names,
        b: '全班在这几个键上累计打错 ' + top.slice(0, 3).reduce(function (a, b) { return a + b.err; }, 0) +
          ' 次。建议课上专门练 20 个含这些键的字串，把动作定型再提速。'
      });
    }

    /* 2. B / N 专项（下排食指，最常见的系统性问题） */
    var bn = (chars['b'] ? chars['b'].err : 0) + (chars['n'] ? chars['n'].err : 0);
    if (bn >= 8) {
      out.push({
        t: 'warn',
        h: 'B 和 N 是全班的高频错键',
        b: '这两个键都由食指外伸击打，学生常错打成 V / M。这不是速度问题，是手指分工没定型 —— ' +
          '让学生把手指放回 F、J 基准位再伸出去打，比反复练整段文本有效。'
      });
    }

    /* 3. 左右手失衡 */
    var leftErr = 0, rightErr = 0;
    Object.keys(chars).forEach(function (ch) {
      var f = D.FINGER[ch];
      if (f == null) return;
      if (f <= 3) leftErr += chars[ch].err;
      else rightErr += chars[ch].err;
    });
    var totalErr = leftErr + rightErr;
    if (totalErr >= 20) {
      var lp = Math.round(leftErr / totalErr * 100);
      if (lp >= 68 || lp <= 32) {
        out.push({
          t: 'warn',
          h: (lp >= 68 ? '左手' : '右手') + '错误明显偏多（占 ' + Math.max(lp, 100 - lp) + '%）',
          b: '说明学生主要用' + (lp >= 68 ? '右' : '左') + '手找键，另一只手没建立独立分工。' +
            '建议单独做单手分区练习，别急着打整段。'
        });
      }
    }

    /* 4. 邻键误触 vs 手指错位 */
    var neighbor = 0, misplace = 0;
    confs.forEach(function (c) {
      var f1 = D.FINGER[c.want], f2 = D.FINGER[c.got];
      if (f1 == null || f2 == null) return;
      if (f1 === f2) neighbor += c.n; else misplace += c.n;
    });
    if (neighbor + misplace >= 10) {
      if (misplace > neighbor) {
        out.push({
          t: 'warn',
          h: '主要问题是"用错手指"，不是"按偏了"',
          b: '大部分错误打到了由另一根手指负责的键上。这要回到基准键重新建立手指分工，' +
            '不要再靠"看着键盘找"来打。'
        });
      } else {
        out.push({
          t: 'ok',
          h: '主要问题是"按偏了一格"',
          b: '错误多发生在相邻键之间（同一根手指的不同键位）。这种情况练准确度最有效：' +
            '放慢速度，每个键都打完再抬手。'
        });
      }
    }

    /* 5. 平均错误率 */
    if (K.avgRate >= 10) {
      out.push({
        t: 'warn',
        h: '全班平均错误率 ' + K.avgRate + '%',
        b: '整体偏高。这节课的任务应该定在"准确率到 90%"，而不是"速度到多少"。' +
          '速度是准确率的副产品，反过来说不成立。'
      });
    } else if (K.avgRate > 0 && K.avgRate < 5) {
      out.push({
        t: 'ok',
        h: '全班错误率只有 ' + K.avgRate + '%，动作基本定型',
        b: '可以进入提速阶段了。用统一测评的 2 分钟短文，让全班在同一条件下比一次。'
      });
    }

    return out.map(wrapAdv).join('');
  }

  function wrapAdv(a) {
    return '<div class="adv ' + (a.t === 'warn' ? 'warn' : a.t === 'ok' ? 'ok' : '') + '">' +
      '<div><em>' + esc(a.h) + '</em><br>' + esc(a.b) + '</div></div>';
  }

  /* ============================ 管理页 ============================ */
  function initManage() {
    /* 统一测评 */
    if (T.unified) {
      $('u-on').checked = !!T.unified.on;
      $('u-mode').value = T.unified.mode === 'zh' ? 'zh' : 'speed';
      buildLevelOptions($('u-mode').value, T.unified.level);
      $('u-sec').value = String(T.unified.sec || 120);
    } else {
      buildLevelOptions('speed', 'text');
    }
    /* 学校名单 */
    $('mg-ta').value = T.schools.map(function (s) {
      return s.name + '|' + (s.classes || []).join(',');
    }).join('\n');
    /* 练习文本库 */
    paintMaterials();
    /* 入口地址 */
    if (T.net) {
      $('mg-url').textContent = T.net.studentUrl;
      $('mg-links').innerHTML =
        '<div>教师端 <b>' + esc(T.net.teacherUrl) + '</b></div>' +
        '<div>大屏看板 <b>' + esc(T.net.screenUrl) + '</b></div>' +
        '<div>本机端口 <b>' + esc(String(T.net.port)) + '</b></div>';
      drawQR(T.net.studentUrl);
    }
    fillSchoolSelects();
  }

  /* ---------------- 统一测评：模式 ↔ 内容联动 ---------------- */
  var SPEED_LEVELS = [
    { v: 'text', t: '英文短文（难度 1.20）' },
    { v: 'word', t: '英文单词（1.05）' },
    { v: 'num', t: '数字符号（1.10）' },
    { v: 'keys', t: '键位串（0.90）' }
  ];

  function buildLevelOptions(mode, keep) {
    var sel = $('u-level');
    var opts = [];
    if (mode === 'zh') {
      opts.push({ v: 'builtin', t: '内置中文语料（4 篇轮换）' });
      (T.materials || []).forEach(function (m) {
        opts.push({ v: m.id, t: m.title + '（' + m.words + ' 字）' });
      });
    } else {
      opts = SPEED_LEVELS.slice();
    }
    sel.innerHTML = opts.map(function (o) {
      return '<option value="' + o.v + '">' + esc(o.t) + '</option>';
    }).join('');
    if (keep && opts.some(function (o) { return o.v === keep; })) sel.value = keep;
  }

  /* ---------------- 练习文本库 ---------------- */
  function matWordCount(s) {
    return String(s || '').replace(/\s+/g, '').length;
  }

  function paintMaterials() {
    var box = $('mat-list');
    if (!box) return;
    var list = T.materials || [];
    if (!list.length) {
      box.innerHTML = '<div class="mat-empty">还没有导入文本，学生端「中文跟打」只能用内置的 4 篇。</div>';
      return;
    }
    var lvName = { 1: '简单', 2: '中等', 3: '较难' };
    box.innerHTML = list.map(function (m) {
      return '<div class="mat-item">' +
        '<b>' + esc(m.title) + '</b>' +
        '<span>' + m.words + ' 字 · 难度 ' + (lvName[m.level] || '中等') +
        (m.by ? ' · ' + esc(m.by) : '') + '</span>' +
        '<button class="link-btn mat-del" data-del="' + esc(m.id) + '">删除</button>' +
        '</div>';
    }).join('');
  }

  function updateMatCount() {
    $('mat-count').textContent = matWordCount($('mat-body').value) + ' 字';
  }

  function saveMaterial() {
    var title = ($('mat-title').value || '').trim();
    var body = $('mat-body').value || '';
    if (!title) { toast('先给这段文字起个标题'); $('mat-title').focus(); return; }
    if (matWordCount(body) < 20) { toast('正文太短，至少 20 个字'); return; }
    $('mat-save').disabled = true;
    apiPost('/api/materials', {
      title: title, body: body, level: $('mat-level').value, lang: 'zh'
    }).then(function (r) {
      $('mat-save').disabled = false;
      if (r && r.ok) {
        T.materials = r.materials;
        paintMaterials();
        buildLevelOptions($('u-mode').value, $('u-level').value);
        $('mat-title').value = '';
        $('mat-body').value = '';
        updateMatCount();
        toast('已保存，学生端「中文跟打」里可以选择它了');
      } else if (r && (r.needLogin || r.needAdmin)) {
        showGate(r.error || '请重新登录');
      } else {
        toast((r && r.error) || '保存失败');
      }
    });
  }

  /* ---------------- 访问码 ---------------- */
  function loadCodes() {
    apiGet('/api/codes').then(function (r) {
      if (!r || !r.ok) {
        if (r && (r.needLogin || r.needAdmin)) showGate(r.error || '请重新登录');
        return;
      }
      $('code-admin').value = r.adminCode || '';
      $('code-teacher').value = r.teacherCode || '';
      $('code-hint').textContent = '';
    });
  }

  function saveCodes() {
    var ac = ($('code-admin').value || '').trim();
    var tc = ($('code-teacher').value || '').trim();
    var hint = $('code-hint');
    if (ac.length < 4 || ac.length > 32) { hint.textContent = '超级管理员访问码要 4—32 位'; return; }
    if (tc.length < 4 || tc.length > 32) { hint.textContent = '普通教师访问码要 4—32 位'; return; }
    if (ac === tc) { hint.textContent = '两个访问码不能相同'; return; }
    hint.textContent = '保存中…';
    apiPost('/api/codes', { adminCode: ac, teacherCode: tc }).then(function (r) {
      if (r && r.ok) {
        hint.textContent = '';
        toast('访问码已更新，下次登录用新码');
        loadCodes();
      } else {
        hint.textContent = (r && r.error) || '保存失败';
        if (r && (r.needLogin || r.needAdmin)) showGate(r.error || '请重新登录');
      }
    });
  }

  function drawQR(text) {
    fetch('/api/qr?text=' + encodeURIComponent(text))
      .then(function (r) { return r.json(); })
      .then(function (q) {
        if (!q || !q.modules) return;
        var box = $('qr-box');
        var scale = 6, quiet = 4;
        var n = q.size;
        var px = (n + quiet * 2) * scale;
        var cv = document.createElement('canvas');
        cv.width = px; cv.height = px;
        var ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, px, px);
        ctx.fillStyle = '#12161f';
        for (var y = 0; y < n; y++) {
          for (var x = 0; x < n; x++) {
            if (q.modules[y][x]) {
              ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
            }
          }
        }
        box.innerHTML = '';
        box.appendChild(cv);
      })
      .catch(function () { });
  }

  function fillSchoolSelects() {
    /* 排行榜的学校 / 班级筛选 */
    var bs = $('bd-school'), as = $('an-school');
    var curB = bs.value, curA = as.value;
    bs.innerHTML = '<option value="">全部学校</option>' + T.schools.map(function (s) {
      return '<option value="' + esc(s.name) + '">' + esc(s.name) + '</option>';
    }).join('');
    as.innerHTML = '<option value="">全部学校</option>' + T.schools.map(function (s) {
      return '<option value="' + esc(s.name) + '">' + esc(s.name) + '</option>';
    }).join('');
    bs.value = curB; as.value = curA;
    fillClassSelect('bd-scope', bs.value, T.bdCls);
    fillClassSelect('an-class', as.value, T.anCls);
  }

  function fillClassSelect(id, school, keep) {
    var sel = $(id);
    var s = T.schools.filter(function (x) { return x.name === school; })[0];
    sel.innerHTML = '<option value="">全部班级</option>' + (s ? (s.classes || []).map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
    }).join('') : '');
    if (keep) sel.value = keep;
  }

  /* ============================ 事件 ============================ */
  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('.tab');
    if (!b) return;
    Array.prototype.forEach.call(this.querySelectorAll('.tab'), function (x) { x.classList.remove('on'); });
    b.classList.add('on');
    T.panel = b.getAttribute('data-panel');
    document.querySelectorAll('.panel').forEach(function (p) {
      p.classList.toggle('hidden', p.id !== 'panel-' + T.panel);
    });
    if (T.panel === 'manage') initManage();
    paint();
  });

  $('ov-filter').addEventListener('input', function () {
    T.search = this.value;
    paintWall();
  });
  $('ov-only-online').addEventListener('change', function () {
    T.onlyOnline = this.checked;
    paintWall();
  });

  $('bd-kinds').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) { x.classList.remove('on'); });
    b.classList.add('on');
    T.bdKind = b.getAttribute('data-k');
    paintBoard();
  });
  $('bd-school').addEventListener('change', function () {
    T.bdSchool = this.value;
    T.bdCls = '';
    fillClassSelect('bd-scope', T.bdSchool, '');
    paintBoard();
  });
  $('bd-scope').addEventListener('change', function () {
    T.bdCls = this.value;
    paintBoard();
  });

  $('an-school').addEventListener('change', function () {
    T.anSchool = this.value;
    T.anCls = '';
    fillClassSelect('an-class', T.anSchool, '');
    scheduleAnalysis();
  });
  $('an-class').addEventListener('change', function () {
    T.anCls = this.value;
    scheduleAnalysis();
  });

  /* 统一测评保存 */
  $('u-mode').addEventListener('change', function () {
    buildLevelOptions(this.value, '');
  });

  $('u-save').addEventListener('click', function () {
    var body = {
      on: $('u-on').checked,
      mode: $('u-mode').value,
      level: $('u-level').value,
      sec: parseInt($('u-sec').value, 10)
    };
    apiPost('/api/unified', body).then(function (r) {
      if (r && r.ok) {
        T.unified = r.unified;
        paintTop();
        toast(r.unified.on
          ? '已开启统一测评（' + ($('u-mode').value === 'zh' ? '中文跟打' : '速度练习') + '），学生端已锁定'
          : '已关闭统一测评');
      } else if (r && (r.needLogin || r.needAdmin)) {
        showGate(r.error || '请重新登录');
      } else if (r && r.error) {
        toast(r.error);
      }
    });
  });

  /* 访问码 */
  $('code-save').addEventListener('click', saveCodes);

  /* 练习文本库 */
  $('mat-save').addEventListener('click', saveMaterial);
  $('mat-body').addEventListener('input', updateMatCount);
  $('mat-clear').addEventListener('click', function () {
    $('mat-title').value = '';
    $('mat-body').value = '';
    $('mat-hint').textContent = '';
    updateMatCount();
  });
  $('mat-file-btn').addEventListener('click', function () { $('mat-file').click(); });
  $('mat-file').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { toast('文件超过 2MB'); return; }
    var fr = new FileReader();
    fr.onload = function () {
      var txt = new TextDecoder('utf-8').decode(fr.result);
      /* 记事本另存的 ANSI(GBK) 文件按 UTF-8 读会出现替换字符，自动回退 */
      if (txt.indexOf('\ufffd') >= 0) {
        try { txt = new TextDecoder('gbk').decode(fr.result); } catch (e) { }
      }
      $('mat-body').value = txt;
      if (!$('mat-title').value.trim()) {
        $('mat-title').value = f.name.replace(/\.(txt|md)$/i, '').slice(0, 30);
      }
      $('mat-hint').textContent = '已读入 ' + f.name;
      updateMatCount();
    };
    fr.onerror = function () { toast('文件读不出来'); };
    fr.readAsArrayBuffer(f);
  });
  /* 删除用事件委托（列表是动态渲染的） */
  $('mat-list').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-del]');
    if (!btn) return;
    var id = btn.getAttribute('data-del');
    var item = (T.materials || []).filter(function (m) { return m.id === id; })[0];
    if (!confirm('删除文本《' + (item ? item.title : '') + '》？已经练过的成绩会保留。')) return;
    apiPost('/api/materials/delete', { id: id }).then(function (r) {
      if (r && r.ok) {
        T.materials = r.materials;
        paintMaterials();
        buildLevelOptions($('u-mode').value, $('u-level').value);
        toast('已删除');
      } else if (r && (r.needLogin || r.needAdmin)) {
        showGate(r.error || '请重新登录');
      } else {
        toast((r && r.error) || '删除失败');
      }
    });
  });

  /* 学校名单保存 */
  $('mg-save').addEventListener('click', function () {
    var lines = $('mg-ta').value.split(/\r?\n/);
    var schools = [];
    var bad = 0;
    lines.forEach(function (ln) {
      ln = ln.trim();
      if (!ln) return;
      var parts = ln.split('|');
      var name = (parts[0] || '').trim();
      if (!name) { bad++; return; }
      var classes = (parts[1] || '').split(/[,，、]/)
        .map(function (c) { return c.trim(); }).filter(Boolean);
      schools.push({ name: name, classes: classes });
    });
    if (!schools.length) { $('mg-hint').textContent = '至少要有 1 所学校'; $('mg-hint').style.color = 'var(--red)'; return; }
    apiPost('/api/schools', { schools: schools }).then(function (r) {
      if (r && r.ok) {
        T.schools = r.schools;
        fillSchoolSelects();
        $('mg-hint').textContent = '已保存 ' + r.schools.length + ' 所学校' + (bad ? '（跳过 ' + bad + ' 行格式错误）' : '');
        $('mg-hint').style.color = 'var(--green)';
        toast('名单已保存，学生端下拉框已更新');
      } else if (r && (r.needLogin || r.needAdmin)) {
        showGate(r.error || '请重新登录');
      } else if (r && r.error) {
        $('mg-hint').textContent = r.error;
        $('mg-hint').style.color = 'var(--red)';
      }
    });
  });
  $('mg-reload').addEventListener('click', function () {
    $('mg-ta').value = T.schools.map(function (s) {
      return s.name + '|' + (s.classes || []).join(',');
    }).join('\n');
    $('mg-hint').textContent = '';
  });

  /* 重置 */
  function doReset(scope, label) {
    if (!confirm('确定要' + label + '吗？这个操作不可撤销。')) return;
    apiPost('/api/reset', { scope: scope }).then(function (r) {
      if (r && r.ok) toast('已执行：' + label);
      else if (r && (r.needLogin || r.needAdmin)) showGate(r.error || '请重新登录');
      else toast((r && r.error) || '执行失败');
    });
  }
  $('r-live').addEventListener('click', function () { doReset('live', '清空在线名单'); });
  $('r-records').addEventListener('click', function () { doReset('records', '清空全部成绩'); });
  $('r-all').addEventListener('click', function () { doReset('all', '清空全部数据（含动态流）'); });

  /* ============================ Excel 导入 ============================ */
  var impSchools = null;

  $('imp-pick').addEventListener('click', function () { $('imp-file').click(); });

  $('imp-file').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';                      /* 清空，允许再次选同一个文件 */
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) { toast('文件超过 4MB，请精简后再导入'); return; }
    $('imp-name').textContent = f.name + ' · ' + Math.max(1, Math.round(f.size / 1024)) + ' KB';

    var fr = new FileReader();
    fr.onload = function () {
      var b64 = String(fr.result).split(',')[1] || '';
      apiPost('/api/schools/preview', { file: b64, name: f.name }).then(function (r) {
        if (!r || !r.ok) {
          impSchools = null;
          $('imp-prev').hidden = true;
          $('imp-actions').hidden = true;
          $('imp-name').textContent = f.name + ' · 解析失败';
          toast((r && r.error) || '解析失败');
          return;
        }
        impSchools = r.schools;
        renderPreview(r);
      });
    };
    fr.onerror = function () { toast('文件读取失败'); };
    fr.readAsDataURL(f);
  });

  function renderPreview(r) {
    var shown = r.schools.slice(0, 50);
    var html = '<div class="imp-prev-h">' +
      '解析完成：<b>' + r.schools.length + '</b> 所学校 · <b>' + r.totalClasses + '</b> 个班级' +
      '<i>（' + (r.format === 'xlsx' ? 'Excel' : 'CSV') + ' · 共 ' + r.rows + ' 行）</i></div>';
    html += '<div class="imp-prev-l">';
    html += shown.map(function (s) {
      return '<div class="imp-prev-row"><b>' + esc(s.name) + '</b><span>' +
        (s.classes.length ? esc(s.classes.join('、')) : '<em style="color:#b45309">还没有班级</em>') +
        '</span></div>';
    }).join('');
    if (r.schools.length > shown.length) {
      html += '<div class="imp-prev-row"><b>…</b><span>还有 ' +
        (r.schools.length - shown.length) + ' 所学校未显示</span></div>';
    }
    html += '</div>';
    if (r.warnings && r.warnings.length) {
      html += '<div class="imp-warn">需要留意：' + r.warnings.map(esc).join('；') + '</div>';
    }
    $('imp-prev').innerHTML = html;
    $('imp-prev').hidden = false;
    $('imp-actions').hidden = false;
  }

  $('imp-cancel').addEventListener('click', function () {
    impSchools = null;
    $('imp-prev').hidden = true;
    $('imp-actions').hidden = true;
    $('imp-name').textContent = '';
  });

  $('imp-do').addEventListener('click', function () {
    if (!impSchools) { toast('请先选择文件'); return; }
    var mode = document.querySelector('input[name="imp-mode"]:checked').value;
    if (mode === 'replace' && !confirm('覆盖替换会清空现有 ' + T.schools.length +
      ' 所学校名单，只保留这次导入的内容。确定吗？')) return;

    $('imp-do').disabled = true;
    apiPost('/api/schools/import', { schools: impSchools, mode: mode }).then(function (r) {
      $('imp-do').disabled = false;
      if (r && r.ok) {
        T.schools = r.schools;
        $('mg-ta').value = T.schools.map(function (s) {
          return s.name + '|' + (s.classes || []).join(',');
        }).join('\n');
        fillSchoolSelects();
        impSchools = null;
        $('imp-prev').hidden = true;
        $('imp-actions').hidden = true;
        $('imp-name').textContent = '';
        $('mg-hint').textContent = '已导入，现共 ' + r.schools.length + ' 所学校';
        $('mg-hint').style.color = 'var(--green)';
        toast('导入成功，学生端下拉框已更新');
      } else if (r && (r.needLogin || r.needAdmin)) {
        showGate(r.error || '请重新登录');
      } else {
        toast((r && r.error) || '导入失败');
      }
    });
  });

  /* 下载模板：CSV 带 BOM，Excel / WPS 双击就能正常显示中文 */
  $('imp-tpl').addEventListener('click', function () {
    var csv = '\ufeff学校,班级,班级2,班级3\r\n' +
      '第一实验小学,三年级1班,三年级2班,四年级1班\r\n' +
      '城关中心小学,三年级1班,三年级2班,\r\n' +
      '第一初级中学,七年级1班,七年级2班,\r\n';
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '学校班级名单-模板.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  });

  /* ============================ 启动 ============================ */
  var booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    connect();
  }

  $('gate-go').addEventListener('click', doLogin);
  $('gate-code').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doLogin();
  });
  $('btn-logout').addEventListener('click', logout);

  document.querySelectorAll('.panel').forEach(function (p) {
    p.classList.toggle('hidden', p.id !== 'panel-overview');
  });

  /* 进来先验令牌：有就直通，没有就挡住 */
  (function initAuth() {
    var t = getToken();
    if (!t) { showGate(''); return; }
    fetch('/api/auth/me', { headers: { 'X-Token': t }, cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r && r.ok) {
          hideGate();
          applyRole(r.role);
          boot();
        } else {
          setToken('');
          showGate('登录已过期，请重新输入访问码');
        }
      })
      .catch(function () { showGate('连不上服务端，请确认服务是否在运行'); });
  })();
})();
