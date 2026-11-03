/* 榜单合并与名次重算 —— 学生端 / 教师端 / 大屏三端共用
 *
 * 为什么需要这个文件：
 *   服务端每次提交只推「变化的那一行」（几百字节），不再推整份榜单（5,000 人时 2 MB）。
 *   前端把这一行并进本地榜单后，名次会变 —— 所以名次改成前端自己算。
 *
 * 算法必须与服务端 buildBoard 完全一致，改一处就要两边一起改：
 *   1. 主序：总分降序 → CPM 降序 → id 字典序（保证同分同名次稳定，不会每次刷新乱跳）
 *   2. 四个分榜（速度/准确率/反应/中文）各自排名次，只排该项 > 0 的人
 */
(function (g) {
  'use strict';

  function byId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

  function sortByTotal(rows) {
    rows.sort(function (a, b) {
      return (b.total - a.total) || (b.cpm - a.cpm) || byId(a, b);
    });
    return rows;
  }

  /* 与 server.js 的 rankBy 同构：过滤 → 排序（稳定排序保留主序）→ 编号 */
  function rankMap(rows, key, asc) {
    var arr = rows.filter(function (r) { return r[key] != null && r[key] > 0; });
    arr.sort(function (a, b) { return asc ? (a[key] - b[key]) : (b[key] - a[key]); });
    var m = {};
    for (var i = 0; i < arr.length; i++) m[arr[i].id] = i + 1;
    return m;
  }

  function recompute(rows) {
    if (!rows || !rows.length) return rows;
    sortByTotal(rows);
    var rSpeed = rankMap(rows, 'cpm', false),
      rAcc = rankMap(rows, 'acc', false),
      rReact = rankMap(rows, 'reaction', true),
      rZh = rankMap(rows, 'zhCpm', false);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      r.rank = i + 1;
      r.rankSpeed = rSpeed[r.id] || 0;
      r.rankAcc = rAcc[r.id] || 0;
      r.rankReact = rReact[r.id] || 0;
      r.rankZh = rZh[r.id] || 0;
    }
    return rows;
  }

  /**
   * 把服务端推来的一行并进本地榜单。
   * @param {Array} rows 本地榜单（会被就地修改）
   * @param {Object|null} row 变化的那一行；null 表示这次提交没进榜，榜单不用动
   * @returns {boolean} 是否改动过
   */
  function merge(rows, row) {
    if (!rows || !row || !row.id) return false;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id === row.id) {
        rows[i] = row;
        recompute(rows);
        return true;
      }
    }
    rows.push(row);
    recompute(rows);
    return true;
  }

  g.BOARD = { merge: merge, recompute: recompute, sortByTotal: sortByTotal };

  /* ------------------------------------------------------------------
   * 在线列表（进度墙）的增量合并
   *   服务端不再每 6 秒推整张列表（5,000 人时 1.5 MB），改成只推变化的那几条。
   *   排序规则必须和 server.js 的 cmpLive 一致：班级 → 姓名。
   *   全部就地修改（splice），因为外面拿的是同一个数组引用。
   * ------------------------------------------------------------------ */
  function liveCmp(a, b) {
    if ((a.cls || '') !== (b.cls || '')) return String(a.cls).localeCompare(String(b.cls), 'zh');
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
  }

  /* 整表替换（init / reset 快照用） */
  function liveSet(rows, list) {
    if (!rows) return [];
    rows.length = 0;
    (list || []).forEach(function (r) { rows.push(r); });
    rows.sort(liveCmp);
    return rows;
  }

  /* 并入一条（心跳 / 提交成绩用）：有就替换、没有就插进去 */
  function liveMerge(rows, row) {
    if (!rows || !row || !row.id) return false;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id === row.id) {
        rows[i] = row;
        rows.sort(liveCmp);
        return true;
      }
    }
    rows.push(row);
    rows.sort(liveCmp);
    return true;
  }

  /* 批量并入（定时增量的 liveUpd） */
  function liveMergeAll(rows, list) {
    if (!rows || !list || !list.length) return false;
    for (var i = 0; i < list.length; i++) liveMerge(rows, list[i]);
    return true;
  }

  /* 移除下线/过期的人 */
  function liveDrop(rows, ids) {
    if (!rows || !ids || !ids.length) return false;
    var kill = {};
    ids.forEach(function (id) { kill[id] = 1; });
    for (var i = rows.length - 1; i >= 0; i--) {
      if (kill[rows[i].id]) rows.splice(i, 1);
    }
    return true;
  }

  function liveOnline(rows) {
    var n = 0;
    for (var i = 0; i < (rows || []).length; i++) if (rows[i].online) n++;
    return n;
  }

  g.LIVE = {
    set: liveSet, merge: liveMerge, mergeAll: liveMergeAll,
    drop: liveDrop, online: liveOnline
  };
})(typeof window !== 'undefined' ? window : this);
