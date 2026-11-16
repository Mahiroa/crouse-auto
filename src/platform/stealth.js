((Y) => {
  // 环境体检 + 统一日志出口
  // 体检是纯只读探测：不改写任何页面原生 API，只回答「这台机器看起来有多像自动化」。
  // 所有探测都必须包 try/catch —— jsdom 测试与切片测试会直接加载本模块，
  // 没有 DOM 也不允许抛。

  // 配置归一化只认这两个档位，其余一律 off
  const DEFAULT_CONF = { screenGuard: 'off', quietLog: true };

  // 体检层自己的配置键：与 storageKeys.feature 彻底解耦。
  // 原因（实测）：Y.Store.getFeatureConf() 是白名单装配，且每次读都会把白名单对象回写进
  // feature 键，screenGuard/quietLog 不在白名单里，先读 store 再读同一个键永远是空的，
  // 两个开关会恒定回落成 off/true。所以独立键、只读不写别人的键，也不调用那个函数。
  const STEALTH_KEY = 'ykt_stealth_conf';

  // 原生实现的判据：Function.prototype.toString 的结果里带 [native code]。
  // 被手写函数或普通包装函数替换后，这里拿到的是源码文本，判据就失效。
  const NATIVE_PATTERN = /\{\s*\[native code\]\s*\}/;

  // 无头浏览器 / 驱动注入到 window 上的特征键
  const CDP_PATTERN = /^(cdc_|__driver|__playwright|__pw|__nightmare|_phantom|__selenium)/i;

  // 页面真身：greasemonkey 沙箱里是 unsafeWindow，扩展/Node 里没有它就退回来
  function rootWindow() {
    try {
      const win = typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
      if (win) return win;
    } catch (_) {}
    try {
      if (typeof globalThis !== 'undefined' && globalThis) return globalThis;
    } catch (_) {}
    return null;
  }

  function rootDocument() {
    try {
      const doc = typeof document !== 'undefined' && document ? document : null;
      if (doc) return doc;
    } catch (_) {}
    try {
      const win = rootWindow();
      if (win && win.document) return win.document;
    } catch (_) {}
    return null;
  }

  function isNative(fn) {
    if (typeof fn !== 'function') return false;
    try {
      return NATIVE_PATTERN.test(Function.prototype.toString.call(fn));
    } catch (_) {
      return false;
    }
  }

  // 探测表：名字就是报给使用者的路径，读取器各自防御，缺 API 时给 undefined
  const NATIVE_PROBES = [
    ['XMLHttpRequest.prototype.send', win => (win.XMLHttpRequest && win.XMLHttpRequest.prototype ? win.XMLHttpRequest.prototype.send : undefined)],
    ['XMLHttpRequest.prototype.open', win => (win.XMLHttpRequest && win.XMLHttpRequest.prototype ? win.XMLHttpRequest.prototype.open : undefined)],
    ['window.fetch', win => win.fetch],
    ['window.addEventListener', win => win.addEventListener],
    ['console.log', win => (win.console ? win.console.log : undefined)],
    ['JSON.stringify', win => (win.JSON ? win.JSON.stringify : undefined)]
  ];

  function readProbe(win, read) {
    if (!win) return undefined;
    try {
      return read(win);
    } catch (_) {
      return undefined;
    }
  }

  // 装载时的基线快照。
  // 只按「当前是否原生」绝对值判定会把宿主实现误报成被改写：jsdom 的
  // addEventListener / XMLHttpRequest.send / console.log 本身就是 JS 版实现，
  // 干净页面也会被算成 high，体检就废了。所以先记下装载那一刻的函数引用与原生性，
  // 后面只把「引用变了」或「装载时本是原生、现在不是」的才计入 patchedNatives。
  const BASELINE = new Map();

  function seedBaseline() {
    const win = rootWindow();
    for (const entry of NATIVE_PROBES) {
      try {
        const fn = readProbe(win, entry[1]);
        BASELINE.set(entry[0], { ref: fn, native: isNative(fn) });
      } catch (_) {
        BASELINE.set(entry[0], { ref: undefined, native: false });
      }
    }
  }

  seedBaseline();

  // 被改写过的原生 API：当前实现不再原生，且不是装载时就非原生的宿主实现
  function auditPatchedNatives(win) {
    const hits = [];
    for (const entry of NATIVE_PROBES) {
      const name = entry[0];
      const fn = readProbe(win, entry[1]);
      const base = BASELINE.get(name);
      if (typeof fn !== 'function') {
        // 装载时还在、现在没了，同样算痕迹
        if (base && typeof base.ref === 'function') hits.push(name);
        continue;
      }
      if (isNative(fn)) continue;
      // 引用没变且装载时就非原生：宿主自带实现，不是被谁改写
      if (base && base.ref === fn && base.native === false) continue;
      hits.push(name);
    }
    return hits;
  }

  function auditCdpArtifacts(win) {
    if (!win || typeof win !== 'object') return [];
    let keys;
    try {
      keys = Object.keys(win);
    } catch (_) {
      return [];
    }
    const hits = [];
    for (const key of keys) {
      try {
        if (CDP_PATTERN.test(key)) hits.push(key);
      } catch (_) {}
    }
    return hits;
  }

  function auditExtensionScripts() {
    try {
      const doc = rootDocument();
      if (!doc || !doc.scripts) return 0;
      let count = 0;
      for (let i = 0; i < doc.scripts.length; i += 1) {
        const script = doc.scripts[i];
        const src = script ? String(script.src || '') : '';
        if (src.startsWith('chrome-extension:') || src.startsWith('moz-extension:')) count += 1;
      }
      return count;
    } catch (_) {
      return 0;
    }
  }

  function auditWebdriver(win) {
    try {
      return Boolean(win && win.navigator && win.navigator.webdriver === true);
    } catch (_) {
      return false;
    }
  }

  function auditChromeRuntime(win) {
    try {
      return Boolean(win && win.chrome && win.chrome.runtime);
    } catch (_) {
      return false;
    }
  }

  function scoreOf(state) {
    let score = 0;
    if (state.webdriver) score += 3;
    score += state.patchedNatives.length;
    if (state.cdpArtifacts.length) score += 2;
    if (state.extensionScripts > 0) score += 1;
    return score;
  }

  function riskLevelOf(score) {
    if (score >= 3) return 'high';
    if (score >= 1) return 'medium';
    return 'low';
  }

  function audit() {
    const win = rootWindow();
    const state = {
      webdriver: false,
      cdpArtifacts: [],
      patchedNatives: [],
      extensionScripts: 0,
      chromeRuntime: false,
      score: 0
    };
    try {
      state.webdriver = auditWebdriver(win);
    } catch (_) {}
    try {
      state.cdpArtifacts = auditCdpArtifacts(win);
    } catch (_) {}
    try {
      state.patchedNatives = auditPatchedNatives(win);
    } catch (_) {}
    try {
      state.extensionScripts = auditExtensionScripts();
    } catch (_) {}
    try {
      state.chromeRuntime = auditChromeRuntime(win);
    } catch (_) {}
    state.score = scoreOf(state);
    return state;
  }

  // 体检结果落成 documentElement 上的 dataset，方便肉眼/脚本一眼看到
  function publishRisk(score, riskLevel) {
    try {
      const doc = rootDocument();
      const root = doc && doc.documentElement;
      if (!root) return;
      const scoreText = String(score);
      if (root.dataset) {
        root.dataset.yktRisk = scoreText;
        root.dataset.yktRiskLevel = riskLevel;
        return;
      }
      if (root.setAttribute) {
        root.setAttribute('data-ykt-risk', scoreText);
        root.setAttribute('data-ykt-risk-level', riskLevel);
      }
    } catch (_) {}
  }

  function report() {
    const result = audit();
    const riskLevel = riskLevelOf(result.score);
    publishRisk(result.score, riskLevel);
    return { ...result, riskLevel };
  }

  // ---- 配置：不缓存，改完立刻生效（与项目里 isFastMode 的取法保持一致） ----
  function normalizeScreenGuard(value) {
    return value === 'patch' || value === 'cdp' ? value : 'off';
  }

  function confStorage() {
    try {
      return typeof localStorage !== 'undefined' && localStorage ? localStorage : null;
    } catch (_) {
      return null;
    }
  }

  // 只读解析：先试 Y.Utils.safeJSONParse，拿不到就自己 JSON.parse，两条路都不抛
  function readConfObject(key) {
    if (!key) return null;
    try {
      const storage = confStorage();
      if (!storage) return null;
      const raw = storage.getItem(key);
      if (!raw || typeof raw !== 'string') return null;
      try {
        const parsed = Y.Utils?.safeJSONParse?.(raw, null);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (_) {}
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (_) {}
      return null;
    } catch (_) {
      return null;
    }
  }

  // 老配置对齐：只 peek feature 键的原始内容。
  // 绝不调用 Y.Store.getFeatureConf()——它会把白名单对象回写进 feature 键，副作用不可控。
  function readLegacyConf() {
    let key;
    try {
      key = Y.Config?.storageKeys?.feature;
    } catch (_) {
      key = undefined;
    }
    return readConfObject(key);
  }

  // 归一化：source 里没有的键沿用 fallback（默认 off/true）
  function normalizeConf(source, fallback) {
    const base = fallback || DEFAULT_CONF;
    let guard;
    let quiet;
    try {
      guard = source ? source.screenGuard : undefined;
    } catch (_) {
      guard = undefined;
    }
    try {
      quiet = source ? source.quietLog : undefined;
    } catch (_) {
      quiet = undefined;
    }
    return {
      screenGuard: guard === undefined ? base.screenGuard : normalizeScreenGuard(guard),
      quietLog: quiet === undefined ? base.quietLog : (quiet === false ? false : true)
    };
  }

  function conf() {
    const defaults = { screenGuard: DEFAULT_CONF.screenGuard, quietLog: DEFAULT_CONF.quietLog };
    try {
      const own = readConfObject(STEALTH_KEY);
      if (own) return normalizeConf(own, defaults);
    } catch (_) {}
    try {
      const legacy = readLegacyConf();
      if (legacy) return normalizeConf(legacy, defaults);
    } catch (_) {}
    return defaults;
  }

  // 写入口：只写 STEALTH_KEY，改动立刻生效（不缓存）；未传的键沿用当前值
  function setConf(next) {
    let merged;
    try {
      merged = normalizeConf(next, conf());
    } catch (_) {
      merged = normalizeConf(next, DEFAULT_CONF);
    }
    try {
      const storage = confStorage();
      if (storage) storage.setItem(STEALTH_KEY, JSON.stringify(merged));
    } catch (_) {}
    return merged;
  }

  function isQuiet() {
    try {
      return conf().quietLog !== false;
    } catch (_) {
      return true;
    }
  }

  // note/warn 允许被解构调用（this 丢了就回落到 Y.Stealth 自己）
  function apiOf(self) {
    if (self && typeof self.conf === 'function') return self;
    return Y.Stealth || null;
  }

  function resolveQuiet(self) {
    const api = apiOf(self);
    try {
      if (api && typeof api.conf === 'function') return api.conf().quietLog !== false;
    } catch (_) {}
    return isQuiet();
  }

  function note(msg) {
    const text = String(msg ?? '');
    if (resolveQuiet(this)) {
      try {
        Y.panel?.log?.(text);
      } catch (_) {}
      return;
    }
    try {
      console.log('[刷课助手] ' + text);
    } catch (_) {}
  }

  // 错误对象要能进面板文案：面板只有文本通道，只给 console 留 Error 对象等于用户看不见
  function describeError(err) {
    if (err === undefined || err === null) return '';
    let text;
    try {
      text = err && err.message ? String(err.message) : String(err);
    } catch (_) {
      return '';
    }
    if (!text) return '';
    if (text.length > 180) text = text.slice(0, 180) + '…';
    return '：' + text;
  }

  function warn(msg, err) {
    const text = String(msg ?? '');
    if (resolveQuiet(this)) {
      try {
        Y.panel?.log?.('⚠ ' + text + describeError(err));
      } catch (_) {}
      return;
    }
    try {
      // 不再把原始 Error 交给 console：devtools 一展开就是完整 stack，里面带着
      // userscript 的文件路径与模块名，比一句中文串更像自动化证据。只传文案。
      if (err === undefined) console.warn('[刷课助手] ' + text);
      else console.warn('[刷课助手] ' + text + describeError(err));
    } catch (_) {}
  }

  Y.Stealth = {
    conf,
    setConf,
    audit,
    report,
    note,
    warn,
    isQuiet
  };
})(Y);
