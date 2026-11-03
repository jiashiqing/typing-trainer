/* ==========================================================================
 * 单词冲刺（wordrush.js）
 * --------------------------------------------------------------------------
 * 60 秒内尽可能多地打对英文单词。打完整词自动换下一个，打错不前进。
 * 词库三级，按学段选。核心指标：打对词数 / 准确率 / 平均每词耗时。
 * ========================================================================== */
(function () {
  'use strict';

  var TY = window.TY, D = window.TDATA;
  var WR = window.WR = {};

  var DURATION = 60;

  WR.render = function (body, opts) {
    opts = opts || {};
    var st = { tier: opts.tier || 2 };

    body.innerHTML =
      '<div class="wr-wrap">' +
        '<div class="wr-top">' +
          '<div class="seg" id="wr-tiers">' +
            [1, 2, 3].map(function (t) {
              return '<button data-t="' + t + '"' + (t === st.tier ? ' class="on"' : '') + '>' +
                D.RUSH[t].name + '</button>';
            }).join('') +
          '</div>' +
          '<div class="wr-clock"><b id="wr-clock-n">' + DURATION + '</b><i>秒</i></div>' +
          '<div class="wr-stats">' +
            '<div class="wr-stat"><b id="wr-words">0</b><span>打对词数</span></div>' +
            '<div class="wr-stat"><b id="wr-acc">100%</b><span>准确率</span></div>' +
          '</div>' +
        '</div>' +

        '<div class="wr-stage">' +
          '<div class="wr-word" id="wr-word">—</div>' +
          '<div class="wr-next" id="wr-next">下一个：</div>' +
          '<div class="wr-stats" style="margin-top:26px">' +
            '<div class="wr-stat"><b id="wr-chars">0</b><span>打对字符</span></div>' +
            '<div class="wr-stat"><b id="wr-avg">·</b><span>平均每词(秒)</span></div>' +
            '<div class="wr-stat"><b id="wr-fast">·</b><span>最快一词(秒)</span></div>' +
          '</div>' +
          '<div id="wr-ready" style="margin-top:22px">' +
            '<p style="font-size:13.5px;color:var(--ink3);margin:0 0 16px">' +
              '60 秒，看你能打对多少个单词。打完整词自动换下一个，打错不前进。</p>' +
            '<button class="btn-blue" id="wr-go">开始挑战</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var G = {
      running: false, done: false,
      word: '', idx: 0, words: 0, correct: 0, wrong: 0,
      t0: 0, wordStart: 0, wordTimes: [],
      timer: 0, raf: 0
    };

    /* ---------------- 取词 ---------------- */
    function nextWord() {
      var list = D.RUSH[st.tier].list;
      var w = D.pick(list);
      var guard = 0;
      while (w === G.word && guard++ < 10) w = D.pick(list);
      G.word = w;
      G.idx = 0;
      G.wordStart = Date.now();
      paintWord();
    }

    function paintWord() {
      var box = document.getElementById('wr-word');
      var html = '';
      for (var i = 0; i < G.word.length; i++) {
        var cls = 'ch';
        if (i < G.idx) cls += ' ok';
        else if (i === G.idx) cls += ' cur';
        html += '<span class="' + cls + '">' + TY.esc(G.word[i]) + '</span>';
      }
      box.innerHTML = html;

      var list = D.RUSH[st.tier].list;
      document.getElementById('wr-next').textContent =
        '下一个：' + list[(list.indexOf(G.word) + 1) % list.length];
    }

    /* ---------------- 开始 ---------------- */
    function start() {
      G.running = true; G.done = false;
      G.words = 0; G.correct = 0; G.wrong = 0;
      G.wordTimes = []; G.word = '';
      G.t0 = Date.now();
      TY.track.reset();
      document.getElementById('wr-ready').classList.add('hidden');
      document.querySelector('.wr-clock').classList.remove('warn');
      document.getElementById('wr-clock-n').textContent = DURATION;
      document.getElementById('wr-words').textContent = '0';
      document.getElementById('wr-acc').textContent = '100%';
      document.getElementById('wr-chars').textContent = '0';
      document.getElementById('wr-avg').textContent = '—';
      document.getElementById('wr-fast').textContent = '—';
      nextWord();
      TY.setBeat({ mode: 'wordrush', modeName: '单词冲刺', progress: 0, status: '挑战中' });

      clearInterval(G.timer);
      G.timer = setInterval(function () {
        var left = Math.max(0, DURATION - Math.floor((Date.now() - G.t0) / 1000));
        var el = document.getElementById('wr-clock-n');
        if (el.textContent !== String(left)) el.textContent = left;
        document.querySelector('.wr-clock').classList.toggle('warn', left <= 10);
        TY.setBeat({
          progress: Math.min(1, (Date.now() - G.t0) / (DURATION * 1000)),
          cpm: Math.round(G.correct / Math.max(0.05, (Date.now() - G.t0) / 60000)),
          keys: TY.track.keys, status: '挑战中'
        });
        if (left <= 0) finish();
      }, 200);
    }

    /* ---------------- 击键 ---------------- */
    TY.onKey(function (key, e) {
      if (!G.running || G.done) return;
      if (key === 'Backspace') { if (e) e.preventDefault(); return; }
      /* 空格/回车是误触，不算打错 */
      if (key === ' ' || key === 'Enter' || key === 'Tab') { if (e) e.preventDefault(); return; }
      if (key.length !== 1) return;
      var want = G.word[G.idx];

      if (key === want) {
        G.correct++;
        G.idx++;
        TY.track.ok(want);
        paintWord();
        document.getElementById('wr-chars').textContent = G.correct;

        if (G.idx >= G.word.length) {
          /* 一个词打完 */
          var used = (Date.now() - G.wordStart) / 1000;
          G.wordTimes.push(used);
          G.words++;
          document.getElementById('wr-words').textContent = G.words;
          var sum = G.wordTimes.reduce(function (a, b) { return a + b; }, 0);
          document.getElementById('wr-avg').textContent = (sum / G.wordTimes.length).toFixed(1);
          document.getElementById('wr-fast').textContent = Math.min.apply(null, G.wordTimes).toFixed(1);
          nextWord();
        }
      } else {
        G.wrong++;
        TY.track.err(want, key);
        var cur = document.querySelector('#wr-word .ch.cur');
        if (cur) {
          cur.classList.add('bad');
          setTimeout(function () { cur.classList.remove('bad'); }, 200);
        }
      }

      var total = G.correct + G.wrong;
      var accEl = document.getElementById('wr-acc');
      accEl.textContent = Math.round((total > 0 ? G.correct / total : 1) * 100) + '%';
    });

    /* ---------------- 结算 ---------------- */
    function finish() {
      if (G.done) return;
      G.done = true; G.running = false;
      clearInterval(G.timer);
      var sec = Math.min(DURATION, Math.max(1, (Date.now() - G.t0) / 1000));
      var total = G.correct + G.wrong;
      var acc = total > 0 ? G.correct / total : 0;

      document.getElementById('wr-ready').classList.remove('hidden');
      document.getElementById('wr-ready').innerHTML =
        '<p style="font-size:13.5px;color:var(--ink3);margin:0 0 16px">正在汇总成绩…</p>';

      TY.submit({
        mode: 'wordrush', level: String(st.tier),
        correct: G.correct, wrong: G.wrong, sec: sec,
        keys: TY.track.dump()
      }).then(function (r) {
        var ok = r && r.ok;
        var rec = ok ? r.record : null;
        document.getElementById('wr-ready').classList.add('hidden');

        TY.showResult({
          badge: '单词冲刺 · ' + D.RUSH[st.tier].name,
          title: '60 秒 · 打对 ' + G.words + ' 个词',
          score: rec ? rec.score : '—',
          cpm: rec ? rec.cpm : Math.round(G.correct / (sec / 60)),
          acc: Math.round(acc * 100) + '%',
          cw: G.correct + ' / ' + G.wrong,
          rank: r && r.rank,
          good: rec ? rec.qualified : acc >= TY.S.accGate,
          note: !ok
            ? '教师机暂时连不上，成绩没有上传。'
            : (rec.qualified
              ? '打对 ' + G.words + ' 个词，班级第 ' + (r.rank || '—') + ' 名。' +
                (G.words >= 12 ? '速度很好，可以挑战下一级词库了。' : '再练几次，词会越打越顺。')
              : '准确率 ' + Math.round(acc * 100) + '% 低于 ' + TY.accPct() + '%，这次不计入排行榜。'),
          onAgain: function () { start(); },
          againText: '再来一次',
          onDone: function () { if (window.APP) APP.go('hall'); }
        });
      });
    }

    /* ---------------- 词库切换 ---------------- */
    Array.prototype.forEach.call(document.querySelectorAll('#wr-tiers button'), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call(document.querySelectorAll('#wr-tiers button'), function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        st.tier = parseInt(b.getAttribute('data-t'), 10);
        G.word = '';
        if (!G.running) { paintWord(); }
      };
    });

    document.getElementById('wr-go').onclick = start;

    G.word = '';
    paintWord();
    TY.onCleanup(function () { clearInterval(G.timer); });
  };

})();
