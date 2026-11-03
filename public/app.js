/* ==========================================================================
 * 学生端 · 主控（app.js）
 * --------------------------------------------------------------------------
 * 负责页面调度与全局数据渲染：登录 → 大厅 → 练习 → 排行榜。
 * 练习模块（KD/LG/SP/WR）只管自己那块，不碰页面切换。
 * ========================================================================== */
(function () {
  'use strict';

  var TY = window.TY, D = window.TDATA, S = TY.S;
  var APP = window.APP = {};

  var curMode = '';
  var repaintTimer = null;

  /* ============================ 视图切换 ============================ */
  APP.go = function (view) {
    if (TY.curView === 'practice' && view !== 'practice') {
      TY.cleanup();
      TY.stopBeat();
      TY.setBeat({ mode: '', modeName: '', progress: 0, status: '在练习大厅' });
    }
    TY.curView = view;
    TY.views.forEach(function (v) {
      var el = document.getElementById('view-' + v);
      if (el) el.classList.toggle('hidden', v !== view);
    });
    window.scrollTo(0, 0);
    if (view === 'hall') paintHall();
    if (view === 'rank') paintRank();
    document.getElementById('btn-top-rank').hidden = (view === 'login');
    document.getElementById('chip-user').hidden = (view === 'login');
  };

  /* ============================ 启动 ============================ */
  /* 文本库：SSE 推的是摘要，正文单独拉一次（几十 KB，不适合每次推送都带） */
  function mergeMaterials(list) {
    var old = {};
    (S.materials || []).forEach(function (m) { old[m.id] = m; });
    return (list || []).map(function (m) {
      var o = old[m.id];
      return (o && o.body) ? Object.assign({}, m, { body: o.body }) : m;
    });
  }

  function loadMaterials() {
    return TY.net.get('/api/materials').then(function (d) {
      if (d && d.materials) S.materials = d.materials;
      return S.materials;
    });
  }

  APP.boot = function () {
    TY.net.connect({
      onState: function (d) {
        S.schools = d.schools || S.schools;
        S.unified = d.unified || S.unified;
        if (d.materials) S.materials = mergeMaterials(d.materials);
        S.board = d.board || [];
        S.online = (d.live || []).filter(function (x) { return x.online; }).length;
        fillSchools();
        paintChip();
        scheduleRepaint();
        if (TY.curView === 'hall') paintHall();
      },
      onLive: function () { paintChip(); },
      onResult: function () { scheduleRepaint(); },
      onConfig: function () {
        fillSchools();
        scheduleRepaint();
        /* 文本库变了不在这里打断练习：下次进中文跟打时会重新拉一次正文 */
      },
      onReset: function () { scheduleRepaint(); },
      onOffline: function () { paintChip(); }
    });

    TY.net.get('/api/state').then(function (d) {
      if (!d) { fillSchools(); return; }
      S.schools = d.schools || [];
      S.unified = d.unified || null;
      if (d.materials) S.materials = mergeMaterials(d.materials);
      S.board = d.board || [];
      S.online = d.stats ? d.stats.online : 0;
      fillSchools();
      paintChip();
      autoEnter();
    });
    loadMaterials();

    bindLogin();
    bindTop();
  };

  /* 有本地身份 → 直接进大厅；没有 → 停在登录页 */
  function autoEnter() {
    var saved = TY.store.load();
    if (saved && saved.name && saved.school) {
      S.school = saved.school;
      S.cls = saved.cls || '';
      S.name = saved.name;
      afterLogin(true);
      return;
    }
    /* 没有身份 = 换人了（关掉页面重开）。
       把「这台电脑上次用的学校 / 班级」预选好，只留姓名要填 —— 下拉不算身份，
       姓名才每次都问。 */
    var sel = document.getElementById('sel-school');
    var room = TY.room ? TY.room.load() : null;
    if (room && sel && S.schools.some(function (x) { return x.name === room.school; })) {
      sel.value = room.school;
      sel.dispatchEvent(new Event('change'));
      var sc = document.getElementById('sel-class');
      var hasCls = false;
      if (sc && room.cls) {
        hasCls = Array.prototype.some.call(sc.options, function (o) { return o.value === room.cls; });
        if (hasCls) { sc.value = room.cls; sc.dispatchEvent(new Event('change')); }
      }
      paintKeep(hasCls ? room.school + ' · ' + room.cls : room.school);
      stepDots(hasCls ? 3 : 2);
      if (hasCls) setTimeout(function () {
        var i = document.getElementById('inp-name');
        if (i && !i.disabled) i.focus();
      }, 80);
      return;
    }
    /* 只有一个学校时自动选中，省一步 */
    if (sel && S.schools.length === 1) {
      sel.value = S.schools[0].name;
      sel.dispatchEvent(new Event('change'));
    }
    stepDots(1);
  }

  /* ============================ 登录 ============================ */
  function fillSchools() {
    var sel = document.getElementById('sel-school');
    if (!sel || sel.dataset.filled === String(S.schools.length)) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">请选择学校</option>' +
      S.schools.map(function (s) {
        return '<option value="' + TY.esc(s.name) + '">' + TY.esc(s.name) + '</option>';
      }).join('');
    sel.dataset.filled = String(S.schools.length);
    if (cur) { sel.value = cur; sel.dispatchEvent(new Event('change')); }
  }

  function bindLogin() {
    var sSchool = document.getElementById('sel-school');
    var sClass = document.getElementById('sel-class');
    var iName = document.getElementById('inp-name');
    var btn = document.getElementById('btn-login');
    var err = document.getElementById('login-err');

    sSchool.addEventListener('change', function () {
      var s = S.schools.filter(function (x) { return x.name === sSchool.value; })[0];
      sClass.innerHTML = '<option value="">请选择班级</option>';
      if (!s) {
        sClass.disabled = true; iName.disabled = true; iName.value = '';
        btn.disabled = true; stepDots(1); return;
      }
      (s.classes || []).forEach(function (c) {
        var o = document.createElement('option');
        o.value = c; o.textContent = c;
        sClass.appendChild(o);
      });
      sClass.disabled = false;
      iName.disabled = true; iName.value = '';
      btn.disabled = true;
      stepDots(2);
      iName.focus();
    });

    sClass.addEventListener('change', function () {
      var ok = !!sClass.value;
      iName.disabled = !ok;
      btn.disabled = true;
      if (ok) { stepDots(3); iName.focus(); }
      checkName();
    });

    iName.addEventListener('input', checkName);
    iName.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !btn.disabled) doLogin();
    });

    function checkName() {
      var v = iName.value.trim();
      err.textContent = '';
      if (v.length && v.length < 2) { err.textContent = '姓名至少 2 个字'; }
      btn.disabled = !(sSchool.value && sClass.value && v.length >= 2);
      return !btn.disabled;
    }

    btn.addEventListener('click', doLogin);

    function doLogin() {
      var nm = iName.value.trim();
      if (!nm || nm.length < 2) { err.textContent = '请填写你的姓名（至少 2 个字）'; return; }
      S.school = sSchool.value;
      S.cls = sClass.value;
      S.name = nm;
      TY.store.save();
      /* 学校和班级留给下一位同学预选；姓名不记 */
      if (TY.room) TY.room.save(S.school, S.cls);
      afterLogin(false);
    }
  }

  function stepDots(n) {
    var dots = document.querySelectorAll('.step-dot');
    var lines = document.querySelectorAll('.step-line');
    Array.prototype.forEach.call(dots, function (d, i) { d.classList.toggle('on', i < n); });
    Array.prototype.forEach.call(lines, function (l, i) { l.classList.toggle('on', i < n - 1); });
  }

  function afterLogin(silent) {
    paintChip();
    document.getElementById('chip-user').hidden = false;
    document.getElementById('btn-top-rank').hidden = false;
    APP.go('hall');
    if (!silent) TY.toast('欢迎，' + S.name + '（' + S.cls + '）');
    TY.setBeat({ mode: '', status: '在练习大厅' });
    TY.startBeat();
  }

  /* ============================ 顶栏 ============================ */
  function bindTop() {
    document.getElementById('btn-switch').addEventListener('click', switchStudent);
    document.getElementById('btn-top-rank').addEventListener('click', function () {
      APP.go('rank');
    });
  }

  /* ---------------------------------------------------------------
   * 换同学：一台电脑多个学生轮流用
   * 保留"学校 + 班级"（同一间机房基本是同班轮流），只清姓名，
   * 并显式把姓名框 / 登录按钮的禁用态重置 —— 不能靠给 select 赋值
   * 去间接触发 change，直接赋值不会触发监听器，姓名框会一直是灰的。
   * --------------------------------------------------------------- */
  function switchStudent() {
    if (TY.curView === 'practice') TY.cleanup();
    TY.stopBeat();
    TY.store.clear();
    if (window.KD && KD.resetUnlocked) KD.resetUnlocked();
    S.name = '';

    var sSchool = document.getElementById('sel-school');
    var sClass = document.getElementById('sel-class');
    var iName = document.getElementById('inp-name');
    var btn = document.getElementById('btn-login');
    var err = document.getElementById('login-err');
    /* 下拉框可能是空的（学生是"带身份直进大厅"、从没碰过登录页），
       这时从身份状态里把学校班级捡回来，别让下一位同学从头再选一遍 */
    var keepSchool = sSchool.value || S.school || '';
    var keepClass = sClass.value || S.cls || '';

    iName.value = '';
    btn.disabled = true;
    err.textContent = '';

    if (keepSchool && sSchool.value !== keepSchool) {
      sSchool.value = keepSchool;
      sSchool.dispatchEvent(new Event('change'));   /* 重建班级下拉 + 重置下游 */
    }
    if (keepClass && sClass.value !== keepClass) {
      sClass.value = keepClass;
      sClass.dispatchEvent(new Event('change'));    /* 关键：解锁姓名框 */
    }
    sClass.disabled = !keepSchool;
    iName.disabled = !(keepSchool && keepClass);
    stepDots(keepSchool ? (keepClass ? 3 : 2) : 1);
    paintKeep(keepSchool && keepClass ? keepSchool + ' · ' + keepClass : '');

    APP.go('login');
    if (keepSchool && keepClass) setTimeout(function () { iName.focus(); }, 60);
  }
  APP.switchStudent = switchStudent;

  /* 登录页顶部的"接着用哪个班"提示条 */
  function paintKeep(txt) {
    var box = document.getElementById('login-keep');
    if (!box) return;
    if (!txt) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.innerHTML = '<span>这台电脑上次用的</span><b>' + TY.esc(txt) + '</b>' +
      '<i>写下你的名字就能开始</i>';
  }

  function paintChip() {
    document.getElementById('online-num').textContent = S.online || 0;
    var u = document.getElementById('user-text');
    if (u && S.name) {
      u.textContent = S.school + ' ' + S.cls + ' ' + S.name;
    }
    var chip = document.getElementById('chip-online');
    if (chip) {
      var dot = chip.querySelector('.dot');
      if (dot) dot.style.background = S.connected ? '#22c55e' : '#f59e0b';
    }
  }

  /* ============================ 大厅 ============================ */
  function meRow() {
    var id = [S.school, S.cls, S.name].join('|');
    for (var i = 0; i < S.board.length; i++) if (S.board[i].id === id) return S.board[i];
    return null;
  }

  function paintHall() {
    document.getElementById('hall-hi').textContent = '你好，' + S.name;

    /* 统一测评提示 */
    var uBox = document.getElementById('hall-unified');
    if (S.unified && S.unified.on) {
      var mn = {
        key: '键位闯关', falling: '落字游戏', speed: '速度练习',
        wordrush: '单词冲刺', zh: '中文跟打'
      };
      uBox.classList.remove('hidden');
      document.getElementById('hall-unified-text').textContent =
        '老师已开启全班统一测评：' + (mn[S.unified.mode] || '速度练习') +
        ' · ' + (S.unified.sec >= 60 ? (S.unified.sec / 60) + ' 分钟' : S.unified.sec + ' 秒') +
        '，成绩计入统一榜单';
    } else {
      uBox.classList.add('hidden');
    }

    /* 我的成绩 */
    var me = meRow();
    /* 换过电脑（本地解锁状态丢了）时，用服务端记录的最高通过关补回来 */
    if (me && me.keyLevel > 0 && window.KD) KD.setUnlocked(me.keyLevel + 1);

    document.getElementById('my-score').textContent = me ? TY.fmt(me.total) : '0';
    document.getElementById('my-cpm').textContent = me && me.cpm ? TY.fmt(me.cpm) : '—';
    document.getElementById('my-acc').textContent = me && me.acc ? TY.fmt(me.acc, 0) + '%' : '—';
    document.getElementById('my-rank').textContent = me ? ('第 ' + me.rank) : '—';
    document.getElementById('my-tip').textContent = me
      ? (me.acc > 0 && me.acc < TY.accPct()
        ? '准确率还没到 ' + TY.accPct() + '%，先慢下来打准，成绩才算数。'
        : (me.keyLevel < 1 ? '从键位闯关开始，先把手指放对位置。' : '继续练，速度会随着准确率一起上来。'))
      : '从键位闯关开始，先把手指放对位置。';

    /* 模式卡上的"我的最佳" */
    paintModeMeta(me);

    /* 班级前五：名次按"班内"重新数，不能用全局 rank（会跳号） */
    var same = S.board.filter(function (r) { return r.school === S.school && r.cls === S.cls; });
    var box = document.getElementById('rank-mini-list');
    if (!same.length) {
      box.innerHTML = '<li class="empty">本班还没有人上榜，你可以是第一个</li>';
    } else {
      box.innerHTML = same.slice(0, 5).map(function (r, i) {
        var pos = i + 1;
        var cls = 'rk' + (pos === 1 ? ' g1' : pos === 2 ? ' g2' : pos === 3 ? ' g3' : '');
        var isMe = r.name === S.name;
        return '<li>' +
          '<span class="' + cls + '">' + pos + '</span>' +
          '<span class="nm' + (isMe ? ' me' : '') + '">' + TY.esc(r.name) + (isMe ? '（我）' : '') + '</span>' +
          '<span class="sc">' + TY.fmt(r.total) + '</span>' +
          '</li>';
      }).join('');
    }
  }

  function paintModeMeta(me) {
    var metas = document.querySelectorAll('[data-meta]');
    Array.prototype.forEach.call(metas, function (el) {
      var m = el.getAttribute('data-meta');
      /* "还没上榜"比"还没练过"准确：也可能是练了但准确率不够 */
      var txt = '还没上榜';
      if (me) {
        if (m === 'key' && me.keyLevel > 0) txt = '已通过第 ' + me.keyLevel + ' 关 · ' + TY.fmt(me.part.key) + ' 分';
        else if (m === 'speed' && me.part.speed > 0) txt = '最高 ' + TY.fmt(me.cpm) + ' CPM · ' + TY.fmt(me.part.speed) + ' 分';
        else if (m === 'wordrush' && me.part.wordrush > 0) txt = '最佳 ' + TY.fmt(me.part.wordrush) + ' 分';
        else if (m === 'zh' && me.zhCpm > 0) txt = '最高 ' + TY.fmt(me.zhCpm) + ' 字/分 · ' + TY.fmt(me.part.zh) + ' 分';
        else if (m === 'falling' && me.fallScore > 0) txt = '最高 ' + me.fallScore + ' 分' +
          (me.reaction ? ' · 反应 ' + me.reaction + 'ms' : '');
      }
      el.textContent = txt;
      el.classList.toggle('has', txt !== '还没上榜');
    });
  }

  function scheduleRepaint() {
    if (repaintTimer) return;
    repaintTimer = setTimeout(function () {
      repaintTimer = null;
      if (TY.curView === 'hall') paintHall();
      if (TY.curView === 'rank') paintRank();
      paintChip();
    }, 450);
  }

  /* ============================ 进入练习 ============================ */
  APP.enterMode = function (mode) {
    curMode = mode;
    TY.cleanup();
    var titles = {
      key: '键位闯关', falling: '落字游戏', speed: '速度练习',
      wordrush: '单词冲刺', zh: '中文跟打'
    };
    document.getElementById('prac-title').textContent = titles[mode] || '练习';
    document.getElementById('prac-right').innerHTML =
      '<span class="chip"><i class="dot" style="background:#2563eb"></i>' +
      TY.esc(S.cls) + ' · ' + TY.esc(S.name) + '</span>';
    document.getElementById('prac-body').innerHTML = '';
    APP.go('practice');

    var body = document.getElementById('prac-body');
    if (mode === 'key') KD.render(body);
    else if (mode === 'falling') LG.render(body);
    else if (mode === 'speed') SP.render(body);
    else if (mode === 'wordrush') WR.render(body);
    else if (mode === 'zh') {
      /* 中文要先拿到文本正文；拿不到就退回内置语料，不让学生空等 */
      TY.net.get('/api/materials').then(function (d) {
        if (d && d.materials) S.materials = d.materials;
        if (curMode === 'zh') ZH.render(body);
      });
      document.getElementById('prac-body').innerHTML =
        '<div class="mode-loading">正在准备中文练习文本…</div>';
    }

    TY.setBeat({ mode: mode, modeName: titles[mode], progress: 0, status: '准备中' });
    TY.startBeat();
  };

  /* ============================ 排行榜 ============================ */
  var rankTab = 'total';

  function sortRows(tab) {
    var same = S.board.filter(function (r) { return r.school === S.school && r.cls === S.cls; });
    var rows = same.slice();
    if (tab === 'speed') {
      rows = rows.filter(function (r) { return r.cpm > 0; }).sort(function (a, b) { return b.cpm - a.cpm; });
    } else if (tab === 'zh') {
      rows = rows.filter(function (r) { return r.zhCpm > 0; }).sort(function (a, b) { return b.zhCpm - a.zhCpm; });
    } else if (tab === 'acc') {
      rows = rows.filter(function (r) { return r.acc > 0; }).sort(function (a, b) { return b.acc - a.acc; });
    } else if (tab === 'react') {
      rows = rows.filter(function (r) { return r.reaction > 0; }).sort(function (a, b) { return a.reaction - b.reaction; });
    } else {
      rows = rows.filter(function (r) { return r.total > 0; }).sort(function (a, b) { return b.total - a.total; });
    }
    return rows;
  }

  function paintRank() {
    var rows = sortRows(rankTab);
    var tbody = document.getElementById('rank-tbody');
    var empty = document.getElementById('rank-empty');
    var tbl = document.getElementById('rank-tbl');

    var thMain = document.getElementById('th-main');
    var mainLabel = {
      total: '总分', speed: 'CPM', zh: '字/分钟',
      acc: '准确率', react: '反应时间'
    }[rankTab];
    thMain.textContent = mainLabel;

    if (!rows.length) {
      tbl.style.display = 'none';
      empty.hidden = false;
      return;
    }
    tbl.style.display = '';
    empty.hidden = true;

    tbody.innerHTML = rows.map(function (r, i) {
      var pos = i + 1;
      var pcls = 'pos' + (pos <= 3 ? ' m' + pos : '');
      var mine = r.name === S.name;
      var main = '';
      if (rankTab === 'total') main = TY.fmt(r.total);
      else if (rankTab === 'speed') main = TY.fmt(r.cpm);
      else if (rankTab === 'zh') main = TY.fmt(r.zhCpm);
      else if (rankTab === 'acc') main = TY.fmt(r.acc, 0) + '%';
      else if (rankTab === 'react') main = r.reaction + ' ms';

      return '<tr' + (mine ? ' class="me"' : '') + '>' +
        '<td class="' + pcls + '">' + pos + '</td>' +
        '<td class="nm">' + TY.esc(r.name) + (mine ? '（我）' : '') + '</td>' +
        '<td class="cls">' + TY.esc(r.cls) + '</td>' +
        '<td><b>' + main + '</b></td>' +
        '<td>' + (r.cpm ? TY.fmt(r.cpm) : '—') + '</td>' +
        '<td>' + (r.zhCpm ? TY.fmt(r.zhCpm) : '—') + '</td>' +
        '<td>' + (r.acc ? TY.fmt(r.acc, 0) + '%' : '—') + '</td>' +
        '<td>' + (r.keyLevel ? ('第 ' + r.keyLevel + ' 关') : '—') + '</td>' +
        '</tr>';
    }).join('');
  }

  document.getElementById('rank-tabs').addEventListener('click', function (e) {
    var b = e.target.closest('.rt');
    if (!b) return;
    Array.prototype.forEach.call(this.querySelectorAll('.rt'), function (x) { x.classList.remove('on'); });
    b.classList.add('on');
    rankTab = b.getAttribute('data-tab');
    paintRank();
  });

  /* ============================ 事件绑定 ============================ */
  document.addEventListener('click', function (e) {
    var go = e.target.closest('[data-go]');
    if (go) {
      var v = go.getAttribute('data-go');
      if (v === 'hall' || v === 'rank') { APP.go(v); return; }
      if (v === 'key' || v === 'falling' || v === 'speed' || v === 'wordrush' || v === 'zh') {
        APP.enterMode(v); return;
      }
    }
    var mode = e.target.closest('[data-mode]');
    if (mode) APP.enterMode(mode.getAttribute('data-mode'));
  });

  document.getElementById('btn-back').addEventListener('click', function () {
    APP.go('hall');
  });

  /* 统一测评开启时，若学生正在相关模式，提示一句（不强制打断） */
  var lastUnifiedOn = false;
  setInterval(function () {
    var on = !!(S.unified && S.unified.on);
    if (on && !lastUnifiedOn && TY.curView === 'hall') {
      TY.toast('老师开启了统一测评，请进入「速度练习」完成测评', 3600);
    }
    lastUnifiedOn = on;
  }, 3000);

  /* 启动 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', APP.boot);
  } else {
    APP.boot();
  }
})();
