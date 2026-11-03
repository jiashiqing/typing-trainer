/* ==========================================================================
 * 落字游戏（falling.js）
 * --------------------------------------------------------------------------
 * 字母从顶部下落，按对应键击落。3 条命，90 秒，每 45 秒提速一波。
 * 这个模式的核心教学数据不是得分，而是「平均反应时间」—— 手跟不跟得上眼。
 * 用 canvas 绘制，不依赖任何库。
 * ========================================================================== */
(function () {
  'use strict';

  var TY = window.TY, D = window.TDATA;
  var LG = window.LG = {};

  var DURATION = 90;      // 单局秒数
  var LIVES = 3;
  var LANES = 6;

  LG.render = function (body) {
    body.innerHTML =
      '<div class="fg-wrap" id="fg-wrap">' +
        '<canvas id="fg-canvas"></canvas>' +
        '<div class="fg-hud">' +
          '<div class="fg-hud-l">' +
            '<div class="fg-stat"><b id="fg-score">0</b><span>得分</span></div>' +
            '<div class="fg-stat"><b id="fg-combo">0</b><span>连击</span></div>' +
          '</div>' +
          '<div class="fg-hud-r">' +
            '<div class="fg-stat"><b id="fg-time">' + DURATION + '</b><span>秒</span></div>' +
            '<div class="fg-hearts" id="fg-hearts"></div>' +
          '</div>' +
        '</div>' +
        '<div class="fg-combo" id="fg-combo-pop"></div>' +
        '<div class="fg-overlay" id="fg-overlay">' +
          '<h3>字母掉下来了，按键把它打掉</h3>' +
          '<p>按对键 → 字母消失、得分。字母落到底 → 掉一条命。<br>' +
          '共 3 条命，90 秒。越到后面掉得越快。</p>' +
          '<button class="btn-blue" id="fg-start">开始游戏</button>' +
        '</div>' +
      '</div>';

    var wrap = document.getElementById('fg-wrap');
    var canvas = document.getElementById('fg-canvas');
    var ctx = canvas.getContext('2d');
    var W = 0, H = 0, dpr = 1;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      var r = wrap.getBoundingClientRect();
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);
    TY.onCleanup(function () { window.removeEventListener('resize', resize); });

    /* ---------------- 游戏状态 ---------------- */
    var G = {
      running: false, over: false,
      blocks: [], parts: [],
      score: 0, combo: 0, maxCombo: 0,
      lives: LIVES,
      hits: 0, missKeys: 0, leaks: 0,
      reactSum: 0, reactN: 0,
      startAt: 0, spawnTimer: 0, spawnGap: 1150,
      speedMul: 1, wave: 0,
      raf: 0, lastT: 0
    };

    function paintHearts() {
      var box = document.getElementById('fg-hearts');
      var html = '';
      for (var i = 0; i < LIVES; i++) {
        html += '<svg class="fg-heart' + (i < G.lives ? '' : ' off') + '" viewBox="0 0 24 24" fill="currentColor">' +
          '<path d="M12 21s-8-4.9-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 3.5C20 16.1 12 21 12 21z"/></svg>';
      }
      box.innerHTML = html;
    }
    paintHearts();

    function reset() {
      G.running = true; G.over = false;
      G.blocks = []; G.parts = [];
      G.score = 0; G.combo = 0; G.maxCombo = 0; G.lives = LIVES;
      G.hits = 0; G.missKeys = 0; G.leaks = 0;
      G.reactSum = 0; G.reactN = 0;
      G.spawnTimer = 0; G.spawnGap = 1000; G.speedMul = 1; G.wave = 0;
      G.startAt = performance.now(); G.lastT = G.startAt;
      /* 开局先放两个，别让学生对着空屏幕等 */
      spawn(); spawn();
      paintHearts();
      document.getElementById('fg-score').textContent = '0';
      document.getElementById('fg-combo').textContent = '0';
      document.getElementById('fg-time').textContent = DURATION;
      TY.track.reset();
      TY.setBeat({ mode: 'falling', modeName: '落字游戏', progress: 0, status: '游戏中' });
    }

    /* ---------------- 生成字母 ---------------- */
    var POOL = 'abcdefghijklmnopqrstuvwxyz'.split('');
    var WORD_POOL = ('cat dog sun hat cup pen bed red box map bus car key fly ice '
      + 'tree book fish bird milk hand home park rain game ball').split(' ');

    function spawn() {
      /* 用"车道"分布，避免两个字母叠在一起看不清 */
      var used = {};
      G.blocks.forEach(function (b) { used[b.lane] = 1; });
      var free = [];
      for (var i = 0; i < LANES; i++) if (!used[i]) free.push(i);
      if (!free.length) return;

      var lane = free[Math.floor(Math.random() * free.length)];
      var ch = POOL[Math.floor(Math.random() * POOL.length)];
      var laneW = W / LANES;
      var size = Math.max(46, Math.min(74, laneW * 0.52));
      G.blocks.push({
        ch: ch, lane: lane,
        x: laneW * lane + laneW / 2,
        y: -size,
        vy: (95 + Math.random() * 40) * G.speedMul,
        size: size,
        born: performance.now(),
        wob: Math.random() * Math.PI * 2
      });
    }

    /* ---------------- 特效 ---------------- */
    function burst(x, y, color) {
      for (var i = 0; i < 10; i++) {
        var a = Math.PI * 2 * (i / 10) + Math.random() * 0.5;
        var sp = 90 + Math.random() * 130;
        G.parts.push({
          x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 1, color: color || '#93c5fd'
        });
      }
    }

    /* ---------------- 主循环 ---------------- */
    function loop(t) {
      if (!G.running) return;
      var dt = Math.min(0.05, (t - G.lastT) / 1000);
      G.lastT = t;
      var elapsed = (t - G.startAt) / 1000;

      /* 倒计时 / 时间到 */
      var left = Math.max(0, Math.ceil(DURATION - elapsed));
      var timeEl = document.getElementById('fg-time');
      if (timeEl.textContent !== String(left)) timeEl.textContent = left;
      if (elapsed >= DURATION) { gameOver('时间到'); return; }

      /* 难度爬坡：每 45 秒一波 */
      var wave = Math.floor(elapsed / 45);
      if (wave > G.wave) {
        G.wave = wave;
        G.speedMul *= 1.12;
        G.spawnGap = Math.max(430, G.spawnGap * 0.82);
        TY.toast('第 ' + (wave + 1) + ' 波 · 加速了');
      }

      /* 生成 */
      G.spawnTimer -= dt * 1000;
      var cap = Math.min(3 + G.wave, LANES - 1);
      if (G.spawnTimer <= 0 && G.blocks.length < cap) {
        G.spawnTimer = G.spawnGap;
        spawn();
      }

      /* 移动 */
      for (var i = G.blocks.length - 1; i >= 0; i--) {
        var b = G.blocks[i];
        b.y += b.vy * dt;
        b.wob += dt * 3;
        if (b.y - b.size / 2 > H) {
          G.blocks.splice(i, 1);
          G.leaks++;
          G.lives--;
          G.combo = 0;
          document.getElementById('fg-combo').textContent = '0';
          paintHearts();
          burst(b.x, H - 12, '#f87171');
          if (G.lives <= 0) { gameOver('生命用完了'); return; }
        }
      }

      /* 粒子 */
      for (var p = G.parts.length - 1; p >= 0; p--) {
        var q = G.parts[p];
        q.x += q.vx * dt; q.y += q.vy * dt;
        q.vy += 260 * dt;
        q.life -= dt * 1.9;
        if (q.life <= 0) G.parts.splice(p, 1);
      }

      draw();
      G.raf = requestAnimationFrame(loop);
    }

    /* ---------------- 绘制 ---------------- */
    function draw() {
      ctx.clearRect(0, 0, W, H);

      /* 底部警戒线 */
      var grd = ctx.createLinearGradient(0, H - 70, 0, H);
      grd.addColorStop(0, 'rgba(248,113,113,0)');
      grd.addColorStop(1, 'rgba(248,113,113,.18)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, H - 70, W, 70);
      ctx.strokeStyle = 'rgba(248,113,113,.45)';
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 8]);
      ctx.beginPath(); ctx.moveTo(0, H - 4); ctx.lineTo(W, H - 4); ctx.stroke();
      ctx.setLineDash([]);

      /* 下落字母 */
      for (var i = 0; i < G.blocks.length; i++) {
        var b = G.blocks[i];
        var s = b.size;
        var x = b.x + Math.sin(b.wob) * 4;
        var y = b.y;

        ctx.save();
        ctx.shadowColor = 'rgba(96,165,250,.55)';
        ctx.shadowBlur = 16;
        ctx.fillStyle = 'rgba(255,255,255,.13)';
        roundRect(x - s / 2, y - s / 2, s, s, 11);
        ctx.fill();
        ctx.restore();

        ctx.strokeStyle = 'rgba(147,197,253,.62)';
        ctx.lineWidth = 1.6;
        roundRect(x - s / 2, y - s / 2, s, s, 11);
        ctx.stroke();

        ctx.fillStyle = '#f1f7ff';
        ctx.font = '700 ' + Math.round(s * 0.52) + 'px "SF Mono",Consolas,monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.ch, x, y + 1);
      }

      /* 粒子 */
      for (var p = 0; p < G.parts.length; p++) {
        var q = G.parts[p];
        ctx.globalAlpha = Math.max(0, q.life);
        ctx.fillStyle = q.color;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 2.6 * q.life + 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    /* ---------------- 敲键 ---------------- */
    TY.onKey(function (key, e) {
      if (!G.running) return;
      /* 空格/回车是误触，别记成"打错"，否则手速数据会脏 */
      if (key === ' ' || key === 'Enter' || key === 'Tab') { if (e) e.preventDefault(); return; }
      if (key.length !== 1) return;
      var ch = key.toLowerCase();

      /* 找最低（最危险）的那个匹配字母 */
      var target = -1, lowest = -1;
      for (var i = 0; i < G.blocks.length; i++) {
        if (G.blocks[i].ch === ch && G.blocks[i].y > lowest) {
          lowest = G.blocks[i].y; target = i;
        }
      }

      if (target >= 0) {
        var b = G.blocks[target];
        var react = performance.now() - b.born;
        G.reactSum += react; G.reactN++;
        G.blocks.splice(target, 1);
        G.hits++;
        G.combo++;
        if (G.combo > G.maxCombo) G.maxCombo = G.combo;
        G.score += 10 + Math.min(20, Math.floor(G.combo / 5) * 2);
        TY.track.ok(ch);
        burst(b.x, b.y, '#7dd3fc');

        document.getElementById('fg-score').textContent = G.score;
        document.getElementById('fg-combo').textContent = G.combo;

        if (G.combo > 0 && G.combo % 5 === 0) {
          var pop = document.getElementById('fg-combo-pop');
          pop.textContent = G.combo + ' 连击';
          pop.classList.remove('show');
          void pop.offsetWidth;
          pop.classList.add('show');
        }
        TY.setBeat({
          progress: Math.min(1, elapsedRatio()), status: '游戏中',
          cpm: Math.round(G.hits / Math.max(1, (performance.now() - G.startAt) / 60000))
        });
      } else {
        /* 按错键：不扣命，但连击清零 */
        G.missKeys++;
        G.combo = 0;
        document.getElementById('fg-combo').textContent = '0';
        TY.track.err('-', ch);
      }
    });

    function elapsedRatio() {
      return Math.min(1, (performance.now() - G.startAt) / (DURATION * 1000));
    }

    /* ---------------- 结束 ---------------- */
    function gameOver(reason) {
      if (G.over) return;
      G.over = true;
      G.running = false;
      cancelAnimationFrame(G.raf);
      var sec = Math.max(1, (performance.now() - G.startAt) / 1000);
      var totalKeys = G.hits + G.missKeys;
      var acc = totalKeys > 0 ? G.hits / totalKeys : 1;
      var avgReact = G.reactN > 0 ? Math.round(G.reactSum / G.reactN) : 0;

      var ov = document.getElementById('fg-overlay');
      ov.innerHTML =
        '<h3>' + reason + '</h3>' +
        '<div class="fg-big">' + G.score + '</div>' +
        '<p>击落 ' + G.hits + ' 个 · 最高连击 ' + G.maxCombo + ' · 平均反应 ' +
        (avgReact ? avgReact + ' 毫秒' : '—') + '</p>' +
        '<button class="btn-blue" id="fg-start2">再玩一局</button>';
      document.getElementById('fg-start2').onclick = start;

      TY.submit({
        mode: 'falling', level: '1',
        correct: G.hits, wrong: G.missKeys,
        sec: Math.min(sec, DURATION),
        keys: TY.track.dump(),
        reactionMs: avgReact, maxStreak: G.maxCombo, gameScore: G.score
      }).then(function (r) {
        var note = !r || !r.ok
          ? '这台电脑暂时连不上教师机，本局成绩没有上传。'
          : '得分 ' + G.score + ' · 平均反应 ' + (avgReact || '—') + ' 毫秒。' +
          (avgReact && avgReact < 700 ? '手很快！' : '先看准再按，反应会更稳。');
        TY.showResult({
          badge: '落字游戏',
          title: reason + ' · 击落 ' + G.hits + ' 个',
          score: G.score,
          cpm: '—',
          acc: Math.round(acc * 100) + '%',
          cw: G.hits + ' / ' + G.missKeys,
          rank: null,
          good: avgReact > 0 && avgReact < 900,
          note: note + '（游戏得分不进总分榜，只进手速榜）',
          onAgain: start,
          againText: '再玩一局',
          onDone: function () { if (window.APP) APP.go('hall'); }
        });
      });
    }

    /* ---------------- 开一局 ---------------- */
    function start() {
      reset();
      document.getElementById('fg-overlay').classList.add('hidden');
      cancelAnimationFrame(G.raf);
      G.lastT = performance.now();
      G.raf = requestAnimationFrame(loop);
    }

    document.getElementById('fg-start').onclick = start;

    TY.onCleanup(function () {
      G.running = false;
      cancelAnimationFrame(G.raf);
    });
  };

})();
