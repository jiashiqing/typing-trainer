/* ==========================================================================
 * 零依赖 Excel 读取（lib/xlsx.js）
 * --------------------------------------------------------------------------
 * 只做一件事：把 .xlsx / .csv 读成二维字符串数组，再归并成「学校 + 班级」。
 *
 * .xlsx 本质是一个 zip 包，里面是几个 xml：
 *   xl/sharedStrings.xml  共享字符串池（单元格 t="s" 时，值是这里的下标）
 *   xl/worksheets/sheet1.xml  单元格数据
 *   xl/workbook.xml       工作表清单（决定哪张是第 1 张）
 * 所以只用内置 zlib 解压 + 正则扫 xml 就够了，不需要装任何第三方包。
 *
 * 对老师填表的"坏习惯"尽量宽容：
 *   · 学校名合并单元格（A2:A5 一个学校带 4 个班）→ 自动向下填充
 *   · 一个单元格里塞多个班（"三年级1班,三年级2班"）→ 自动拆开
 *   · 有表头（"学校 / 班级"）→ 自动跳过
 *   · 学校名空着但班级有值 → 归到上一所学校
 * ========================================================================== */
'use strict';

const zlib = require('zlib');

/* ============================ ZIP 解包 ============================ */

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;

function readZip(buf) {
  /* 从尾部找 EOCD（结尾可能有最长 64KB 的注释，所以往回扫） */
  let eocd = -1;
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（找不到 zip 目录）');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = Object.create(null);

  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== SIG_CEN) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(dataStart, dataStart + compSize);
      try {
        if (method === 0) files[name] = raw;
        else if (method === 8) files[name] = zlib.inflateRawSync(raw);
      } catch (e) { /* 个别文件坏了就跳过，不影响主流程 */ }
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}

/* ============================ XML 小工具 ============================ */

function unxml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/* "AB12" → 列号 27（0 基） */
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const ts = m[1].match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [];
    out.push(ts.map(t => unxml(t.replace(/<[^>]+>/g, ''))).join(''));
  }
  return out;
}

/* ============================ 工作表解析 ============================ */

function parseSheet(xml, shared) {
  const rows = [];
  if (!xml) return rows;

  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm, autoR = 0;
  while ((rm = rowRe.exec(xml))) {
    const attrs = rm[1] || '';
    const body = rm[2] || '';
    const rAttr = /\br="(\d+)"/.exec(attrs);
    const rowIdx = rAttr ? Number(rAttr[1]) - 1 : autoR;
    autoR = rowIdx + 1;

    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm, autoC = 0;
    while ((cm = cellRe.exec(body))) {
      const cAttrs = cm[1] || '';
      const cBody = cm[2] || '';
      const refM = /\br="([A-Z]+\d+)"/.exec(cAttrs);
      const ci = refM ? colIndex(refM[1]) : autoC;
      autoC = ci + 1;

      const tM = /\bt="([^"]+)"/.exec(cAttrs);
      const t = tM ? tM[1] : '';
      let val = '';

      if (t === 's') {
        const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cBody);
        if (vm) val = shared[Number(vm[1])] || '';
      } else if (t === 'inlineStr') {
        const ts = cBody.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [];
        val = ts.map(x => unxml(x.replace(/<[^>]+>/g, ''))).join('');
      } else if (t === 'str') {
        const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cBody);
        if (vm) val = unxml(vm[1]);
      } else {
        const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cBody);
        if (vm) val = unxml(vm[1]);
      }
      cells[ci] = val;
    }

    /* 补齐空洞 */
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = '';
    rows[rowIdx] = cells;
  }

  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];

  /* 合并单元格：把左上角的值铺满整个区域（学校里最典型的是 A 列合并） */
  const mergeRe = /<mergeCell\b[^>]*\bref="([A-Z]+\d+):([A-Z]+\d+)"/g;
  let mm;
  while ((mm = mergeRe.exec(xml))) {
    const a = /^([A-Z]+)(\d+)$/.exec(mm[1]);
    const b = /^([A-Z]+)(\d+)$/.exec(mm[2]);
    if (!a || !b) continue;
    const c1 = colIndex(a[1]), c2 = colIndex(b[1]);
    const r1 = Number(a[2]) - 1, r2 = Number(b[2]) - 1;
    const v = (rows[r1] && rows[r1][c1]) || '';
    if (!v) continue;
    for (let r = r1; r <= r2 && r < rows.length; r++) {
      if (!rows[r]) rows[r] = [];
      for (let c = c1; c <= c2; c++) if (!rows[r][c]) rows[r][c] = v;
    }
  }

  return rows;
}

/* ============================ 对外：读工作簿 ============================ */

function readXlsx(buf) {
  const files = readZip(buf);
  const shared = parseSharedStrings(
    (files['xl/sharedStrings.xml'] || Buffer.alloc(0)).toString('utf8')
  );

  /* 挑第一个工作表 */
  const sheetNames = Object.keys(files)
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => {
      const x = Number(/(\d+)/.exec(a)[1]);
      const y = Number(/(\d+)/.exec(b)[1]);
      return x - y;
    });
  if (!sheetNames.length) throw new Error('这个 Excel 里没有工作表');

  const xml = files[sheetNames[0]].toString('utf8');
  return { rows: parseSheet(xml, shared), sheet: sheetNames[0] };
}

