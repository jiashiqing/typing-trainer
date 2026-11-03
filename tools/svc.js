/* ==========================================================================
 * 服务状态查询 / 停止（配合「查看服务状态.bat」「停止服务.bat」）
 * --------------------------------------------------------------------------
 * 用法：
 *   node tools/svc.js status   查这个系统现在跑没跑、跑在哪、几个人在线
 *   node tools/svc.js stop     停掉（先走本机 /api/shutdown 优雅关库，失败再强杀）
 *
 * 为什么不用 taskkill 直接用 PID：端口号可能因为 8090 被占而顺延到 8091，
 * 而且强杀会让 SQLite 留下 -wal 半截事务。所以先扫端口找到"确实是本系统"的实例。
 * ========================================================================== */
'use strict';

const http = require('http');
const os = require('os');
const { execFileSync } = require('child_process');

const SCAN_FROM = 8090;
const SCAN_TO = 8110;
const LINE = '='.repeat(60);

/* ---------------- 基础动作 ---------------- */

function ping(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 700 }, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => {
        try {
          const j = JSON.parse(b);
          resolve(j && j.app === 'typing-trainer' ? j : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function scan() {
  const hits = [];
  for (let p = SCAN_FROM; p <= SCAN_TO; p++) {
    const j = await ping(p);
    if (j) hits.push(Object.assign({ port: p }, j));
  }
  return hits;
}

/* 挑一个学生真能连上的地址：跳过 VMware / VirtualBox / Hyper-V / WSL 这类虚拟网卡，
 * 优先 192.168 段（机房最常见），其次 10. / 172.16-31。 */
function lanIp() {
  const nets = os.networkInterfaces();
  const virt = /vmware|virtualbox|vethernet|hyper-?v|wsl|docker|loopback|tap|tun|zerotier|tailscale|bluetooth/i;
  const cand = [];
  for (const k of Object.keys(nets)) {
    for (const n of nets[k] || []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      cand.push({ name: k, ip: n.address, isVirt: virt.test(k) });
    }
  }
  const real = cand.filter(c => !c.isVirt);
  const pick = real.length ? real : cand;
  const priv = pick.find(c => /^192\.168\./.test(c.ip)) ||
    pick.find(c => /^10\./.test(c.ip)) ||
    pick.find(c => /^172\.(1[6-9]|2\d|3[01])\./.test(c.ip));
  return (priv || pick[0] || {}).ip || '';
}

function dur(ms) {
  if (!ms || ms < 0) return '未知';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚启动';
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  return h + ' 小时 ' + (m % 60) + ' 分钟';
}

function askShutdown(port) {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', timeout: 3000,
      headers: { 'Content-Length': 0 }
    }, r => {
      r.resume();
      r.on('end', () => resolve(r.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function forceKill(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 交互提问放在 node 里做 —— bat 里凡有中文行都会被 cmd 按字节截断
 * （chcp 65001 下 UTF-8 中文行的老毛病），所以 bat 只留 ASCII。 */
function ask(q) {
  return new Promise(resolve => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const finish = v => { if (done) return; done = true; try { rl.close(); } catch (e) { } resolve(v); };
    rl.question(q, a => finish(a));
    rl.on('close', () => finish(''));
  });
}

/* ---------------- status ---------------- */

async function cmdStatus() {
  const hits = await scan();
  console.log(LINE);
  console.log('  打字练习系统 · 运行状态');
  console.log(LINE);
  console.log('');

  if (!hits.length) {
    console.log('  没有检测到正在运行的实例（已扫描 ' + SCAN_FROM + '—' + SCAN_TO + ' 端口）。');
    console.log('');
    console.log('  启动：双击 start.bat');
    console.log('');
    return 0;
  }

  const ip = lanIp();
  console.log('  找到 ' + hits.length + ' 个正在运行的实例：');
  console.log('');

  hits.forEach((h, i) => {
    console.log('  ' + (i + 1) + ') 端口 ' + h.port + '　进程号 ' + h.pid +
      '　已运行 ' + dur(Date.now() - (h.startedAt || 0)) +
      '　当前在线 ' + (h.online || 0) + ' 人');
    console.log('     本机打开： http://localhost:' + h.port);
    console.log('     教师端：   http://localhost:' + h.port + '/teacher');
    console.log('     大屏看板： http://localhost:' + h.port + '/screen');
    if (ip) console.log('     学生用：   http://' + ip + ':' + h.port);
    console.log('');
  });

  if (hits.length > 1) {
    console.log('  ⚠ 同时开着 ' + hits.length + ' 个实例：各存各的成绩，名单和排行榜会对不上。');
    console.log('    双击「停止服务.bat」会把它们全部停掉，然后重新双击 start.bat 只留一个。');
    console.log('');
  }

  console.log('  停止：双击「停止服务.bat」，或关掉那个黑色命令行窗口。');
  console.log('');
  return 0;
}

/* ---------------- stop ---------------- */

async function cmdStop() {
  const hits = await scan();
  console.log(LINE);
  console.log('  停止打字练习系统');
  console.log(LINE);
  console.log('');

  if (!hits.length) {
    console.log('  没有正在运行的实例 —— 不用停。');
    console.log('');
    return 0;
  }

  console.log('  停止前请确认：这一节课已经结束。');
  console.log('  停止时会先保存成绩再退出，不会丢数据。');
  console.log('');
  const ans = await ask('  确定停止吗？输入 Y 后回车（直接回车 = 取消）: ');
  if (String(ans).trim().toUpperCase() !== 'Y') {
    console.log('');
    console.log('  已取消，什么都没做。');
    console.log('');
    return 0;
  }
  console.log('');

  let okCount = 0;
  for (const h of hits) {
    process.stdout.write('  端口 ' + h.port + '（进程 ' + h.pid + '）：正在停止 ... ');
    const acked = await askShutdown(h.port);

    /* 等服务真正退出：最多等 3 秒 */
    let gone = false;
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      if (!(await ping(h.port))) { gone = true; break; }
    }

    if (!gone && acked) {
      /* 应答了但还在——再给一点时间 */
      for (let i = 0; i < 6; i++) {
        await sleep(400);
        if (!(await ping(h.port))) { gone = true; break; }
      }
    }

    if (gone) {
      console.log('已停止 ✓');
      okCount++;
    } else if (!acked) {
      /* 老版本没有 /api/shutdown，或者响应堵住了 */
      process.stdout.write('没有响应停止指令，改为强制结束进程 ... ');
      const killed = forceKill(h.pid);
      let gone2 = false;
      for (let i = 0; i < 10; i++) {
        await sleep(300);
        if (!(await ping(h.port))) { gone2 = true; break; }
      }
      if (gone2) { console.log('已停止 ✓'); okCount++; }
      else console.log(killed ? '失败（进程可能以管理员权限运行，请用管理员身份重试）' : '失败');
    } else {
      console.log('仍未停止（可能正在写数据库，稍等几秒再试一次）');
    }
  }

  console.log('');
  if (okCount === hits.length) {
    console.log('  全部停止完成，数据已安全保存。');
    console.log('  需要再用时，双击 start.bat 即可。');
  } else {
    console.log('  ' + (hits.length - okCount) + ' 个实例没停掉，可以打开任务管理器结束 node.exe。');
  }
  console.log('');
  return okCount === hits.length ? 0 : 1;
}

/* ---------------- 入口 ---------------- */

(async () => {
  const cmd = (process.argv[2] || 'status').toLowerCase();
  let code = 0;
  if (cmd === 'status') code = await cmdStatus();
  else if (cmd === 'stop') code = await cmdStop();
  else {
    console.log('用法：node tools/svc.js status | stop');
    code = 2;
  }
  /* 给 .bat 用的收尾提示（bat 里不能写中文，只能由 node 打印） */
  if (process.argv.indexOf('--wait') >= 0) console.log('  按任意键关闭这个窗口 ...');
  process.exit(code);
})().catch(e => {
  console.error('出错：' + (e && e.message ? e.message : e));
  process.exit(1);
});
