/* ==========================================================================
 * 键位闯关（keydrill.js）
 * --------------------------------------------------------------------------
 * 一个键一个键地练，屏幕告诉学生"这一下该用哪根手指"。
 * 判定口径：打对 need 个键即过关；打错不倒退，但会拉低准确率（准确率低于门槛不记成绩，门槛由服务端下发）。
 * ========================================================================== */
(function () {
  'use strict';

  var TY = window.TY, D = window.TDATA;
  var KD = window.KD = {};

  /* 解锁进度跟着「这次会话」走：换人重开页面就重新开始，登录后由
     服务端的 me.keyLevel 回填（见 app.js:308）。存成本地持久存储会把
     上一位同学的关卡留给下一位。 */
  var SS_UNLOCK = 'typing_key_unlocked';

  /* 过关后自动进入下一关的等待时间。这期间学生点成绩单上任何按钮
     （再打一次 / 完成 / 换人）都会关掉面板，自动跳转随之取消。 */
  var AUTO_NEXT_MS = 3000;

  KD.getUnlocked = function () {
    var n = parseInt(sessionStorage.getItem(SS_UNLOCK) || '1', 10);
    if (!(n >= 1)) n = 1;
    return Math.min(n, D.KEY_LEVELS.length);
  };
  KD.setUnlocked = function (n) {
    if (n > KD.getUnlocked()) sessionStorage.setItem(SS_UNLOCK, String(Math.min(n, D.KEY_LEVELS.length)));
  };
  KD.bestLevel = function () {
    /* 已通过的最高关 = 已解锁关 - 1 */
    return Math.max(0, KD.getUnlocked() - 1);
  };
  /* 换同学时调用：解锁进度是按"这台电脑"存的，不能留给下一个人 */
  KD.resetUnlocked = function () {
    try { sessionStorage.removeItem(SS_UNLOCK); } catch (e) { }
  };

  /* ============================ 主渲染 ============================ */
  KD.render = function (body, opts) {
    opts = opts || {};
    var levelIdx = Math.max(0, Math.min(D.KEY_LEVELS.length - 1,
      (opts.level ? opts.level - 1 : KD.getUnlocked() - 1)));

    body.innerHTML =
      '<div class="kd-wrap">' +
        '<div class="kd-levels" id="kd-levels"></div>' +
        '<div class="kd-stage" id="kd-stage">' +
          '<p class="kd-tip" id="kd-tip"></p>' +
          '<div class="kd-target" id="kd-target">—</div>' +
          '<div class="kd-finger" id="kd-finger"><i></i><span>准备</span></div>' +
          '<div class="kd-streak">' +
            '<div class="kd-st-item"><b id="kd-done">0</b><span>已打对</span></div>' +
            '<div class="kd-st-item"><b id="kd-err">0</b><span>打错</span></div>' +
            '<div class="kd-st-item"><b id="kd-acc">100%</b><span>准确率</span></div>' +
            '<div class="kd-st-item"><b id="kd-time">0.0s</b><span>用时</span></div>' +
          '</div>' +
          '<div class="kd-goal">' +
            '<div class="kd-goal-t" id="kd-goal-t"></div>' +
            '<div class="pbar"><i id="kd-bar" style="width:0%"></i></div>' +
          '</div>' +
        '</div>' +
        '<div id="kd-kb"></div>' +
      '</div>';

    TY.kb.build(document.getElementById('kd-kb'));

    var S = {
      lvIdx: levelIdx,
      lv: D.KEY_LEVELS[levelIdx],
      seq: [],
      idx: 0,
      done: 0,
      err: 0,
      t0: 0,
      timer: null,
      autoT: null,
      locked: false
    };

    /* ---- 关卡条 ---- */
    function paintLevels() {
      var unlocked = KD.getUnlocked();
      var passed = KD.bestLevel();
      var box = document.getElementById('kd-levels');
      box.innerHTML = D.KEY_LEVELS.map(function (l, i) {
        var cls = 'kd-lv';
        if (i + 1 > unlocked) cls += ' lock';
        if (i === S.lvIdx) cls += ' cur';
        if (i + 1 <= passed) cls += ' done';
        return '<button class="' + cls + '" data-lv="' + (i + 1) + '">' +
          '<div class="n">第 ' + l.id + ' 关</div>' +
          '<div class="t">' + TY.esc(l.name) + '</div>' +
          '<div class="k">' + TY.esc(l.tag) + '</div>' +
          '</button>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('.kd-lv'), function (b) {
        b.addEventListener('click', function () {
          var lv = parseInt(b.getAttribute('data-lv'), 10);
          if (lv > KD.getUnlocked()) {
            TY.toast('先通过第 ' + (lv - 1) + ' 关，才能进入第 ' + lv + ' 关');
            return;
          }
          startLevel(lv);
        });
      });
    }

    /* ---- 开始某一关 ---- */
    function startLevel(lv) {
      clearInterval(S.timer);
      if (S.autoT) { clearTimeout(S.autoT); S.autoT = null; }
      S.lvIdx = lv - 1;
      S.lv = D.KEY_LEVELS[S.lvIdx];
      S.seq = D.genKeyDrill(S.lv.chars, S.lv.need * 3, false).split('');
      S.idx = 0; S.done = 0; S.err = 0; S.t0 = 0; S.locked = false;
      TY.track.reset();
      paintLevels();

      document.getElementById('kd-tip').textContent = S.lv.tip;
      document.getElementById('kd-goal-t').textContent =
        '目标：打对 ' + S.lv.need + ' 个键　·　' + S.lv.goal;
      paintStats();
      nextChar();

      clearInterval(S.timer);
      S.timer = setInterval(tick, 100);
      TY.setBeat({ mode: 'key', modeName: '键位闯关', progress: 0, status: '第 ' + lv + ' 关' });
    }

    function tick() {
      if (!S.t0) return;
      document.getElementById('kd-time').textContent =
        ((Date.now() - S.t0) / 1000).toFixed(1) + 's';
    }

    function paintStats() {
      var total = S.done + S.err;
      var acc = total > 0 ? S.done / total : 1;
      document.getElementById('kd-done').textContent = S.done;
      document.getElementById('kd-err').textContent = S.err;
      var accEl = document.getElementById('kd-acc');
      accEl.textContent = Math.round(acc * 100) + '%';
      accEl.style.color = acc >= TY.S.accGate ? 'var(--green)' : (total > 4 ? 'var(--red)' : '');
      var bar = document.getElementById('kd-bar');
      bar.style.width = Math.min(100, S.done / S.lv.need * 100) + '%';
      TY.setBeat({
        progress: Math.min(1, S.done / S.lv.need),
        acc: acc, keys: TY.track.keys,
        cpm: S.t0 ? Math.round(S.done / ((Date.now() - S.t0) / 60000)) : 0
      });
    }

    /* ---- 换下一个目标字符 ---- */
    function nextChar() {
      if (S.idx >= S.seq.length) S.seq = S.seq.concat(D.genKeyDrill(S.lv.chars, S.lv.need * 2, false).split(''));
      var ch = S.seq[S.idx];
      var t = document.getElementById('kd-target');
      t.textContent = TY.showCh(ch);
      t.classList.remove('pop');
      void t.offsetWidth;
      t.classList.add('pop');

      var f = TY.kb.fingerOf(ch);
      var fe = document.getElementById('kd-finger');
      fe.style.background = f.color + '18';
      fe.style.borderColor = f.color + '44';
      fe.style.color = f.color;
      fe.querySelector('i').style.background = f.color;
      fe.querySelector('span').textContent = f.name;

      TY.kb.mark(ch);
    }

    /* ---- 击键处理 ---- */
    TY.onKey(function (key, e) {
      if (S.locked) return;
      if (key === 'Backspace') { if (e) e.preventDefault(); return; }
      if (key === ' ' || key === 'Tab' || key === 'Enter' || key === 'Escape') {
        if (e) e.preventDefault();
        return;
      }
      if (key.length !== 1) return;

      var want = S.seq[S.idx];
      var got = key.toLowerCase();
      if (got === want) {
        if (!S.t0) S.t0 = Date.now();
        S.done++;
        S.idx++;
        TY.track.ok(want);
        TY.kb.flash(want, 'hit');
        paintStats();
        if (S.done >= S.lv.need) { finish(); return; }
        nextChar();
      } else {
        if (!S.t0) S.t0 = Date.now();
        S.err++;
        TY.track.err(want, got);
        TY.kb.flash(want, 'miss');
        var stage = document.getElementById('kd-stage');
        stage.style.animation = 'none';
        void stage.offsetWidth;
        stage.style.animation = 'shake .28s';
        paintStats();
      }
    });

    /* ---- 过关结算 ---- */
    function finish() {
      S.locked = true;
      clearInterval(S.timer);
      var sec = Math.max(1, (Date.now() - S.t0) / 1000);
      var total = S.done + S.err;
      var acc = total > 0 ? S.done / total : 1;

      TY.submit({
        mode: 'key', level: String(S.lvIdx + 1),
        correct: S.done, wrong: S.err, sec: sec,
        keys: TY.track.dump()
      }).then(function (r) {
        var ok = r && r.ok;
        var rec = ok ? r.record : null;
        var qualified = rec ? rec.qualified : (acc >= TY.S.accGate);
        if (qualified && S.lvIdx + 1 >= KD.getUnlocked()) KD.setUnlocked(S.lvIdx + 2);

        var isLast = (S.lvIdx + 1) >= D.KEY_LEVELS.length;
        var canAuto = !!qualified && !isLast;

        TY.showResult({
          badge: '第 ' + (S.lvIdx + 1) + ' 关通过',
          title: S.lv.name + ' · 打对 ' + S.done + ' 键',
          score: rec ? rec.score : '—',
          cpm: rec ? rec.cpm : Math.round(S.done / (sec / 60)),
          acc: Math.round(acc * 100) + '%',
          cw: S.done + ' / ' + S.err,
          rank: r && r.rank,
          good: qualified,
          note: !ok ? '这台电脑暂时连不上教师机，成绩存在本机，稍后老师可以重新采集。'
            : (qualified
              ? '第 ' + (S.lvIdx + 1) + ' 关已记录。' + (isLast
                ? '五关全部通过，去试试速度练习吧。'
                : AUTO_NEXT_MS / 1000 + ' 秒后自动进入第 ' + (S.lvIdx + 2) + ' 关：' +
                  D.KEY_LEVELS[S.lvIdx + 1].name + '（点【完成】可以留在这里）')
              : '准确率 ' + Math.round(acc * 100) + '%，低于 ' + TY.accPct() +
                '% 不记成绩。慢一点，先把每个键打准。'),
          onAgain: function () { startLevel(S.lvIdx + 1); },
          againText: '再打一次',
          onDone: function () { if (window.APP) APP.go('hall'); }
        });
        paintLevels();

        /* 过关后自动进入下一关。不设"取消按钮"：学生只要点了成绩单上
           任何一个按钮，面板就会关掉，到点时这里发现面板已关就不跳了。 */
        if (canAuto) {
          if (S.autoT) clearTimeout(S.autoT);
          S.autoT = setTimeout(function () {
            S.autoT = null;
            var m = document.getElementById('modal-result');
            if (!m || !m.classList.contains('show')) return;
            TY.hideResult();
            startLevel(S.lvIdx + 2);
          }, AUTO_NEXT_MS);
        }
      });
    }

    startLevel(levelIdx + 1);
    TY.onCleanup(function () {
      clearInterval(S.timer);
      if (S.autoT) { clearTimeout(S.autoT); S.autoT = null; }
    });
  };

})();