/* ============================ CSv ============================ */

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text).replace(/^\ufeff/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else q = false;
      } else cell += ch;
    } else if (ch === '"') {
      q = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\r') {
      /* 跳过，等 \n */
    } else if (ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8', 3);
  }
  /* 先按 utf8 试，出现替换字符就换 GBK（Windows 版 Excel 另存的 CSV 就是 GBK） */
  const asUtf8 = buf.toString('utf8');
  if (asUtf8.indexOf('\ufffd') < 0) return asUtf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch (e) {
    return asUtf8;
  }
}

/* ============================ 归并成学校班级 ============================ */

const SPLIT_CLS = /[,，、;；\/]+/;
const HEADER_WORDS = ['学校', '学校名称', '班级', '班级名称', '年级班级', '序号'];

function toSchools(rows) {
  const warnings = [];
  const schools = [];
  const byName = Object.create(null);

  const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const isNum = v => /^\d+(\.0*)?$/.test(v);

  let table = (rows || []).map(r => (r || []).map(clean));

  /* 表头行：第一列正好是"学校""班级""序号"这类词（真实校名不会叫这个） */
  let headerRow = -1;
  for (let i = 0; i < Math.min(table.length, 4); i++) {
    if (HEADER_WORDS.indexOf(table[i][0]) >= 0) { headerRow = i; break; }
  }

  /* 序号列：表头写了"序号"，或者没有表头但每行第一列都是数字、第二列不是 */
  let drop = -1;
  if (headerRow >= 0 && table[headerRow][0].indexOf('序号') >= 0) {
    drop = 0;
  } else if (headerRow < 0) {
    const sample = table.filter(r => r.length > 1 && r.some(c => c)).slice(0, 8);
    if (sample.length >= 2 && sample.every(r => isNum(r[0]) && !isNum(r[1]))) drop = 0;
  }
  if (drop === 0) table = table.map(r => r.slice(1));

  for (let i = 0; i < table.length; i++) {
    let cells = table[i].slice();

    /* 去掉行尾空列 */
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (!cells.length) continue;

    /* 表头行、以及翻页重复出现的表头 */
    if (i === headerRow) continue;
    if (HEADER_WORDS.indexOf(cells[0]) >= 0) continue;

    const schoolName = cells[0];
    const rest = cells.slice(1).join(',');

    if (!schoolName) {
      /* 学校名为空：如果这行只有班级，归到上一所学校（合并单元格没解析出来时兜底） */
      const clsOnly = rest.split(SPLIT_CLS).map(clean).filter(Boolean);
      if (clsOnly.length && schools.length) {
        addClasses(schools[schools.length - 1], clsOnly.map(c => c.slice(0, 30)));
      } else if (clsOnly.length) {
        warnings.push('第 ' + (i + 1) + ' 行有班级但没写学校名，已跳过');
      }
      continue;
    }

    const clsList = rest.split(SPLIT_CLS).map(clean).filter(Boolean);
    let sc = byName[schoolName];
    if (!sc) {
      sc = { name: schoolName.slice(0, 30), classes: [] };
      byName[schoolName] = sc;
      schools.push(sc);
    }
    addClasses(sc, clsList.map(c => c.slice(0, 30)));

    if (!clsList.length) warnings.push('学校「' + schoolName + '」还没有班级');
  }

  const ok = schools.filter(s => s.name);
  return { schools: ok, warnings: warnings.slice(0, 8), totalClasses: ok.reduce((n, s) => n + s.classes.length, 0) };
}

function addClasses(sc, list) {
  for (const c of list) {
    if (c && sc.classes.indexOf(c) < 0 && sc.classes.length < 60) sc.classes.push(c);
  }
}

/* ============================ 入口 ============================ */

/**
 * @param {Buffer} buf  文件内容
 * @param {string} filename  原始文件名（用来判断格式）
 * @returns {{schools:Array, warnings:Array, totalClasses:number, format:string}}
 */
function parseFile(buf, filename) {
  const name = String(filename || '').toLowerCase();
  let rows, format;

  if (/\.csv$/.test(name) || /\.txt$/.test(name)) {
    rows = parseCsv(decodeText(buf));
    format = 'csv';
  } else if (/\.xlsx$/.test(name) || /\.xlsm$/.test(name)) {
    rows = readXlsx(buf).rows;
    format = 'xlsx';
  } else if (/\.xls$/.test(name)) {
    throw new Error('不支持老版 .xls（97-2003）格式，请在 Excel / WPS 里「另存为」.xlsx 或 .csv 再导入');
  } else {
    /* 没有扩展名就按 zip 头猜 */
    if (buf[0] === 0x50 && buf[1] === 0x4b) { rows = readXlsx(buf).rows; format = 'xlsx'; }
    else { rows = parseCsv(decodeText(buf)); format = 'csv'; }
  }

  const res = toSchools(rows);
  res.format = format;
  res.rows = rows.length;
  if (!res.schools.length) {
    throw new Error('没有读到学校数据。请确认表格是「第一列学校名、第二列起班级名」的格式');
  }
  return res;
}

module.exports = { parseFile, parseCsv, toSchools, readXlsx };
