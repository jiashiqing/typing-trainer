/* ==========================================================================
 * 学生端 · 语料与指法数据（data.js）
 * --------------------------------------------------------------------------
 * 这里是整个系统的"教学内容"，改动这里就等于改教材。
 * 老师如果觉得某个词太难/太简单，直接改这个文件即可，不用动逻辑。
 * ========================================================================== */
(function () {
  'use strict';

  /* ---------------- 手指分工（标准指法） ---------------- */
  /* 0 左小指 1 左无名 2 左中 3 左食 4 右食 5 右中 6 右无名 7 右小指 */
  var FINGER_NAME = ['左手小指', '左手无名指', '左手中指', '左手食指',
    '右手食指', '右手中指', '右手无名指', '右手小指'];
  var FINGER_COLOR = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6',
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444'];
  /* 左右手着色：0/1 左手，2 右手 */
  var HAND = [0, 0, 0, 0, 1, 1, 1, 1];

  var FINGER = {
    '`': 0, '1': 0, '2': 1, '3': 2, '4': 3, '5': 3, '6': 4, '7': 4, '8': 5, '9': 6, '0': 7, '-': 7, '=': 7,
    'q': 0, 'w': 1, 'e': 2, 'r': 3, 't': 3, 'y': 4, 'u': 4, 'i': 5, 'o': 6, 'p': 7, '[': 7, ']': 7, '\\': 7,
    'a': 0, 's': 1, 'd': 2, 'f': 3, 'g': 3, 'h': 4, 'j': 4, 'k': 5, 'l': 6, ';': 7, "'": 7,
    'z': 0, 'x': 1, 'c': 2, 'v': 3, 'b': 3, 'n': 4, 'm': 4, ',': 4, '.': 6, '/': 7
  };

  /* 键盘四行，用于虚拟键盘渲染 */
  var KB_ROWS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/']
  ];

  /* 基准键（手指归位位置），界面上做小凸起标记 */
  var HOME_KEYS = ['f', 'j'];

  /* ---------------- 键位闯关 5 关 ---------------- */
  var KEY_LEVELS = [
    {
      id: 1, name: '基准键位', tag: 'ASDF JKL;',
      chars: 'asdfjkl;gh', need: 40, diff: 0.80,
      tip: '左手食指放 F，右手食指放 J（上面有小凸起，摸一下就能找到）。八个手指各就各位，拇指轻放空格。',
      goal: '这是所有指法的根。手不离键，眼睛不看键盘。'
    },
    {
      id: 2, name: '上排键位', tag: 'QWER UIOP',
      chars: 'qwertyuiop', need: 40, diff: 0.85,
      tip: '手指从基准位向上抬起击键，打完立刻缩回基准位。注意左手管 qwert，右手管 yuiop。',
      goal: '重点不是"打得快"，是"打得回得来"。'
    },
    {
      id: 3, name: '下排键位', tag: 'ZXCV BNM',
      chars: 'zxcvbnm', need: 40, diff: 0.90,
      tip: '下排最容易错，因为手指要往下够。B 用左手食指，N 用右手食指，两个大拇指不要动。',
      goal: 'B 和 N 是全校错误率最高的两个键，慢一点，打准。'
    },
    {
      id: 4, name: '全字母混合', tag: 'a—z 26 键',
      chars: 'abcdefghijklmnopqrstuvwxyz', need: 60, diff: 1.00,
      tip: '三排混合，考验手指在三排之间来回切换。慢就是快，别抢。',
      goal: '连续正确 60 键，说明三排切换已经稳了。'
    },
    {
      id: 5, name: '数字与符号', tag: '1—0 , . ;',
      chars: '1234567890,.;-', need: 40, diff: 1.10,
      tip: '数字排由手指向上伸展击打：1 左小指、2 左无名、3 左中指、4 和 5 左手食指、6 和 7 右手食指、8 右中指、9 右无名、0 右小指。',
      goal: '初中和高中阶段最实用的一关。'
    }
  ];

  /* ---------------- 速度练习语料 ---------------- */
  var WORDS_EASY = ('cat dog sun hat cup pen bed red box map bus car key fly ice '
    + 'tree book fish bird milk hand door home park rain game ball name girl boy '
    + 'good look come play jump read swim blue green happy water apple house '
    + 'small big run sit new old day way day eye ear arm leg foot').split(/\s+/);

  var WORDS_MID = ('school teacher student computer keyboard mouse screen lesson '
    + 'practice exercise morning afternoon evening homework question answer '
    + 'because together different important beautiful interesting remember '
    + 'language program digital network message picture favorite holiday '
    + 'morning country science history music art sport friend family').split(/\s+/);

  var TEXTS = [
    'The sun is hot today. My friends and I go to the park. We play games under a big tree. A little dog runs to us and wants to play too. We all laugh and run around. When the sun goes down, we walk home with a happy heart.',
    'My computer is on the desk. I use it to read and write. In the morning I type a short story. In the afternoon I draw a picture with my mouse. A computer is a good helper, but I also like to play outside with my friends.',
    'It is a small box, but it can do many things. You can use it to find a word, to draw a map, or to talk to a friend far away. We call it a computer. We must use it well and not too long every day.',
    'Every morning we read for ten minutes. The teacher says reading is like eating, you must do it every day. I read a book about the sea. There are many fish and a big whale. I want to see the sea one day.',
    'A good habit is a small thing you do every day. Wash your hands. Keep your desk clean. Put your books in the bag. Sit up straight when you type. Small things, done every day, make a big difference.'
  ];

  var NUM_CHARS = '1234567890,.;-';

  /* ---------------- 中文跟打语料（内置） ---------------- */
  /* 中文没有"逐键判定"这回事（要靠输入法上屏），所以这里的正文会先压掉空白，
     只保留汉字与标点，学生照着打、程序按"上屏文字逐字比对"判对错。
     level：1 简单 / 2 中等 / 3 较难（只影响难度系数，不影响正文）。 */
  var ZH_TEXTS = [
    {
      id: 'zh-builtin-1', title: '认识键盘', level: '1',
      body: '键盘是我们和电脑说话的工具。十个手指各有自己的位置，眼睛看着屏幕，手指按分工去找键。刚开始慢一点没关系，打得准比打得快更重要。'
    },
    {
      id: 'zh-builtin-2', title: '春天的校园', level: '1',
      body: '春天来了，校园里的树都发出了新芽。下课以后，同学们在操场上跑步、跳绳、踢毽子。风一吹，国旗在蓝天上飘得很高，我们的心里也很亮堂。'
    },
    {
      id: 'zh-builtin-3', title: '信息怎样传递', level: '2',
      body: '古时候，人们靠烽火、书信和口耳相传来传递消息，一封信往往要走很多天。后来有了电报和电话，距离一下子变短了。今天我们打开手机，几秒钟就能和远方的人说上话。'
    },
    {
      id: 'zh-builtin-4', title: '读书要耐心', level: '3',
      body: '读书是一件需要耐心的事。一本书摆在面前，先看目录，再看正文，遇到不懂的地方做个记号，回头再查。日积月累，你会发现自己懂得越来越多，说话做事也更有分寸。'
    }
  ];

  /* 中文正文统一处理：去掉所有空白，只留下要打的字和标点 */
  function zhBody(s) {
    return String(s || '').replace(/\s+/g, '');
  }

  /* ---------------- 单词冲刺 三级词库 ---------------- */
  var RUSH = {
    1: { name: '三年级', list: ('cat dog sun hat cup pen bed red box map bus car key '
      + 'fly ice tree book fish bird milk hand door home park rain game ball name '
      + 'girl boy good look come play jump read swim blue happy water apple')
      .split(/\s+/) },
    2: { name: '四—六年级', list: ('school teacher student computer keyboard mouse '
      + 'screen lesson practice exercise morning afternoon evening homework '
      + 'question answer because together different important beautiful '
      + 'interesting remember language program picture favorite holiday country '
      + 'science history music sport friend family')
      .split(/\s+/) },
    3: { name: '初中', list: ('information technology program digital network '
      + 'message document internet website software hardware keyboard practice '
      + 'describe experience environment knowledge communicate responsible '
      + 'challenge progress achievement careful different important interesting '
      + 'remember understand question answer together')
      .split(/\s+/) }
  };

  /* ---------------- 语料生成器 ---------------- */
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  /* 键位串：只从指定字符里取，保证练的是该关内容 */
  function genKeyDrill(chars, len, allowSpace) {
    var pool = chars.split('');
    var s = '';
    var last = '';
    for (var i = 0; i < len; i++) {
      var c = pick(pool);
      var guard = 0;
      while (c === last && guard++ < 8) c = pick(pool);   // 避免连续重复同一个键
      s += c;
      last = c;
      if (allowSpace && (i + 1) % 5 === 0 && i < len - 1) s += ' ';
    }
    return s;
  }

  function genWords(list, count) {
    var out = [];
    for (var i = 0; i < count; i++) {
      var w = pick(list);
      if (out.length && out[out.length - 1] === w) w = pick(list);
      out.push(w);
    }
    return out.join(' ');
  }

  /* 统一入口：返回 { text, label, diff, level } */
  function corpus(level, needChars) {
    needChars = needChars || 400;
    if (level === 'keys') {      var c = 'asdfjkl;ghqwertyuiopzxcvbnm';
      return { text: genKeyDrill(c, needChars, true), label: '键位串', diff: 0.90, level: level };
    }
    if (level === 'word') {
      return { text: genWords(WORDS_EASY.concat(WORDS_MID), Math.ceil(needChars / 5)),
        label: '英文单词', diff: 1.05, level: level };
    }
    if (level === 'num') {
      var n = 0, s = '';
      while (s.length < needChars) {
        s += pick(NUM_CHARS.split(''));
        if (++n % 4 === 0) s += ' ';
      }
      return { text: s, label: '数字与符号', diff: 1.10, level: level };
    }
    /* text：短文 */
    var t = pick(TEXTS);
    while (t.length < needChars) t += ' ' + pick(TEXTS);
    return { text: t.slice(0, needChars), label: '英文短文', diff: 1.20, level: 'text' };
  }

  /* 中文语料组装：把一篇或多篇中文正文拼到够打为止（轮换，避免死循环） */
  function zhCorpus(texts, need) {
    var pool = (texts && texts.length ? texts : ZH_TEXTS)
      .map(function (t) { return zhBody(typeof t === 'string' ? t : t.body); })
      .filter(Boolean);
    if (!pool.length) pool = ['请先在教师端的课堂管理里导入一篇练习文本。'];
    need = Math.max(60, need || 200);
    var out = '';
    var i = 0;
    while (out.length < need && i < 40) {
      out += pool[i % pool.length];
      i++;
    }
    return { text: out, next: i };
  }

  window.TDATA = {
    FINGER: FINGER, FINGER_NAME: FINGER_NAME, FINGER_COLOR: FINGER_COLOR, HAND: HAND,
    KB_ROWS: KB_ROWS, HOME_KEYS: HOME_KEYS,
    KEY_LEVELS: KEY_LEVELS,
    TEXTS: TEXTS, WORDS_EASY: WORDS_EASY, WORDS_MID: WORDS_MID, RUSH: RUSH,
    ZH_TEXTS: ZH_TEXTS, zhBody: zhBody, zhCorpus: zhCorpus,
    genKeyDrill: genKeyDrill, genWords: genWords, corpus: corpus, pick: pick
  };
})();
