((Y) => {
  // 平台进度接口层（YktApi）

  const YktApi = {
    disabled: false,
    failures: 0,
    cache: new Map(),   // 课程目录（含每节进度）
    ctxCache: new Map(), // classroomId -> {courseId, userId}
    universityId: '',   // 站点的全局 axios 拦截器会注入 university-id / uv-id，缺了后端可能直接 4xx
    DIR_TTL: 12000,
    CTX_TTL: 30 * 60 * 1000,

    get enabled() {
      return !this.disabled && typeof window !== 'undefined' && typeof window.fetch === 'function';
    },

    reset() {
      this.disabled = false;
      this.failures = 0;
      this.cache.clear();
      this.ctxCache.clear();
    },

    readCookie(name) {
      try {
        const hit = String(document.cookie || '')
          .split(';')
          .map(part => part.trim())
          .find(part => part.startsWith(`${name}=`));
        return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
      } catch (_) {
        return '';
      }
    },

    // 租户 id 的取值源：站点自己的全局 axios 拦截器是按
    // uv-id → uv_id → university-id → university_id 顺序取 cookie，再退回 window.uv_id。
    // 只试 university_id 一个名字的话，真实 cookie 叫 uv-id 时头就白带了（后端只认头时整批 4xx）。
    resolveUniversityId() {
      for (const name of ['uv-id', 'uv_id', 'university-id', 'university_id']) {
        const value = this.readCookie(name);
        if (value) return value;
      }
      try {
        // 整脚本在 jsdom/浏览器里跑时 unsafeWindow 已由 @grant 注入；切片跑在 Node 原生 realm 时用 typeof 守卫
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow.uv_id) {
          return String(unsafeWindow.uv_id);
        }
      } catch (_) { }
      try {
        if (typeof window !== 'undefined' && window.uv_id) return String(window.uv_id);
      } catch (_) { }
      return this.universityId || '';
    },

    // 站点自己的这 4 个请求都带 university-id / uv-id / xt-agent / xtbz（有的还带 classroom-id、
    // x-csrftoken），是全局 axios 拦截器注入的。原样带上，免得后端不认 cookie 时整批 4xx。
    buildHeaders(classroomId = '') {
      const headers = { Accept: 'application/json, text/plain, */*', 'xt-agent': 'web', 'xtbz': 'cloud' };
      const uni = this.resolveUniversityId();
      if (uni) {
        headers['university-id'] = String(uni);
        headers['uv-id'] = String(uni);
      }
      const csrf = this.readCookie('csrftoken');
      if (csrf) headers['x-csrftoken'] = csrf;
      if (classroomId) headers['classroom-id'] = String(classroomId);
      return headers;
    },

    // 失败一律吞掉返回 null：脚本的主链路是点页面，接口只是「更准的进度尺」，
    // 绝不能让一次 404/超时把刷课流程拖死。
    // opts.method / opts.body 只在「主动补记」（图文兜底）时用到，缺省还是 GET。
    async request(url, timeoutMs = 8000, classroomId = '', opts = {}) {
      if (!this.enabled) return null;
      let timer = null;
      try {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const headers = this.buildHeaders(classroomId);
        const init = { credentials: 'include', headers };
        const method = String(opts.method || 'GET').toUpperCase();
        if (method !== 'GET') {
          init.method = method;
          // 抓包里 add_study_leaf 就是这个 content-type（站点自己的 axios 全局头）
          headers['Content-Type'] = 'application/json;charset=UTF-8';
          headers['x-requested-with'] = 'XMLHttpRequest';
          init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body || {});
        }
        if (controller) {
          init.signal = controller.signal;
          timer = setTimeout(() => {
            try { controller.abort(); } catch (_) { }
          }, timeoutMs);
        }
        const response = await window.fetch(url, init);
        if (!response || !response.ok) throw new Error(`HTTP ${response ? response.status : 'no-response'}`);
        const text = await response.text();
        const json = Y.Utils.safeJSONParse(text, null);
        if (!json) throw new Error('响应不是 JSON');
        this.failures = 0;
        return json;
      } catch (err) {
        this.failures += 1;
        if (this.failures >= 3) {
          this.disabled = true;
          Y.Utils._pollLog?.(`平台进度接口连续 ${this.failures} 次读不到（${err?.message || err}），本次改为只看页面标记`);
        }
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    // 图文（leaf_type=3）到底算不算「学完」，站点自己有专门的接口，比翻整个课程目录准也快得多。
    // 抓包实证（docs/图文页面-取证.md）：进一节图文后 0.3 秒内页面自己就打完了这三步 ——
    //   POST /c27/online_courseware/xty/instance/add_study_leaf/  {leaf_id, classroom_id} → {ok:true}
    //   GET  /mooc-api/v1/lms/learn/user_article_finish/{leafId}/?cid=&sid=   → {data:{}}
    //   GET  /mooc-api/v1/lms/learn/user_article_finish_status/{leafId}/      → {data:{finish:1}}
    // 三个从未看过的图文都是 0.3 秒完成、零滚动、零阅读时长 —— 「点开即完成」是平台口径，不是脚本猜的。
    async articleStatus(leafId) {
      if (!leafId) return null;
      const json = await this.request(
        `/mooc-api/v1/lms/learn/user_article_finish_status/${encodeURIComponent(String(leafId))}/`,
        6000
      );
      const data = json?.data;
      if (!data || typeof data !== 'object') return null;
      const finish = Number(data.finish);
      return {
        finish: Number.isFinite(finish) ? finish : null,
        done: Number(data.finish) >= 1
      };
    },

    // 兜底：页面自己没上报时，把页面那两步自己打一遍（同一个站点、同一套 cookie，不伪造任何字段）。
    // 先只打 add_study_leaf（POST，明确的写入方；视频节打它返回 ok:false，正好不会误伤视频），
    // 读一次状态仍然没完成才补 user_article_finish —— 这样真机上能一眼看出是哪一步把状态翻过来的。
    async markArticleDone(classroomId, leafId) {
      const cid = String(classroomId || '');
      const vid = String(leafId || '');
      if (!cid || !vid) return { ok: false, step: '' };
      const ctx = await this.classroomContext(cid);
      // 真实站点这两个 id 都是数字，但夹具里可能是 'leaf-2' 这种字符串：
      // Number('leaf-2') 是 NaN，JSON.stringify 会把它变成 null，后端收到 {"leaf_id":null} 直接废掉。
      // 所以非纯数字就原样发字符串。
      const asId = value => {
        const numeric = Number(value);
        return Number.isFinite(numeric) && String(value).trim() !== '' ? numeric : String(value);
      };
      const study = await this.request(
        '/c27/online_courseware/xty/instance/add_study_leaf/',
        8000,
        cid,
        { method: 'POST', body: { leaf_id: asId(vid), classroom_id: asId(cid) } }
      );
      const studyOk = study?.data?.ok === true;
      const before = await this.articleStatus(vid);
      if (before && before.done) return { ok: true, step: 'add_study_leaf', studyOk };
      if (ctx && ctx.courseId) {
        await this.request(
          `/mooc-api/v1/lms/learn/user_article_finish/${encodeURIComponent(vid)}/`
          + `?cid=${encodeURIComponent(ctx.courseId)}&sid=${encodeURIComponent(ctx.skuId || '')}`,
          8000,
          cid
        );
      }
      const after = await this.articleStatus(vid);
      return { ok: Boolean(after && after.done), step: 'user_article_finish', studyOk };
    },

    // 视频记账接口要 cid(课程 id) 和 user_id，这两个只在课堂信息/用户信息里，缓存半小时
    async classroomContext(classroomId) {
      const key = String(classroomId || '');
      if (!key) return null;
      const hit = this.ctxCache.get(key);
      if (hit && Date.now() - hit.at < this.CTX_TTL) return hit.value;
      const value = { courseId: '', userId: '', skuId: '' };
      const info = await this.request(`/v2/api/web/classrooms/${encodeURIComponent(key)}?role=5`, 8000, key);
      const courseId = info?.data?.course_id;
      if (courseId) value.courseId = String(courseId);
      // sku_id 是用户_article_finish 的 sid 参数（抓包：sid 与 free_sku_id 同值）
      const skuId = info?.data?.free_sku_id || info?.data?.sku_id;
      if (skuId) value.skuId = String(skuId);
      // uv_id 就是 university-id/uv-id 的值，拿到后后面所有请求都带上
      if (info?.data?.uv_id) this.universityId = String(info.data.uv_id);
      const user = await this.request('/v2/api/web/userinfo');
      const uid = user?.data?.[0]?.user_id;
      if (uid) value.userId = String(uid);
      if (!value.courseId || !value.userId) return null;
      this.ctxCache.set(key, { at: Date.now(), value });
      return value;
    },

    // 课程目录 + 每节平台进度。返回顺序必须与侧栏渲染一致：
    // 章内「直接挂的小节」按 order 在前，随后各 section 按 order、section 内再按 order 展开。
    // （用「抓包/页面下载/学习空间.html」的 131 个 .nav-item-leaf-box 逐项核对过，0 失配）
    async directory(classroomId, { force = false } = {}) {
      const key = `dir:${classroomId}`;
      const hit = this.cache.get(key);
      if (!force && hit && Date.now() - hit.at < this.DIR_TTL) return hit.value;
      const json = await this.request(
        `/c27/online_courseware/schedule/course/progress/?classroom_id=${encodeURIComponent(String(classroomId || ''))}`,
        12000,
        String(classroomId || '')
      );
      const chapters = json?.data?.course_progress;
      if (!Array.isArray(chapters) || !chapters.length) return null;
      const value = this.flattenDirectory(chapters);
      if (!value.length) return null;
      this.cache.set(key, { at: Date.now(), value });
      return value;
    },

    flattenDirectory(chapters) {
      const byOrder = (a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0);
      const out = [];
      for (const chapter of chapters) {
        const direct = [];
        const sections = [];
        for (const node of chapter?.section_leaf_list || []) {
          if (Array.isArray(node?.leaf_list)) sections.push(node);
          else if (node) direct.push(node);
        }
        direct.sort(byOrder);
        sections.sort(byOrder);
        const push = (leaf, section) => {
          const type = Number(leaf?.leaf_type);
          const progress = Number(leaf?.progress);
          // 真实站点的 leaf id 是数字（例如 12345678），但回归台/夹具用的是 'leaf-2' 这种字符串；
          // 以前这里一律 Number()，非数字就被压成 NaN，于是 leafProgress() 在回归台永远返回 null
          // —— 接口进度这条路等于从来没被测到（全跑去读观看日志/侧栏了）。非数字就原样保留。
          const rawId = leaf?.id;
          const numericId = Number(rawId);
          out.push({
            index: out.length,
            id: Number.isFinite(numericId) && String(rawId).trim() !== '' ? numericId : rawId,
            name: Y.AiWorkspace.normalizeText(leaf?.name || ''),
            type,
            kind: Y.LEAF_KIND[type] || 'other',
            progress: Number.isFinite(progress) ? progress : 0,
            chapter: Y.AiWorkspace.normalizeText(chapter?.name || ''),
            section: Y.AiWorkspace.normalizeText(section?.name || '')
          });
        };
        for (const leaf of direct) push(leaf, null);
        for (const section of sections) {
          for (const leaf of (section.leaf_list || []).slice().sort(byOrder)) push(leaf, section);
        }
      }
      return out;
    },

    // 单节进度（0..1）。找不到这一节返回 null（例如 extend/self-test 这类导航节点）。
    async leafProgress(classroomId, leafId, { force = false } = {}) {
      const list = await this.directory(classroomId, { force });
      if (!list) return null;
      const hit = list.find(item => String(item.id) === String(leafId));
      return hit ? hit.progress : null;
    },

    // 单视频记账进度。rate 就是课程目录里那个 progress，watch_length/video_length 是它的来源。
    async videoProgress(classroomId, leafId) {
      const ctx = await this.classroomContext(classroomId);
      if (!ctx) return null;
      const url = `/video-log/get_video_watch_progress/?cid=${ctx.courseId}&user_id=${ctx.userId}`
        + `&classroom_id=${encodeURIComponent(String(classroomId))}`
        + '&video_type=video&vtype=rate'
        + `&video_id=${encodeURIComponent(String(leafId))}`
        + '&snapshot=1&no_loading=true';
      const json = await this.request(url, 8000, String(classroomId));
      const data = json?.data;
      if (!data) return null;
      const entry = data[String(leafId)] || data[leafId];
      if (!entry) return null;
      const rate = Number(entry.rate);
      return {
        rate: Number.isFinite(rate) ? rate : null,
        videoLength: Number(entry.video_length) || 0,
        watchLength: Number(entry.watch_length) || 0,
        lastPoint: Number(entry.last_point) || 0,
        completed: Boolean(entry.completed)
      };
    },

    // 视频观看日志：/video-log/detail/ 返回 heartbeat.result（已观看区间的并集），
    // 这是唯一能回答「哪一段没看」的接口 —— get_video_watch_progress 只给一个 rate。
    // 同源 GET，站点自己的「视频观看日志」弹窗就是这个请求；参数只要
    // classroom_id / user_id / video_id，响应壳是 {msg, data, success}（和 course/progress 的
    // {code, data} 不一样，两种壳这里都容错）。
    async videoLog(classroomId, leafId) {
      const cid = String(classroomId || '');
      const vid = String(leafId || '');
      if (!cid || !vid) return null;
      const ctx = await this.classroomContext(cid);
      if (!ctx || !ctx.userId) return null;
      const url = '/video-log/detail/'
        + `?classroom_id=${encodeURIComponent(cid)}`
        + `&user_id=${encodeURIComponent(ctx.userId)}`
        + `&video_id=${encodeURIComponent(vid)}`;
      const json = await this.request(url, 8000, cid);
      const data = json?.data;
      const heartbeat = data?.heartbeat;
      if (!heartbeat || typeof heartbeat !== 'object') return null;
      const length = Number(heartbeat.video_length) || 0;
      const intervals = Y.VideoLedger.normalize(heartbeat.result, length);
      const gaps = Y.VideoLedger.gaps(intervals, length);
      const rate = Number(heartbeat.rate);
      return {
        rate: Number.isFinite(rate) ? rate : null,
        videoLength: length,
        completed: Boolean(heartbeat.completed),
        // 快照之后 result 不再更新，这时候补播也不会改变「最终完成度」
        snapshot: Boolean(data?.is_snapshot),
        intervals,
        gaps,
        gapSeconds: Y.VideoLedger.seconds(gaps),
        coveredSeconds: Y.VideoLedger.seconds(intervals),
        lastPoint: Number(heartbeat.last_point) || 0,
        cumulative: Number(heartbeat.cumulative_watch_length) || 0,
        source: 'detail'
      };
    }
  };

  Y.YktApi = YktApi;
})(Y);
