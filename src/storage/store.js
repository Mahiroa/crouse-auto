((Y) => {
  // localStorage 封装、配置读写与启动同步

  // ---- 存储工具 ----
  // 隐私设置/无痕模式/站点数据被阻止时，访问 localStorage 会直接抛异常。
  // 面板初始化路径上有两处读它（恢复面板位置、跨页自动恢复），一抛就整块面板消失，
  // 现象和「脚本根本没运行」完全一样，排查代价极高 —— 所以这里统一兜住。
  const storeSafe = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch (_) {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (_) {
        return false;
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
        return true;
      } catch (_) {
        return false;
      }
    }
  };

  // ---- 作业答案缓存 ----
  // 答案缓存只是加速器：命中就省一次模型调用，删掉只影响速度，不影响配置语义，
  // 所以键和上限都放在 store.js 内部，不进 core/config.js。
  const ANSWER_CACHE_KEY = 'ykt_answer_cache_v1';
  const ANSWER_CACHE_LIMIT = 300;

  const Store = {
    // localStorage 里可能是 null / 数组 / 数字等脏数据，统一归一成普通对象，
    // 避免 `all[url] = ...` 在 null 上抛 TypeError 把整条刷课链打断
    readObject(key) {
      const parsed = Y.Utils.safeJSONParse(localStorage.getItem(key), {});
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    },
    getProgress(url) {
      const all = this.readObject(Y.Config.storageKeys.progress);
      const raw = all[url];
      const current = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      // 内层也要数字兜底：旧数据可能是 {} / [] / {outside:"3"} / {outside:null}。
      // 直接返回会让 V2Runner 的 this.outside 变成 undefined/null/字符串：
      //   - `outside >= list.length` 恒假、`list[outside]` 取不到课程 → continue 没有 await → 原地死循环；
      //   - `"3" + 1 === "31"` 会让进度一路膨胀。
      // 这里统一归一成 >=0 的整数，并立即回写修复脏数据，刷新页面后不会继续坏。
      const outside = Number.isFinite(Number(current.outside))
        ? Math.max(0, Math.floor(Number(current.outside)))
        : 0;
      const inside = Number.isFinite(Number(current.inside))
        ? Math.max(0, Math.floor(Number(current.inside)))
        : 0;
      const normalized = { ...current, outside, inside };
      all[url] = normalized;
      localStorage.setItem(Y.Config.storageKeys.progress, JSON.stringify(all));
      return { all, current: normalized };
    },
    setProgress(url, outside, inside = 0) {
      const all = this.readObject(Y.Config.storageKeys.progress);
      all[url] = { outside, inside };
      localStorage.setItem(Y.Config.storageKeys.progress, JSON.stringify(all));
    },
    removeProgress(url) {
      const all = this.readObject(Y.Config.storageKeys.progress);
      delete all[url];
      localStorage.setItem(Y.Config.storageKeys.progress, JSON.stringify(all));
    },
    // 进度键是完整 URL；SPA 路由变化后按钮拿到的 href 可能已经不是当初写入的那个。
    // 按 classroomId 再清一遍，保证「清除缓存」真的清干净。
    removeProgressByClassroom(classroomId) {
      if (!classroomId) return;
      const all = this.readObject(Y.Config.storageKeys.progress);
      const needle = String(classroomId);
      const matches = key => key.includes(`/lms-graph/${needle}/`)
        || key.includes(`/studentLog/${needle}`)
        || key.includes(`classroom_id=${needle}`);
      let changed = false;
      for (const key of Object.keys(all)) {
        if (matches(key)) {
          delete all[key];
          changed = true;
        }
      }
      if (changed) localStorage.setItem(Y.Config.storageKeys.progress, JSON.stringify(all));
    },
    getAIConf() {
      const raw = localStorage.getItem(Y.Config.storageKeys.ai);
      const saved = Y.Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        url: saved.url ?? "https://api.deepseek.com/chat/completions",
        key: saved.key ?? "sk-xxxxxxx",
        model: saved.model ?? "deepseek-flash",
        apiFormat: saved.apiFormat ?? "openai", // openai 或 anthropic
        authMethod: saved.authMethod ?? "bearer", // bearer 或 x-api-key
      };
      const retiredModels = {
        'deepseek-chat': 'deepseek-flash',
        'deepseek-reasoner': 'deepseek-flash',
        'deepseek-v4-flash': 'deepseek-flash'
      };
      if (String(conf.url).includes('deepseek.com') && retiredModels[conf.model]) {
        conf.model = retiredModels[conf.model];
      }
      localStorage.setItem(Y.Config.storageKeys.ai, JSON.stringify(conf));
      return conf;
    },
    setAIConf(conf) {
      localStorage.setItem(Y.Config.storageKeys.ai, JSON.stringify(conf));
    },
    getProClassCount() {
      const value = Number(localStorage.getItem(Y.Config.storageKeys.proClassCount));
      return Number.isFinite(value) && value >= 1 ? value : 1;
    },
    setProClassCount(count) {
      localStorage.setItem(Y.Config.storageKeys.proClassCount, count);
    },
    getFeatureConf() {
      const raw = localStorage.getItem(Y.Config.storageKeys.feature);
      const saved = Y.Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        autoAI: saved.autoAI ?? false,
        autoComment: saved.autoComment ?? false,
        // 三态：'skip' 跳过当前章节（默认）/ 'wait' 停下等人 / 'auto' 脚本自动过核验；
        // 其它任何脏值（旧版本、手改 localStorage、null）一律归一成默认的 'skip'。
        humanCheckMode: saved.humanCheckMode === 'wait' || saved.humanCheckMode === 'auto'
          ? saved.humanCheckMode
          : 'skip',
        fastMode: saved.fastMode === true,
      };
      localStorage.setItem(Y.Config.storageKeys.feature, JSON.stringify(conf));
      return conf;
    },
    setFeatureConf(conf) {
      localStorage.setItem(Y.Config.storageKeys.feature, JSON.stringify(conf));
    },
    // 倍速与静音：进入视频后默认 2 倍速 + 静音，修改后立即生效并持久化
    getPlaybackConf() {
      const raw = localStorage.getItem(Y.Config.storageKeys.playback);
      const saved = Y.Utils.safeJSONParse(raw, {}) || {};
      const rate = Number(saved.playbackRate);
      return {
        playbackRate: Number.isFinite(rate) && rate >= 0.25 && rate <= 4 ? rate : Y.DEFAULT_PLAYBACK.rate,
        muted: typeof saved.muted === 'boolean' ? saved.muted : Y.DEFAULT_PLAYBACK.muted
      };
    },
    setPlaybackConf(conf) {
      const rate = Number(conf?.playbackRate);
      if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) throw new Error('播放速度须为 0.25～4 倍');
      const saved = { playbackRate: rate, muted: Boolean(conf?.muted) };
      localStorage.setItem(Y.Config.storageKeys.playback, JSON.stringify(saved));
      Y.Config.playbackRate = rate;
      return saved;
    },
    getPendingAutoStart() {
      const raw = storeSafe.get(Y.Config.storageKeys.pendingAutoStart);
      const saved = Y.Utils.safeJSONParse(raw, null);
      if (!saved || !saved.classroomId || !saved.ts) return null;
      if (Date.now() - saved.ts > 30 * 60 * 1000) {
        storeSafe.remove(Y.Config.storageKeys.pendingAutoStart);
        return null;
      }
      return saved;
    },
    setPendingAutoStart(classroomId = '', returnUrl = '') {
      if (!classroomId) return;
      const prev = this.getPendingAutoStart() || {};
      localStorage.setItem(Y.Config.storageKeys.pendingAutoStart, JSON.stringify({
        classroomId,
        returnUrl: returnUrl || prev.returnUrl || '',
        ts: Date.now()
      }));
    },
    clearPendingAutoStart() {
      localStorage.removeItem(Y.Config.storageKeys.pendingAutoStart);
    },
    trailScope() {
      return Y.Utils.getCurrentClassroomId()
        || this.getPendingAutoStart()?.classroomId
        || location.pathname;
    },
    getTrail() {
      const all = this.readObject(Y.Config.storageKeys.trail);
      const raw = all[this.trailScope()];
      const trail = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      // 内层结构也要归一：以前只归一顶层，`ykt_trail={"scope":{"steps":5}}` 会让
      // createPanel() 里的 renderTrail -> steps.filter 抛 TypeError，panel 赋值失败后整个脚本等于死了。
      const steps = Array.isArray(trail.steps)
        ? trail.steps
          .filter(step => step && typeof step === 'object' && !Array.isArray(step))
          .map(step => ({
            id: String(step.id ?? ''),
            kind: typeof step.kind === 'string' ? step.kind : 'course',
            title: String(step.title ?? ''),
            detail: step.detail == null ? '' : String(step.detail),
            status: typeof step.status === 'string' ? step.status : 'doing'
          }))
        : [];
      return {
        ...trail,
        steps,
        currentTitle: typeof trail.currentTitle === 'string' ? trail.currentTitle : '',
        currentDetail: typeof trail.currentDetail === 'string' ? trail.currentDetail : '',
        currentStepId: typeof trail.currentStepId === 'string' ? trail.currentStepId : ''
      };
    },
    saveTrail(trail) {
      const all = this.readObject(Y.Config.storageKeys.trail);
      all[this.trailScope()] = trail;
      localStorage.setItem(Y.Config.storageKeys.trail, JSON.stringify(all));
    },
    clearTrail() {
      const all = this.readObject(Y.Config.storageKeys.trail);
      delete all[this.trailScope()];
      localStorage.setItem(Y.Config.storageKeys.trail, JSON.stringify(all));
    },
    // ---- 作业答案缓存（跨运行） ----
    // 键来自 Y.Solver.questionFingerprint（题干 + 选项文本的 FNV-1a），值形如
    // { answer: 'C' | 'AB' | '对' | '错', type: 'single'|'multiple'|'judge', at: 毫秒时间戳 }。
    // 读全部时统一归一：坏 JSON / 非对象 / 数组 / 缺 answer 的条目一律丢掉，返回普通对象 {}，
    // 这样后面 all[key] = ... 不会在 null 上抛 TypeError。
    readAnswerCache() {
      const parsed = Y.Utils.safeJSONParse(storeSafe.get(ANSWER_CACHE_KEY), {});
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const normalized = {};
      for (const [key, entry] of Object.entries(parsed)) {
        if (!key || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const answer = typeof entry.answer === 'string' ? entry.answer.trim() : '';
        if (!answer) continue;
        normalized[key] = {
          answer,
          type: typeof entry.type === 'string' && entry.type ? entry.type : 'single',
          at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0
        };
      }
      return normalized;
    },
    getAnswerCache(key) {
      if (!key) return null;
      return this.readAnswerCache()[key] || null;
    },
    setAnswerCache(key, entry) {
      const answer = typeof entry?.answer === 'string' ? entry.answer.trim() : '';
      if (!key || !answer) return false;
      const all = this.readAnswerCache();
      all[key] = {
        answer,
        type: typeof entry?.type === 'string' && entry.type ? entry.type : 'single',
        at: Number.isFinite(Number(entry?.at)) ? Number(entry.at) : Date.now()
      };
      // 上限 300 条：按 at 升序排，只留最新的 300 条，最旧的先淘汰。
      // 排序后重建对象，保证淘汰结果直接写回，不会因为键顺序残留旧条目。
      const sorted = Object.entries(all).sort((a, b) => a[1].at - b[1].at);
      const trimmed = {};
      for (const [cacheKey, cacheEntry] of sorted.slice(Math.max(0, sorted.length - ANSWER_CACHE_LIMIT))) {
        trimmed[cacheKey] = cacheEntry;
      }
      return storeSafe.set(ANSWER_CACHE_KEY, JSON.stringify(trimmed));
    },
    clearAnswerCache() {
      return storeSafe.remove(ANSWER_CACHE_KEY);
    },
  };

  // 启动时同步一次播放设置：Utils.getDDL 会用 Config.playbackRate 估算最长等待时间
  Y.Config.playbackRate = Store.getPlaybackConf().playbackRate;

  // 3.2.1 起不再支持通义千问，清掉旧版本留下的配置
  try {
    localStorage.removeItem('ykt_qwen_conf');
  } catch (_) {}

  Y.storeSafe = storeSafe;
  Y.Store = Store;
})(Y);
