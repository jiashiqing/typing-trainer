/* ==========================================================================
 * 中文跟打（chinese.js）
 * --------------------------------------------------------------------------
 * 中文没法像英文那样"按一个键判一个字符"——学生打的是拼音，屏幕上出来的是汉字，
 * 中间还隔着输入法候选框。所以中文改用「上屏文字逐字比对」：
 *
 *   · 上方是目标文本，学生用中文输入法在下方输入框里照着打
 *   · 程序取"输入内容与目标的最长公共前缀"= 打对的字数
 *   · 一旦打出的字与目标不一致，就标红并计一次错误，学生必须退格改正才能继续
 *   · 有效速度 = 打对的字数 ÷ 用时（分钟），也就是"字/分钟"
 *   · 准确率 = 打对字数 /(打对字数 + 出错的次数)，与英文模式同一套准确率门槛（服务端 ACC_GATE）
 *
 * 与英文模式的关系：口径相同、单位不同（英文字符/分，中文字/分），
 * 所以在服务端各自成榜，不混在一起排名。
 * ========================================================================== */
(function () {
  'use strict';

  var TY = window.TY, D = window.TDATA;
  var ZH = window.ZH = {};

  /* 统一测评里用 'builtin' 代表"内置语料" */
  function builtinList() {
    return D.ZH_TEXTS.map(function (t) {
      return { id: t.id, title: t.title, level: t.level, body: t.body, builtin: true };
    });
  }

  /* 可选语料 = 内置 + 教师导入（只取中文） */
  function pool() {
    var out = builtinList();
    var ext = (TY.S.materials || []).filter(function (m) { return m.lang !== 'en'; });
    ext.forEach(function (m) {
      out.push({ id: m.id, title: m.title, level: m.level || '2', body: m.body || '', builtin: false });
    });
    return out;
  }

  ZH.render = function (body) {
    var uni = TY.S.unified && TY.S.unified.on && TY.S.unified.mode === 'zh' ? TY.S.unified : null;
    var list = pool();

    var st = {
      sec: uni ? uni.sec : 120,
      matId: uni ? (uni.level === 'builtin' ? '' : uni.level) : '',
      locked: !!uni
    };
    /* 没指定 / 指定了但已被删 → 用第一篇 */
    if (st.matId && !list.some(function (m) { return m.id === st.matId; })) st.matId = '';
    if (!st.matId) st.matId = list[0] ? list[0].id : '';

    body.innerHTML =
      '<div class="zh-wrap">' +
        '<div class="zh-params">' +
          '<span class="sp-p-label">时长</span>' +
          '<div class="seg" id="zh-segs">' +
            [60, 120, 180, 300].map(function (s) {
              return '<button data-sec="' + s + '"' + (s === st.sec ? ' class="on"' : '') + '>' +
                (s / 60) + ' 分钟</button>';
            }).join('') +
          '</div>' +
          '<span class="sp-p-label" style="margin-left:10px">文本</span>' +
          '<select class="mini-sel zh-sel" id="zh-mat">' +
            list.map(function (m) {
              return '<option value="' + m.id + '"' + (m.id === st.matId ? ' selected' : '') + '>' +
                TY.esc(m.title) + (m.builtin ? '' : '（老师导入）') + '</option>';
            }).join('') +
          '</select>' +
          '<div class="sp-spacer"></div>' +
          '<span class="zh-hint">打错的字会变红，按退格删掉再打</span>' +
        '</div>' +

        '<div class="zh-stage">' +
          '<div class="zh-metrics">' +
            '<div class="mt hot"><b id="zh-time">' + fmtSec(st.sec) + '</b><span>剩余时间</span></div>' +
            '<div class="mt"><b id="zh-cpm">0</b><span>字 / 分钟</span></div>' +
            '<div class="mt"><b id="zh-acc">100%</b><span>准确率</span></div>' +
            '<div class="mt"><b id="zh-done">0</b><span>已打对</span></div>' +
          '</div>' +

          '<div class="zh-target" id="zh-target"><div class="zh-target-inner" id="zh-txt"></div></div>' +

          '<div class="zh-input-box">' +
            '<textarea id="zh-input" rows="2" spellcheck="false" autocomplete="off" ' +
              'autocorrect="off" autocapitalize="off" placeholder="在这儿打字（用中文输入法）…"></textarea>' +
            '<div class="zh-count" id="zh-count">0 / 0</div>' +
          '</div>' +

          '<div class="zh-ready" id="zh-ready">' +
            '<h3>' + (uni ? '统一测评 · 中文跟打' : '准备好了吗') + '</h3>' +
            '<p>' + (uni
              ? '本次为全班统一测评：' + (st.sec / 60) + ' 分钟，文本与时长已由老师锁定。'
              : '切到<b>中文输入法</b>，照着上面的文字打。<b>打错的字会变红</b>，按退格删掉重打。') +
            '</p>' +
            '<button class="btn-blue" id="zh-go">开始练习</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var ta = document.getElementById('zh-input');
    var targetBox = document.getElementById('zh-target');
    var txtBox = document.getElementById('zh-txt');

    var G = {
      running: false, done: false, composing: false,
      text: '', spans: [], correct: 0, wrong: 0,
      t0: 0, timer: 0, limit: st.sec * 1000,
      matTitle: ''
    };

    function material() {
      return list.filter(function (m) { return m.id === st.matId; })[0] || list[0];
    }

    /* ---------------- 取文本 ---------------- */
    function newText() {
      var m = material();
      G.matTitle = m ? m.title : '';
      var need = Math.max(80, Math.round(st.sec * 0.9));
      /* 一篇不够长就和其他篇轮换拼（同一篇重复拼接很怪，所以混着接） */
      var others = list.filter(function (x) { return x.id !== (m && m.id); }).concat(m ? [m] : []);
      var src = m ? [m].concat(others) : others;
      G.text = D.zhCorpus(src, need).text;

      G.correct = 0; G.wrong = 0;
      G.spans = [];
      txtBox.innerHTML = '';
      var frag = document.createDocumentFragment();
      for (var i = 0; i < G.text.length; i++) {
        var s = document.createElement('span');
        s.className = 'ch';
        s.textContent = G.text[i];
        frag.appendChild(s);
        G.spans.push(s);
      }
      txtBox.appendChild(frag);
      txtBox.style.transform = 'translateY(0)';
      ta.value = '';
      document.getElementById('zh-count').textContent = '0 / ' + G.text.length;
      paint();
    }

    /* ---------------- 逐字着色 + 光标跟随 ---------------- */
    function paint() {
      var typed = ta.value.length;
      for (var i = 0; i < G.spans.length; i++) {
        var cls = 'ch';
        if (i < G.correct) cls+= ' ok';
        else if (i === G.correct) cls += ' cur';
        if (i >= G.correct && i < typed) cls += ' bad';
        if (G.spans[i].className !== cls) G.spans[i].className = cls;
      }
      var cur = G.spans[G.correct];
      if (cur) {
        var y = cur.offsetTop - targetBox.clientHeight * 0.34;
        if (y < 0) y = 0;
        txtBox.style.transform = 'translateY(' + (-y) + 'px)';
      }
      document.getElementById('zh-count').textContent =
        G.correct + ' / ' + G.text.length;
      document.getElementById('zh-done').textContent = G.correct;
      if (G.correct >= G.text.length && G.text.length) finish();
    }

    function commonPrefix(a, b) {
      var n = Math.min(a.length, b.length);
      var i = 0;
      while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
      return i;
    }

    /* ---------------- 判定 ---------------- */
    function onInput() {
      if (!G.running || G.done) return;
      if (G.composing) return;
      var v = ta.value;
      if (!G.t0 && v.length) startTimer();

      var p = commonPrefix(v, G.text);
      var grew = v.length > G.prevLen;

      /* 新打出来的内容里有和原文不一致的字 → 记一次错误（改成红色，等学生退格） */
      if (grew && p < v.length) {
        G.wrong++;
        flashBad();
      }
      G.correct = p;
      G.prevLen = v.length;
      paint();
      repaintMetrics();
    }

    function flashBad() {
      targetBox.classList.add('warn');
      clearTimeout(G.warnTimer);
      G.warnTimer = setTimeout(function () { targetBox.classList.remove('warn'); }, 320);
    }

    function repaintMetrics() {
      if (!G.t0) return;
      var min = Math.max(0.02, (Date.now() - G.t0) / 60000);
      var cpm = Math.round(G.correct / min);
      var total = G.correct + G.wrong;
      var acc = total > 0 ? G.correct / total : 1;
      document.getElementById('zh-cpm').textContent = cpm;
      var accEl = document.getElementById('zh-acc');
      accEl.textContent = Math.round(acc * 100) + '%';
      accEl.style.color = acc >= TY.S.accGate ? 'var(--green)' : 'var(--red)';
      TY.setBeat({
        mode: 'zh', modeName: '中文跟打',
        progress: G.text.length ? Math.min(1, G.correct / G.text.length) : 0,
        cpm: cpm, acc: acc, keys: 0,
        status: '中文跟打 · 已打对 ' + G.correct + ' 字'
      });
    }

    function startTimer() {
      G.t0 = Date.now();
      G.timer = setInterval(function () {
        if (!G.running) return;
        var left = Math.max(0, G.limit - (Date.now() - G.t0));
        document.getElementById('zh-time').textContent = fmtSec(Math.ceil(left / 1000));
        repaintMetrics();
        if (left <= 0) finish();
      }, 200);
      TY.onCleanup(function () { clearInterval(G.timer); });
    }

    /* ---------------- 事件 ---------------- */
    ta.addEventListener('compositionstart', function () { G.composing = true; });
    ta.addEventListener('compositionend', function () {
      G.composing = false;
      onInput();
    });
    ta.addEventListener('input', function (e) {
      if (G.composing || e.isComposing) return;
      onInput();
    });
    /* 回车会把光标换行，目标文本里没有换行 —— 直接挡掉 */
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') e.preventDefault();
      if (e.key === 'Tab') e.preventDefault();
      if (e.key === 'Backspace' && ta.value.length <= G.correct) e.preventDefault();
    });
    /* 中文最容易被"粘贴整篇"刷分（英文模式逐键判定天然免疫），这里必须拦住 */
    function blockPaste(e) {
      e.preventDefault();
      if (!G.tipTimer) {
        G.tipTimer = setTimeout(function () { G.tipTimer = null; }, 2500);
        TY.toast('练习中不能粘贴，请用输入法自己打');
      }
    }
    ta.addEventListener('paste', blockPaste);
    ta.addEventListener('drop', blockPaste);
    ta.addEventListener('dragover', function (e) { e.preventDefault(); });
    /* 点目标文本区把焦点拉回输入框，避免学生"点了一下就打不出来了" */
    targetBox.addEventListener('click', function () { if (G.running) ta.focus(); });

    /* ---------------- 开始 / 结算 ---------------- */
    document.getElementById('zh-go').onclick = function () {
      var btn = this;
      btn.disabled = true;
      var n = 3;
      btn.textContent = '准备…';
      var cd = setInterval(function () {
        n--;
        if (n > 0) { btn.textContent = n + ' 秒'; return; }
        clearInterval(cd);
        document.getElementById('zh-ready').classList.add('hidden');
        startRun();
      }, 700);
      TY.onCleanup(function () { clearInterval(cd); });
    };

    function startRun() {
      G.running = true; G.done = false; G.composing = false;
      G.limit = st.sec * 1000;
      G.t0 = 0; G.prevLen = 0;
      TY.track.reset();
      newText();
      document.getElementById('zh-cpm').textContent = '0';
      document.getElementById('zh-acc').textContent = '100%';
      document.getElementById('zh-time').textContent = fmtSec(st.sec);
      ta.focus();
      TY.setBeat({
        mode: 'zh', modeName: '中文跟打', progress: 0, cpm: 0, acc: 1, keys: 0,
        status: '中文跟打 · 准备'
      });
    }

    function finish() {
      if (G.done) return;
      G.done = true; G.running = false;
      clearInterval(G.timer);
      ta.blur();

      var sec = G.t0 ? Math.max(1, (Date.now() - G.t0) / 1000) : st.sec;
      var total = G.correct + G.wrong;
      var acc = total > 0 ? G.correct / total : 0;
      var m = material();

      var ready = document.getElementById('zh-ready');
      ready.classList.remove('hidden');
      ready.innerHTML = '<h3>正在汇总成绩…</h3><p>请稍候</p>';

      TY.submit({
        mode: 'zh', level: m ? m.level : '2', material: G.matTitle,
        correct: G.correct, wrong: G.wrong, sec: sec
      }).then(function (r) {
        var ok = r && r.ok;
        var rec = ok ? r.record : null;
        ready.classList.add('hidden');

        TY.showResult({
          badge: rec && rec.unified ? '统一测评成绩' : '中文跟打成绩',
          title: G.matTitle + ' · ' + Math.round(st.sec / 60) + ' 分钟',
          score: rec ? rec.score : '—',
          cpm: rec ? rec.cpm : Math.round(G.correct / Math.max(0.02, sec / 60)),
          cpmLabel: '中文字 / 分钟',
          acc: Math.round(acc * 100) + '%',
          cw: G.correct + ' / ' + G.wrong,
          rank: r && r.rankZh,
          good: rec ? rec.qualified : acc >= TY.S.accGate,
          note: !ok
            ? '教师机暂时连不上，成绩没有上传。请举手告诉老师。'
            : (rec.overCap
              ? '这次速度快得不正常（' + rec.cpm + ' 字/分），成绩已记录但不计入排行榜。请用输入法自己打。'
              : (rec.qualified
                ? '已记入中文榜，本班第 ' + (r.rankZh || '—') + ' 名。' +
                  (acc < 0.95 ? '错字偏多，先求准，再求快。' : '又准又稳，可以试试换更长的时间。')
                : '打对 ' + G.correct + ' 字还没到 20 字，或准确率低于 ' + TY.accPct() +
                  '%，这次不计入排行榜。')),
          onAgain: function () { resetRun(); },
          againText: '再来一篇',
          onDone: function () { if (window.APP) APP.go('hall'); }
        });
      });
    }

    function resetRun() {
      G.running = false; G.done = false;
      clearInterval(G.timer);
      /* 换一篇（内置语料之间轮换；导入的只有一篇时就还是它） */
      var cur = list.map(function (m) { return m.id; }).indexOf(st.matId);
      if (!st.locked && list.length > 1) {
        st.matId = list[(cur + 1) % list.length].id;
        document.getElementById('zh-mat').value = st.matId;
      }
      newText();
      document.getElementById('zh-cpm').textContent = '0';
      document.getElementById('zh-acc').textContent = '100%';
      document.getElementById('zh-time').textContent = fmtSec(st.sec);
      var ready = document.getElementById('zh-ready');
      ready.classList.remove('hidden');
      ready.innerHTML = '<h3>再来一篇</h3><p>切到中文输入法，计时从你打第一个字起算。</p>' +
        '<button class="btn-blue" id="zh-go2">开始练习</button>';
      document.getElementById('zh-go2').onclick = function () {
        ready.classList.add('hidden');
        startRun();
      };
    }

    /* ---------------- 参数切换 ---------------- */
    Array.prototype.forEach.call(document.querySelectorAll('#zh-segs button'), function (b) {
      if (st.locked) { b.disabled = true; b.style.opacity = '.42'; }
      b.onclick = function () {
        if (st.locked) return;
        Array.prototype.forEach.call(document.querySelectorAll('#zh-segs button'), function (x) {
          x.classList.remove('on');
        });
        b.classList.add('on');
        st.sec = parseInt(b.getAttribute('data-sec'), 10);
        G.limit = st.sec * 1000;
        document.getElementById('zh-time').textContent = fmtSec(st.sec);
        resetRun();
      };
    });

    var sel = document.getElementById('zh-mat');
    if (st.locked) { sel.disabled = true; sel.style.opacity = '.55'; }
    sel.onchange = function () {
      st.matId = sel.value;
      resetRun();
    };

    newText();
  };

  function fmtSec(s) {
    s = Math.max(0, Math.round(s));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
})();
