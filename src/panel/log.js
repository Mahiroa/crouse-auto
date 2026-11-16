((Y) => {
  // 面板运行日志的渲染层（结构：时间 + 分组 + 正文 + 等级配色）
  //
  // 以前整个面板只有一句 `li.innerText = message`：所有信息一坨灰字，几十行之后根本挑不出
  // 「哪句是进度、哪句是警告、哪句是答题结果」。这里把一条日志拆成结构化的一段：
  //
  //   21:58:41 │答题│ ✅ 填空题（1 个空），填入：高铁
  //   └ 时间    └ 分组 └ 正文（等级决定颜色：ok 绿 / warn 琥珀 / error 红 / step 蓝 / ai 紫）
  //
  // 分组优先用调用方给的（stage('答题') 之后的行都归到该组），没给就按正文关键词推断；
  // 等级优先用调用方给的，没给就按前缀推断（✅ / ⚠️ / 🚨 / ▶）。这样几十处老调用点
  // 一行都不用改，也能立刻变成结构化日志。
  const LEVELS = ['info', 'step', 'ok', 'ai', 'warn', 'error'];
  const MAX_LINES = 200;

  // 正文前缀 → 等级
  function inferLevel(text) {
    if (/^✅/.test(text)) return 'ok';
    if (/^⚠️/.test(text)) return 'warn';
    if (/^(🚨|❌)/.test(text)) return 'error';
    if (/^(▶|→)/.test(text)) return 'step';
    if (/^(🤖|\[AI\])/.test(text)) return 'ai';
    return 'info';
  }

  // 正文关键词 → 分组（顺序有意义：先判最专的）
  // 「播放」排在「进度」前面：像「准备进入下一节：视频 Video」这种行，用户想按播放筛，
  // 而不是按导航筛。
  const TAG_RULES = [
    ['核验', /安全核验|验证码|滑块|轨迹核验|过核验/],
    ['答题', /答题|题目|填空题|单选题|多选题|判断题|答案|选项|选择|作业/],
    ['播放', /视频|音频|课件|播放|倍速|静音|播放器/],
    ['进度', /准备进入|已进入|跳过|已完成|切换用时|刷完|目录/],
    ['网络', /搜题|接口|HTTP|请求|网络|更新|GitHub/]
  ];

  function inferTag(text) {
    for (const [tag, pattern] of TAG_RULES) {
      if (pattern.test(text)) return tag;
    }
    return '';
  }

  const pad = value => String(value).padStart(2, '0');
  function stamp(date) {
    const now = date instanceof Date ? date : new Date();
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  function create(options = {}) {
    const doc = options.doc || document;
    const list = options.list;
    const counter = options.counter || null;
    const maxLines = Number(options.maxLines) > 0 ? Number(options.maxLines) : MAX_LINES;
    let stageTag = '';
    let filter = 'all';
    const counts = { info: 0, step: 0, ok: 0, ai: 0, warn: 0, error: 0 };

    const matchesFilter = level => {
      if (filter === 'all') return true;
      if (filter === 'warn') return level === 'warn' || level === 'error';
      if (filter === 'error') return level === 'error';
      return true;
    };

    const refreshCounter = () => {
      if (!counter) return;
      counter.textContent = String(list.children.length);
    };

    const applyFilter = () => {
      for (const li of list.children) {
        li.hidden = !matchesFilter(li.dataset.level || 'info');
      }
      refreshCounter();
    };

    function push(message, optionsArg = {}) {
      if (!list) return null;
      const raw = String(message ?? '');
      if (!raw) return null;
      const level = LEVELS.includes(optionsArg.level) ? optionsArg.level : inferLevel(raw);
      const tag = optionsArg.tag === '' ? '' : (optionsArg.tag || stageTag || inferTag(raw));
      const li = doc.createElement('li');
      li.className = `log-line lv-${level}`;
      li.dataset.level = level;
      if (tag) li.dataset.tag = tag;

      if (optionsArg.time !== false) {
        const time = doc.createElement('span');
        time.className = 'log-time';
        time.textContent = stamp(optionsArg.at);
        li.appendChild(time);
      }
      if (tag) {
        const tagEl = doc.createElement('span');
        tagEl.className = 'log-tag';
        tagEl.textContent = tag;
        li.appendChild(tagEl);
      }
      const text = doc.createElement('span');
      text.className = 'log-text';
      text.textContent = raw;
      li.appendChild(text);

      counts[level] = (counts[level] || 0) + 1;
      li.hidden = !matchesFilter(level);
      list.appendChild(li);
      while (list.children.length > maxLines) {
        const first = list.firstElementChild;
        first.remove();
      }
      refreshCounter();
      try {
        li.scrollIntoView?.({ block: 'nearest' });
      } catch (_) {}
      return li;
    }

    return {
      push,
      // stage('答题') 之后的行都归到「答题」组，stage('') 复位
      stage(name) {
        stageTag = String(name || '');
        return stageTag;
      },
      currentStage: () => stageTag,
      setFilter(name) {
        filter = ['all', 'warn', 'error'].includes(name) ? name : 'all';
        applyFilter();
        return filter;
      },
      currentFilter: () => filter,
      counts: () => ({ ...counts }),
      clear() {
        list.replaceChildren();
        for (const key of Object.keys(counts)) counts[key] = 0;
        refreshCounter();
      },
      lines: () => [...list.children]
    };
  }

  Y.PanelLog = { create, inferLevel, inferTag, stamp, LEVELS };
})(Y);
