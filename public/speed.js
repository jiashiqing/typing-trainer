/* ==========================================================================
 * 速度练习（speed.js）—— 金山打字通式逐字符跟打
 * --------------------------------------------------------------------------
 * 判定口径（教师端榜单完全依赖它，改动请同步 server.js 的 computeResult）：
 *   · 严格模式：打错不前进，必须打对才能往下走
 *   · 准确率 = 正确字符 / (正确字符 + 错误击键)，同一个字错 3 次算 3 次错误
 *   · 用时 = 从第一次击键到结束，时间到即结算
 *   · 有效 CPM = 正确字符 / 用时（分钟），只算打对的，乱打不涨分
 * ========================================================================== */
(function () {
  'use strict';

  var TY = window.TY, D = window.TDATA;
  var SP = window.SP = {};

  var LEVELS = [
    { k: 'text', name: '英文短文', diff: 1.20, tip: '综合难度最高，正式测评建议用这个' },
    { k: 'word', name: '英文单词', diff: 1.05, tip: '由常用单词组成，适合四—六年级' },
    { k: 'keys', name: '键位串', diff: 0.90, tip: '纯字母随机串，适合三年级刚学完指法' },
    { k: 'num', name: '数字符号', diff: 1.10, tip: '数字排与标点，初中适用' }
  ];

  SP.render = function (body, opts) {
    opts = opts || {};
    var uni = TY.S.unified && TY.S.unified.on ? TY.S.unified : null;

    var st = {
      level: uni ? uni.level : (opts.level || 'text'),
      sec: uni ? uni.sec : (opts.sec || 120),
      showKb: opts.showKb !== false
    };
    if (!LEVELS.some(function (l) { return l.k === st.level; })) st.level = 'text';

    body.innerHTML =
      '<div class="sp-wrap">' +
        '<div class="sp-params">' +
          '<span class="sp-p-label">时长</span>' +
          '<div class="seg" id="sp-segs">' +
            [60, 120, 180, 300].map(function (s) {
              return '<button data-sec="' + s + '"' + (s === st.sec ? ' class="on"' : '') + '>' +
                (s < 60 ? s + ' 秒' : (s / 60) + ' 分钟') + '</button>';
            }).join('') +
          '</div>' +
          '<span class="sp-p-label" style="margin-left:10px">内容</span>' +
          '<div class="seg" id="sp-lvs">' +
            LEVELS.map(function (l) {
              return '<button data-lv="' + l.k + '"' + (l.k === st.level ? ' class="on"' : '') + '>' + l.name + '</button>';
            }).join('') +
          '</div>' +
          '<div class="sp-spacer"></div>' +
          '<button class="btn-ghost btn-sm" id="sp-kb-toggle">' + (st.showKb ? '隐藏键盘' : '显示键盘') + '</button>' +
        '</div>' +

        '<div class="sp-stage">' +
          '<div class="sp-metrics">' +
            '<div class="mt hot"><b id="sp-time">' + fmtSec(st.sec) + '</b><span>剩余时间</span></div>' +
            '<div class="mt"><b id="sp-cpm">0</b><span>CPM 字符/分</span></div>' +
            '<div class="mt"><b id="sp-acc">100%</b><span>准确率</span></div>' +
            '<div class="mt"><b id="sp-wpm">0</b><span>WPM</span></div>' +
          '</div>' +
          '<div class="sp-txt" id="sp-txt"><div class="sp-txt-inner" id="sp-txt-inner"></div></div>' +
          '<div class="sp-foot">' +
            '<div class="pbar"><i id="sp-bar" style="width:0%"></i></div>' +
            '<span class="sp-count" id="sp-count">0 / 0</span>' +
          '</div>' +
          '<div class="sp-ready" id="sp-ready">' +
            '<h3>' + (uni ? '统一测评' : '准备好了吗') + '</h3>' +
            '<p id="sp-ready-tip">' + (uni
              ? '本次为全班统一测评：' + LEVELS.find(function (l) { return l.k === st.level; }).name +
                ' · ' + (st.sec / 60) + ' 分钟。参数已由老师锁定。'
              : '用手指打字，不要看键盘。<b>3 秒后开始</b>，计时从你按下第一个键起算。') +
            '</p>' +
            '<button class="btn-blue" id="sp-go">开始练习</button>' +
          '</div>' +
        '</div>' +
        '<div id="sp-kb"></div>' +
      '</div>';

    var inner = document.getElementById('sp-txt-inner');
    var box = document.getElementById('sp-txt');
    var kbBox = document.getElementById('sp-kb');

    var G = {
      running: false, done: false,
      text: '', spans: [], idx: 0,
      correct: 0, wrong: 0,
      t0: 0, timer: 0, limit: st.sec * 1000,
      lines: 0
    };

    if (!st.showKb) kbBox.classList.add('hidden');
    else TY.kb.build(kbBox);

    /* ---------------- 语料 ---------------- */
    function newText() {
      var need = Math.max(300, Math.round(st.sec * 3.2));
      G.text = D.corpus(st.level, need).text;
      G.spans = [];
      G.idx = 0;
      inner.innerHTML = '';
      var frag = document.createDocumentFragment();
      for (var i = 0; i < G.text.length; i++) {
        var s = document.createElement('span');
        s.className = 'ch';
        s.textContent = G.text[i];
        frag.appendChild(s);
        G.spans.push(s);
      }
      inner.appendChild(frag);
      inner.style.transform = 'translateY(0)';
      paintCur();
    }

    function paintCur() {
      for (var i = 0; i < G.spans.length; i++) G.spans[i].classList.remove('cur');
      var el = G.spans[G.idx];
      if (!el) return;
      el.classList.add('cur');
      /* 键盘上把"下一个要按的键"标出来，跟键位闯关保持一致 */
      if (st.showKb && TY.kb) TY.kb.mark(G.text[G.idx]);
      followCursor(el);
    }

    /* 光标跟随：让当前字符始终落在文本区第二行附近 */
    function followCursor(el) {
      var h = box.clientHeight;
      var y = el.offsetTop;
      var target = y - h * 0.34;
      if (target < 0) target = 0;
      inner.style.transform = 'translateY(' + (-target) + 'px)';
    }

    /* ---------------- 开始 ---------------- */
    var cdTimer = null;
    document.getElementById('sp-go').onclick = function () {
      var btn = this;
      btn.disabled = true;
      var ready = document.getElementById('sp-ready');
      var n = 3;
      btn.textContent = '准备…';
      cdTimer = setInterval(function () {
        n--;
        if (n > 0) {
          btn.textContent = n + ' 秒';
        } else {
          clearInterval(cdTimer);
          ready.classList.add('hidden');
          startRun();
        }
      }, 700);
    };
    TY.onCleanup(function () { if (cdTimer) clearInterval(cdTimer); });

    function startRun() {
      G.running = true; G.done = false;
      G.correct = 0; G.wrong = 0; G.idx = 0;
      G.t0 = 0;
      TY.track.reset();
      newText();
      document.getElementById('sp-cpm').textContent = '0';
      document.getElementById('sp-acc').textContent = '100%';
      document.getElementById('sp-wpm').textContent = '0';
      document.getElementById('sp-time').textContent = fmtSec(st.sec);
      document.getElementById('sp-bar').style.width = '0%';
      document.getElementById('sp-count').textContent = '0 / ' + G.text.length;
      box.focus();
      TY.setBeat({ mode: 'speed', modeName: '速度练习', progress: 0, cpm: 0, acc: 1, keys: 0 });
    }

    /* ---------------- 主循环 ---------------- */
    function tick() {
      if (!G.running || !G.t0) return;
      var used = Date.now() - G.t0;
      var leftMs = Math.max(0, G.limit - used);
      document.getElementById('sp-time').textContent = fmtSec(Math.ceil(leftMs / 1000));
      var bar = document.getElementById('sp-bar');
      bar.style.width = Math.min(100, used / G.limit * 100) + '%';
      if (leftMs <= 0) finish();
    }

    function repaintMetrics() {
      if (!G.t0) return;
      var min = Math.max(0.02, (Date.now() - G.t0) / 60000);
      var cpm = Math.round(G.correct / min);
      var total = G.correct + G.wrong;
      var acc = total > 0 ? G.correct / total : 1;
      document.getElementById('sp-cpm').textContent = cpm;
      document.getElementById('sp-wpm').textContent = Math.round(cpm / 5);
      var accEl = document.getElementById('sp-acc');
      accEl.textContent = Math.round(acc * 100) + '%';
      accEl.style.color = acc >= TY.S.accGate ? 'var(--green)' : 'var(--red)';
      document.getElementById('sp-count').textContent = G.correct + ' / ' + G.text.length;
      TY.setBeat({
        progress: Math.min(1, (Date.now() - G.t0) / G.limit),
        cpm: cpm, acc: acc, keys: TY.track.keys, status: '计时中'
      });
    }

    /* ---------------- 击键 ---------------- */
    TY.onKey(function (key, e) {
      if (!G.running || G.done) return;
      if (key === 'Backspace') { if (e) e.preventDefault(); return; }
      if (key.length !== 1) return;
      if (!G.t0) {
        G.t0 = Date.now();
        G.timer = setInterval(function () { tick(); if (G.running) repaintMetrics(); }, 200);
        TY.onCleanup(function () { clearInterval(G.timer); });
      }

      var want = G.text[G.idx];
      if (want === undefined) { finish(); return; }

      if (key === want) {
        var el = G.spans[G.idx];
        el.classList.remove('bad', 'cur');
        el.classList.add('ok');
        G.correct++;
        G.idx++;
        TY.track.ok(want);
        if (st.showKb) TY.kb.flash(want, 'hit');
        paintCur();
        repaintMetrics();
        if (G.idx >= G.text.length) finish();
      } else {
        /* 严格模式：不前进，只标红 + 计错误 */
        G.wrong++;
        TY.track.err(want, key);
        var cur = G.spans[G.idx];
        if (cur) {
          cur.classList.add('bad');
          setTimeout(function () {
            if (cur && !cur.classList.contains('ok')) {
              cur.classList.remove('bad');
              if (G.spans[G.idx] === cur) cur.classList.add('cur');
            }
          }, 260);
        }
        if (st.showKb) TY.kb.flash(want, 'miss');
        repaintMetrics();
      }
    });

    /* ---------------- 结算 ---------------- */
    function finish() {
      if (G.done) return;
      G.done = true; G.running = false;
      clearInterval(G.timer);
      var sec = G.t0 ? Math.max(1, (Date.now() - G.t0) / 1000) : st.sec;
      var total = G.correct + G.wrong;
      var acc = total > 0 ? G.correct / total : 0;

      document.getElementById('sp-ready').classList.remove('hidden');
      document.getElementById('sp-ready').innerHTML =
        '<h3>正在汇总成绩…</h3><p>请稍候</p>';

      TY.submit({
        mode: 'speed', level: st.level,
        correct: G.correct, wrong: G.wrong, sec: sec,
        keys: TY.track.dump()
      }).then(function (r) {
        var ok = r && r.ok;
        var rec = ok ? r.record : null;
        var lvName = LEVELS.find(function (l) { return l.k === st.level; }).name;

        document.getElementById('sp-ready').classList.add('hidden');

        TY.showResult({
          badge: rec && rec.unified ? '统一测评成绩' : '速度练习成绩',
          title: lvName + ' · ' + (st.sec >= 60 ? Math.round(st.sec / 60) + ' 分钟' : st.sec + ' 秒'),
          score: rec ? rec.score : '—',
          cpm: rec ? rec.cpm : Math.round(G.correct / Math.max(0.02, sec / 60)),
          acc: Math.round(acc * 100) + '%',
          cw: G.correct + ' / ' + G.wrong,
          rank: r && r.rank,
          good: rec ? rec.qualified : acc >= TY.S.accGate,
          note: !ok
            ? '教师机暂时连不上，成绩没有上传。请举手告诉老师。'
            : (rec.qualified
              ? '已计入排行榜，当前班级第 ' + (r.rank || '—') + ' 名。' +
                (acc < 0.95 ? '下一步：准确率提到 95% 以上，速度自然会再涨。' : '又准又快，保持！')
              : '准确率 ' + Math.round(acc * 100) + '% 低于 ' + TY.accPct() +
                '%，这次不计入排行榜。先慢下来打准，再追求快。'),
          onAgain: function () { resetRun(); },
          againText: '再来一次',
          onDone: function () { if (window.APP) APP.go('hall'); }
        });
      });
    }

    function resetRun() {
      G.running = false; G.done = false;
      clearInterval(G.timer);
      newText();
      document.getElementById('sp-cpm').textContent = '0';
      document.getElementById('sp-acc').textContent = '100%';
      document.getElementById('sp-wpm').textContent = '0';
      document.getElementById('sp-bar').style.width = '0%';
      document.getElementById('sp-time').textContent = fmtSec(st.sec);
      var ready = document.getElementById('sp-ready');
      ready.classList.remove('hidden');
      ready.innerHTML = '<h3>再来一次</h3><p>计时从你按下第一个键起算。</p>' +
        '<button class="btn-blue" id="sp-go2">开始练习</button>';
      document.getElementById('sp-go2').onclick = function () {
        ready.classList.add('hidden');
        startRun();
      };
    }

    /* ---------------- 参数切换 ---------------- */
    function bindSegs() {
      Array.prototype.forEach.call(document.querySelectorAll('#sp-segs button'), function (b) {
        b.disabled = !!uni;
        if (b.disabled) b.style.opacity = '.42';
        b.onclick = function () {
          if (uni) return;
          Array.prototype.forEach.call(document.querySelectorAll('#sp-segs button'), function (x) { x.classList.remove('on'); });
          b.classList.add('on');
          st.sec = parseInt(b.getAttribute('data-sec'), 10);
          G.limit = st.sec * 1000;
          document.getElementById('sp-time').textContent = fmtSec(st.sec);
          resetRun();
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('#sp-lvs button'), function (b) {
        b.disabled = !!uni;
        if (b.disabled) b.style.opacity = '.42';
        b.onclick = function () {
          if (uni) return;
          Array.prototype.forEach.call(document.querySelectorAll('#sp-lvs button'), function (x) { x.classList.remove('on'); });
          b.classList.add('on');
          st.level = b.getAttribute('data-lv');
          resetRun();
        };
      });
      document.getElementById('sp-kb-toggle').onclick = function () {
        st.showKb = !st.showKb;
        this.textContent = st.showKb ? '隐藏键盘' : '显示键盘';
        kbBox.classList.toggle('hidden', !st.showKb);
        if (st.showKb && !kbBox.children.length) TY.kb.build(kbBox);
      };
    }
    bindSegs();

    newText();
    document.getElementById('sp-count').textContent = '0 / ' + G.text.length;
    TY.onCleanup(function () { clearInterval(G.timer); });
  };

  function fmtSec(s) {
    s = Math.max(0, Math.round(s));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

})();
