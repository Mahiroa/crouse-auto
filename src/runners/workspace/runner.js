((Y) => {
  // 学习空间刷课主流程（AiWorkspaceRunner）

  // ---- ai-workspace 新版学习空间 ----

  // 脚本能自己搞定的小节类型。不在表里的（考试、扩展节点、导航节点）脚本不代做：
  // 收尾时它们算「需要你手动完成」，不能算「没找到下一节」，更不能算「没刷完」。
  const AUTO_KINDS = new Set(['video', 'audio', 'graph', 'forum', 'exercise', 'quiz', 'pdf']);

  class AiWorkspaceRunner {
    constructor(panel) {
      this.panel = panel;
      this.finished = false;      // 已经刷完/已交接给父窗口
      this.currentIndex = -1;     // 当前处理到侧栏第几项（0 基），-1 表示还没定位到
      this.lastMedia = null;      // 上一节用过的媒体元素，用来识别“播放器还没换集”
      this.lastMediaInfo = null;  // 接管 lastMedia 时的 { leafId, nodeId, src, at }
      this.mediaEpoch = 0;        // 播放器换源计数：被接管的元素派发 emptied/loadstart 时 +1
      this.lastMediaEpoch = 0;    // 接管 lastMedia 时的 epoch 快照
      this.watchedMedia = null;   // 当前正在监听换源的媒体元素
      this.mediaSourceBump = null;
      this.handled = new Set();   // 本轮已经点进去过的章节，避免回绕时重播
      this.skipped = new Set();   // 已判定完成、只记一次日志的章节
      this.blockedByHumanCheck = false; // 导航被安全核验拦下：置位后整轮安全停住，不再试下一节
      this.plan = null;           // 课程目录（含每节平台进度），来自 YktApi.directory()
      this.planVerified = false;  // 目录顺序与侧栏逐项对上了才敢用 index 直接定位
      this.priorityTarget = null; // 「先补没刷完的」目标侧栏下标；用一次就清
      this.creditSkipped = new Set(); // 补刷后平台仍未记满的节，收尾时汇总
      this.planDriftNoted = false;    // 侧栏与目录错位只提示一次
      this.planMismatchNoted = false; // 「平台说满了、侧栏圆环还没满」只提示一次
      this.lastOpenFailure = '';      // openLeaf 最近一次失败原因：收尾时用它区分「进不去」和「没刷完」
      this.manualNoted = new Set();   // 需要手动完成的小节（考试等）只记一次
      this.endReported = false;       // 已经给过「刷完 / 卡住」结论，不重复弹窗
    }

    getExerciseQuestionLabel(root) {
      const tabs = Y.AiWorkspace.getExerciseQuestionTabs(root);
      const active = tabs.find(tab => /active|current|selected|is-active/.test(tab.className));
      return Y.AiWorkspace.normalizeText(active?.innerText || '');
    }

    // 获取要跳转回去的目标地址。
    // 只有「由目录页开出来的标签页」才回父窗口；直接在 ai-workspace 点开始刷课时
    // window.opener 为空，必须走页内推进，否则播完一节就停住不动。
    getReturnUrl() {
      const pending = Y.Store.getPendingAutoStart();
      const route = Y.AiWorkspace.getRoute();
      if (!pending || !route) return '';
      if (pending.classroomId !== route.classroomId) return '';
      if (!pending.returnUrl) return '';
      if (!this.getSourceWindow()) return '';
      return pending.returnUrl;
    }

    // ---- 侧栏课程列表 ----
    // 每次都重新读，避免拿着被 Vue 重渲染换掉的旧节点去点
    getLeafList() {
      const boxes = [...document.querySelectorAll('.nav-item-leaf-box')];
      if (boxes.length) return boxes.filter(box => box.firstElementChild);
      // 兜底：没包外层盒子时直接按 .leaf-item 的父节点当一项
      return [...document.querySelectorAll('.leaf-item')].map(el => el.parentElement).filter(Boolean);
    }

    getLeafTitle(box) {
      // 真实站点标题在 .leaf-item-title 里，单独取不会把「图文」标签和状态混进标题
      const label = Y.AiWorkspace.leafLabel(box);
      if (label) return (this.normalizeLeafTitle(label) || label).slice(0, 60);
      const leaf = box?.querySelector('.leaf-item') || box;
      const text = Y.AiWorkspace.normalizeText(leaf?.innerText || box?.innerText || '');
      return (this.normalizeLeafTitle(text) || text).slice(0, 60);
    }

    // 去掉“已完成/进行中/100%”这类状态词，标题才稳定可比
    normalizeLeafTitle(text) {
      return Y.AiWorkspace.normalizeText(text)
        .replace(/(已完成|未完成|已读|未读|未开始|进行中|100%|99%|98%)/g, '')
        .trim();
    }

    getLeafKey(box, index) {
      return `${index}|${this.getLeafTitle(box)}`;
    }

    // 真正能触发跳转的元素：leaf-item 本身，其次是里面的链接
    getLeafClickTarget(box) {
      if (!box) return null;
      return box.querySelector('.leaf-item')
        || box.querySelector('a[href]')
        || box.firstElementChild
        || box;
    }

    isLeafActive(box) {
      if (!box) return false;
      if (box.classList.contains('is-active') || box.getAttribute('aria-current') === 'true') return true;
      return Boolean(box.querySelector('.is-active'));
    }

    getActiveIndex(list = this.getLeafList()) {
      const index = list.findIndex(box => this.isLeafActive(box));
      if (index >= 0) return index;
      // 侧栏偶尔会短暂失去 is-active（Vue 重渲染/切集动画），用 URL 上的节点标识兜底
      const route = Y.AiWorkspace.getRoute();
      const key = route?.nodeId || route?.leafId || '';
      if (key) {
        const attrs = ['data-node-id', 'data-id', 'data-key', 'node-id'];
        const byAttr = list.findIndex(box => [box, ...box.querySelectorAll('[data-node-id], [data-id], [data-key], [node-id]')]
          .some(el => attrs.some(attr => String(el?.getAttribute?.(attr) || '') === key)));
        if (byAttr >= 0) return byAttr;
      }
      return this.currentIndex;
    }

    stepSnapshot() {
      const route = Y.AiWorkspace.getRoute();
      return {
        href: location.href,
        leafId: route?.leafId || '',
        nodeId: route?.nodeId || '',
        title: this.normalizeLeafTitle(Y.AiWorkspace.getActiveLeafTitle())
      };
    }

    // 页面是否还停留在同一节（平台自己跳到下一节时返回 false）。
    // 只比 leafId/nodeId/标题：整段 href 里的无关 query 变化会把它误判成“已经跳走”
    sameStep(snapshot) {
      if (!snapshot) return true;
      const now = this.stepSnapshot();
      if (snapshot.nodeId && now.nodeId && snapshot.nodeId !== now.nodeId) return false;
      if (snapshot.leafId && now.leafId && snapshot.leafId !== now.leafId) return false;
      if (snapshot.title && now.title && snapshot.title !== now.title) return false;
      return true;
    }

    // 主循环：处理当前这一节 → 校验是否真的进入了下一节 → 继续处理，直到没有未完成项
    async run(preventScreenCheckSwitch = true) {
      // 仅开启一次防切屏
      if (preventScreenCheckSwitch) Y.preventScreenCheck();
      if (this.finished) return;
      // 开跑先审目录：用户反馈「视频进度没刷满」，先把已经刷了一半的补掉再往后走
      try {
        await this.auditDirectory();
      } catch (err) {
        this.panel.warn(`读取课程目录失败（${err?.message || err}），按侧栏图标继续`);
      }
      // 当前停在的那一节未必是最该补的：先跳到目录里最靠前的未完成小节
      try {
        if (await this.jumpToPriority()) {
          await Y.Utils.sleep(600);
        }
      } catch (err) {
        this.panel.warn(`跳到待补小节失败（${err?.message || err}），从当前这一节继续`);
      }
      for (let round = 0; round < 300; round++) {
        const route = Y.AiWorkspace.getRoute();
        if (!route) {
          this.panel.log('当前页面已离开 ai-workspace/lms-graph');
          this.resetRunButton('继续刷课');
          return;
        }
        if (!route.leafId) {
          this.panel.log('未能识别当前知识点');
          this.resetRunButton('继续刷课');
          return;
        }
        this.currentIndex = this.getActiveIndex();
        const before = this.stepSnapshot();
        const ok = await this.handleStep(route);
        if (this.finished) return;
        if (this.blockedByHumanCheck) {
          // 导航类点击已被安全核验拦下，提示与 skip 记录都在 openLeaf/noteVerificationBlock 里；
          // 这里直接停住，绝不在目录页上继续点下一节或 history.back()。
          return;
        }
        if (!ok) {
          this.panel.warn('当前内容未播放完成，停留在本节');
          this.resetRunButton('继续刷课');
          return;
        }
        // 平台自己跳到下一节时不要再点侧栏，否则会白白漏掉一节
        if (!this.sameStep(before)) {
          this.panel.log('页面已自动切到下一项，继续处理');
          await Y.Utils.sleep(800);
          continue;
        }
        // 记下刚处理完的这一节，回绕查找时不会把它再播一遍
        const listAfter = this.getLeafList();
        const indexAfter = this.getActiveIndex(listAfter);
        if (indexAfter >= 0 && listAfter[indexAfter]) {
          this.handled.add(this.getLeafKey(listAfter[indexAfter], indexAfter));
        }
        const advanced = await this.moveToNext(route);
        if (this.finished) return;
        if (!advanced) return;
      }
      this.panel.warn('连续处理次数超出上限，已停下，请刷新页面后重新开始');
      this.resetRunButton('继续刷课');
    }

    // 按类型处理当前项；失败时重挂一次播放器再试，别一次失败就整条链停住
    async handleStep(route) {
      const key = `${route.leafId}|${route.nodeId || ''}`;
      const kind = Y.AiWorkspace.routeKind(route.type);
      const mediaKind = kind === 'video' || kind === 'audio';
      let ok = false;
      // 媒体节照样保留 2 次尝试：换集后播放器晚挂载是常态，一次没就绪就直接判死会漏刷一节。
      // 但重试前的停顿要短：播放器重挂是毫秒级的事，等 1.5~3 秒只会错过它自己加载好的时机；
      // 图文/讨论/作业的失败多是接口慢，维持原来的停顿。
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        if (attempt > 1) {
          this.panel.log(`当前内容没有处理成功，重试 ${attempt}/2`);
          await Y.Utils.humanPause(mediaKind ? 300 : 1500, mediaKind ? 600 : 3000);
          await this.reopenCurrentLeaf();
        }
        if (mediaKind) {
          ok = await this.handleMedia(route);
        } else if (kind === 'exercise') {
          ok = await this.handleExercise(route);
        } else if (kind === 'forum') {
          ok = await this.handleForum(route);
        } else if (kind === 'graph' || kind === 'pdf' || kind === 'quiz') {
          // 图文 / PDF / 测验：平台口径是「点开即完成」，不再记成「暂不自动处理」
          ok = await this.handleOpenLeaf(route, kind);
        } else {
          // node/extend/self-test 这类是导航节点，考试是「不代做」：说清楚，别写成「不支持」，
          // 也别让用户以为脚本漏了一节。
          const box = this.activeBox();
          const title = Y.AiWorkspace.getActiveLeafTitle() || route.type;
          const tag = Y.AiWorkspace.leafTag(box);
          const manual = this.isManualSection({
            title,
            tag,
            kind: Y.AiWorkspace.kindFromTag(tag) || (route.type === 'exam' ? 'other' : '')
          });
          this.panel.log(manual
            ? `当前是「${title}」这类需要手动完成的内容，脚本不代做，直接看下一节`
            : `当前是「${route.type}」导航节点，不是可学习小节，直接看下一节`);
          this.panel.track({
            id: manual ? `manual-${route.leafId || route.type}` : `nav-${route.leafId || route.type}`,
            kind: 'course',
            title,
            status: 'skip',
            detail: manual ? '需要手动完成（考试/非自动小节）' : '导航节点，非学习内容'
          });
          await Y.Utils.sleep(manual ? 400 : 1200);
          ok = true;
        }
      }
      return ok;
    }

    // 重新点一次当前章节，让播放器重新挂载（媒体元素丢了/卡住时用）
    async reopenCurrentLeaf() {
      const list = this.getLeafList();
      const index = this.getActiveIndex(list);
      const box = index >= 0 ? list[index] : null;
      if (!box) return;
      try {
        this.getLeafClickTarget(box)?.click();
      } catch (_) {}
      await Y.Utils.sleep(1500);
    }

    // 当前这一节结束后：先考虑跨标签页交接，再退回页内推进
    async moveToNext(route) {
      const returnUrl = this.getReturnUrl();
      if (returnUrl) {
        const handed = await this.returnToSource(returnUrl);
        if (handed) {
          this.finished = true;
          return false;
        }
        this.panel.log('父窗口不可用，改为在这个页面继续进入下一节');
      }
      return this.goToNextLeaf(route);
    }

    // 页内推进到下一节：按侧栏顺序找下一个未完成章节，点进去并确认真的切过去了。
    // 一圈走完之后的三种结局必须分开（用户反馈的就是这里：明明刷完了却报「没找到下一节」）：
    //   ① 平台上没有剩下要刷的 → 刷完：撒花 + 弹窗；
    //   ② 只剩考试/扩展节点这类脚本不代做的 → 也算刷完，弹窗里点名让用户手动完成；
    //   ③ 还有能自动学的小节没记满 → 这不是刷完，明确报「还差哪几节」，别用刷完的口吻。
    async goToNextLeaf(route) {
      const list = this.getLeafList();
      if (!list.length) {
        // 侧栏没列表既不是「刷完」也不是「没有下一节」：多半是章节被折叠了，让用户展开
        this.panel.warn('侧栏里没找到课程列表（章节可能被折叠）：展开目录或刷新页面后再点「继续刷课」');
        this.resetRunButton('继续刷课');
        return false;
      }
      let currentIndex = this.getActiveIndex(list);
      if (currentIndex < 0) currentIndex = this.currentIndex;
      // 「先补没刷完的」：本轮第一次推进从最靠前的未完成小节开始，补到那里之后才恢复前向顺序
      const begin = Number.isInteger(this.priorityTarget) && this.priorityTarget >= 0
        ? Math.min(this.priorityTarget, list.length - 1)
        : currentIndex + 1;
      this.priorityTarget = null;
      const order = [];
      for (let i = begin; i < list.length; i++) order.push(i);
      for (let i = 0; i < Math.min(begin, list.length); i++) order.push(i);
      let hasUnhandled = false;
      const unreachable = []; // 本轮真的点不动的节：{ index, key, title, tag, kind, reason }
      for (const index of order) {
        // 上一节已因安全核验停住：继续遍历只会在核验弹窗上反复点，直接结束这一轮
        if (this.blockedByHumanCheck) return false;
        const box = list[index];
        if (!box || !box.isConnected) continue;
        const title = this.getLeafTitle(box);
        const key = this.getLeafKey(box, index);
        const tag = Y.AiWorkspace.leafTag(box);
        const sectionKind = Y.AiWorkspace.kindFromTag(tag) || 'course';
        // 原地重播没有意义（只有一节课时才允许）
        if (index === currentIndex && list.length > 1) continue;
        if (this.isPlanDone(index, box)) {
          if (!this.skipped.has(key)) {
            this.skipped.add(key);
            this.panel.log(`${title} 已经完成，跳过`);
            this.panel.track({
              id: `ai-leaf-${key}`,
              kind: sectionKind,
              title,
              status: 'done',
              detail: '已完成，跳过'
            });
          }
          continue;
        }
        if (this.handled.has(key)) continue;
        // 考试这类脚本不代做的小节：不点、不算「没找到下一节」，只记一条「需要手动完成」
        if (this.isManualSection({ title, tag, kind: sectionKind })) {
          this.noteManualSection({ key, title, tag, kind: sectionKind });
          continue;
        }
        hasUnhandled = true;
        if (await this.openLeaf(box, index)) return true;
        unreachable.push({
          index,
          key,
          title,
          tag,
          kind: sectionKind,
          reason: this.lastOpenFailure || '切换失败'
        });
      }
      if (hasUnhandled) return this.endOfSidebar(unreachable);
      return this.finishAll();
    }

    // 脚本不代做的小节：考试（不代考）、目录里的 other 类（扩展 / 导航 / 自测）。
    // 它们在收尾里既不算「没刷完」，也不算「没找到下一节」，而是在弹窗里点名让用户自己处理。
    isManualSection(section) {
      const tag = String(section?.tag || '');
      const title = String(section?.title || '');
      if (/考试/.test(tag)) return true;
      if (/期末考试|期中考试|结课考试|补考/.test(title)) return true;
      const kind = String(section?.kind || '');
      if (!kind || kind === 'course') return false;
      return !AUTO_KINDS.has(kind);
    }

    // 需要手动完成的小节只记一次，免得每圈都往刷课轨迹里塞同一条
    noteManualSection(section) {
      // 键统一按标题归一：同一个小节可能从侧栏（带下标）和平台目录（不带下标）各来一次
      const key = this.sectionName(section?.title || section?.key || '');
      if (!key || this.manualNoted.has(key)) return;
      this.manualNoted.add(key);
      const title = section?.title || '需要手动完成的小节';
      this.panel.log(`「${title}」脚本不代做（考试/非自动小节），留给你手动完成`);
      this.panel.track({
        id: `manual-${key}`,
        kind: 'course',
        title,
        status: 'skip',
        detail: '需要手动完成（考试/非自动小节）'
      });
    }

    sectionName(value) {
      return String(value || '').replace(/[\u200b\s]/g, '');
    }

    sameSectionName(a, b) {
      const left = this.sectionName(a);
      const right = this.sectionName(b);
      return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
    }

    // 平台目录里还没记满的节（接口不可用时退回侧栏三态），收尾判定统一走这里。
    // 返回值带 source：'api' 是平台记账（可当结论用），'dom' 只是侧栏图标（只能当参考，
    // 侧栏本身会滞后一整节，拿它报「没刷完」会误伤刚播完的最后一节）。
    async pendingSections() {
      const api = this.platformApi();
      const classroomId = this.currentClassroomId();
      let list = null;
      if (api && api.enabled && classroomId && typeof api.directory === 'function') {
        try {
          list = await api.directory(classroomId, { force: true });
        } catch (_) {
          list = null;
        }
      }
      if (Array.isArray(list) && list.length) {
        this.plan = list;
        return {
          source: 'api',
          items: list
            .filter(item => item.progress < Y.DONE_RATE)
            .map(item => ({ index: item.index, title: item.name, kind: item.kind, tag: '', progress: item.progress }))
        };
      }
      const items = this.getLeafList()
        .map((box, index) => ({ box, index }))
        .filter(item => item.box && item.box.isConnected && !Y.AiWorkspace.isLeafMarkedDone(item.box))
        .map(item => ({
          index: item.index,
          title: this.getLeafTitle(item.box),
          kind: Y.AiWorkspace.kindFromTag(Y.AiWorkspace.leafTag(item.box)) || 'course',
          tag: Y.AiWorkspace.leafTag(item.box),
          progress: null
        }));
      return { source: 'dom', items };
    }

    // 侧栏走完一圈之后的收口：先分清「其实已经刷完」和「真的还差几节」
    async endOfSidebar(unreachable) {
      const { source, items: pending } = await this.pendingSections();
      const manual = [];
      const blocked = [];
      const hardBlocked = new Set();
      for (const item of pending) {
        if (this.isManualSection(item)) manual.push(item);
        else blocked.push(item);
      }
      for (const item of unreachable) {
        if (this.isManualSection(item)) {
          this.noteManualSection(item);
          if (!manual.some(section => this.sameSectionName(section.title, item.title))) manual.push(item);
        } else if (!pending.some(section => this.sameSectionName(section.title, item.title))) {
          // 平台目录里没有它（目录被折叠/对不上），但它是可自动学的小节，就得算没刷完
          blocked.push(item);
          hardBlocked.add(item);
        }
      }
      // 只有侧栏图标这一条证据时（接口不可用），「没打勾」不一定是没刷完：侧栏会落后一整节，
      // 刚播完的最后一节经常还没同步。这时只认「真的点不进去」的那几节。
      if (source === 'dom') {
        const keep = blocked.filter(item => hardBlocked.has(item));
        blocked.length = 0;
        blocked.push(...keep);
      }
      if (!blocked.length) return this.finishAll({ manual });
      return this.reportDeadEnd(blocked, unreachable);
    }

    // 「真的还差几节」：明说不是刷完，并把按钮复位成可再点的「继续刷课」。
    // 以前这里只 warn 一句「请手动点一次后再点开始刷课」，按钮却还卡在「刷课中…」，
    // 用户再点只会被当成重复启动忽略掉。
    reportDeadEnd(blocked, unreachable) {
      const describe = item => `${item.title}（${item.progress == null ? '进度读不到' : Y.pctText(item.progress)}）`;
      const head = blocked.slice(0, 4).map(describe).join('、');
      const stuck = (unreachable || [])
        .filter(item => !this.isManualSection(item))
        .slice(0, 3)
        .map(item => `${item.title}：${item.reason}`)
        .join('、');
      this.panel.warn(`平台还差 ${blocked.length} 节没记满，这次不是刷完：${head}${blocked.length > 4 ? '…' : ''}`);
      if (stuck) this.panel.log(`进不去的小节：${stuck}`);
      this.panel.log('处理好（展开目录 / 手动点一次 / 等平台补记账）后点「继续刷课」，会从最靠前的未完成节接着刷');
      this.resetRunButton('继续刷课');
      Y.Store.clearPendingAutoStart();
      return false;
    }

    resetRunButton(text) {
      try {
        this.panel.resetStartButton(text);
      } catch (_) {}
    }

    // 目录与侧栏逐项对上时用平台进度判断（侧栏图标会滞后一整节）；
    // 对不上才退回原来的「侧栏三态」判断。
    isPlanDone(index, box) {
      if (this.planVerified && Array.isArray(this.plan) && this.plan[index]) {
        const item = this.plan[index];
        // 运行中侧栏可能被折叠/重排，下标会错位：标题对不上就不采信目录进度，
        // 否则会「按下标把别的节当成已完成」而误跳过（实测错位 1 项就会跳 5 节）。
        const expected = String(item.name || '').replace(/[\u200b\s]/g, '');
        const actual = String(Y.AiWorkspace.leafLabel(box) || '').replace(/[\u200b\s]/g, '');
        // actual 为空正是 box 被 Vue 重渲染的瞬时状态：这种时候也必须退回 DOM 判定，
        // 不能因为「比不出来」就采信 plan[index]（否则极端情况下会误跳过）
        if (expected && expected !== actual) {
          this.planVerified = false;
          if (!this.planDriftNoted) {
            this.planDriftNoted = true;
            this.panel.warn('侧栏项与课程目录对不上（章节可能被折叠/重排），本轮改用侧栏三态判断');
          }
          return Y.AiWorkspace.isLeafMarkedDone(box);
        }
        if (item.progress >= Y.DONE_RATE) {
          const domPercent = Y.AiWorkspace.leafDomPercent(box);
          if (domPercent != null && domPercent < 95 && !this.planMismatchNoted) {
            this.planMismatchNoted = true;
            this.panel.log(`平台说这一节已满（${Y.pctText(item.progress)}），侧栏圆环却还是 ${Math.round(domPercent)}%；以平台为准，跳过`);
          }
          return true;
        }
        return false;
      }
      return Y.AiWorkspace.isLeafMarkedDone(box);
    }

    // 安全核验把导航/轮询拦下时统一收口：记日志、记 skip、复位按钮并置停住标志，
    // 避免在目录页上继续 poll / history.back()（那会多退一页，之后整轮找不到课程列表）。
    noteVerificationBlock(title, stepId, detail = '安全核验，已停住') {
      this.blockedByHumanCheck = true;
      this.panel.warn(`检测到安全核验，已停在「${title}」。请手动完成核验后再点「开始刷课」`);
      this.panel.track({ id: stepId, kind: 'video', title, status: 'skip', detail });
      this.panel.resetStartButton('待核验，已停止');
    }

    // 当前页面是否处于“已开启跳过模式且核验弹窗可见”的状态
    humanCheckBlocking() {
      return Y.Utils.humanCheckMode() === 'skip' && Y.Utils.isHumanCheckVisible();
    }

    // 点开某一节，并确认页面/侧栏/标题真的切过去了
    async openLeaf(box, index) {
      const title = this.getLeafTitle(box);
      const key = this.getLeafKey(box, index);
      const tag = Y.AiWorkspace.leafTag(box);
      const sectionKind = Y.AiWorkspace.kindFromTag(tag) || 'course';
      const fail = (reason, detail) => {
        this.lastOpenFailure = reason;
        this.panel.warn(`「${title}」${detail}，先跳过这一项`);
        this.panel.track({ id: `ai-leaf-${key}`, kind: sectionKind, title, status: 'skip', detail });
        return false;
      };
      this.lastOpenFailure = '';
      const before = this.stepSnapshot();
      const target = this.getLeafClickTarget(box);
      if (!target) return fail('点击目标不可用', '没有可点的元素');
      this.panel.log(`准备进入下一节：${title}`);
      const switchStartedAt = Date.now();
      await Y.Utils.humanPause(600, 1500);
      const clicked = await this.clickLeaf(target);
      // 从这里开始才是 waitLeafSwitch 的 poll：它的墙钟最容易被后台节流放大，单独记起点
      const switchPollAt = Date.now();
      if (!clicked) {
        // clickLeaf 返回 false：元素点不到，或 humanClick 被安全核验拦下。
        // 核验场景必须立刻停住，不能换一种点击方式绕过核验、也不能继续 poll。
        if (this.humanCheckBlocking()) {
          this.noteVerificationBlock(title, `ai-leaf-${key}`, '安全核验，未进入');
          this.lastOpenFailure = '安全核验';
          return false;
        }
        this.panel.log(`点击「${title}」没有生效，换一种点击方式再试`);
      } else if (await this.waitLeafSwitch(before, box, 12000)) {
        this.markLeafEntered(box, index, title, this.switchCostMs(switchStartedAt, switchPollAt), Date.now() - switchStartedAt);
        await this.waitEnteredReady(box);
        return true;
      } else {
        // waitLeafSwitch 的 poll 也会被核验拦下（返回 false），这里同样先判断再决定是否换目标
        if (this.humanCheckBlocking()) {
          this.noteVerificationBlock(title, `ai-leaf-${key}`, '安全核验，未切换');
          this.lastOpenFailure = '安全核验';
          return false;
        }
        this.panel.log(`点击「${title}」后页面没有切换，换一种点击方式再试`);
      }
      // 一次点不动就换点击目标再试（有的版本点击事件绑在 a 或外层盒子上）
      const hardClicked = await this.clickLeaf(box.querySelector('a[href]') || box, true);
      if (!hardClicked) return fail('点击目标不可用', '点击目标不可用');
      const hardPollAt = Date.now();
      if (await this.waitLeafSwitch(before, box, 8000)) {
        this.markLeafEntered(box, index, title, this.switchCostMs(switchStartedAt, hardPollAt), Date.now() - switchStartedAt);
        await this.waitEnteredReady(box);
        return true;
      }
      if (this.humanCheckBlocking()) {
        this.noteVerificationBlock(title, `ai-leaf-${key}`, '安全核验，未切换');
        this.lastOpenFailure = '安全核验';
        return false;
      }
      return fail('切换失败', '切换失败');
    }

    markLeafEntered(box, index, title, costMs = 0, wallMs = 0) {
      this.currentIndex = index;
      this.handled.add(this.getLeafKey(box, index));
      // 切换用时同样按「有效等待」报（口径见 pollSpentMs）：wallMs 只用来判断要不要补一句
      // 「（含后台节流）」，绝不把被休眠/节流放大的秒数直接写进日志
      const note = Number(wallMs) > 0 ? this.throttleNote(wallMs, costMs) : '';
      const cost = Number(costMs) > 0 ? `，切换用时 ${(Number(costMs) / 1000).toFixed(1)} 秒${note}` : '';
      this.panel.log(`已进入：${Y.AiWorkspace.getActiveLeafTitle() || title}${cost}`);
    }

    // 原生点击探针：能点到（click 事件真的派发到元素上）返回 true，交给 openLeaf 原来的
    // waitLeafSwitch 判定链；元素不可用/事件没送达返回 false，由 clickLeaf 回落到合成事件。
    // 只做同步判定，不引入额外等待，也不改 openLeaf 的重试次数与日志语义。
    // 判据来自 Chrome 157 实测（脚本与结论见 _tmp/w2-clickleaf-facts.js 那一轮报告）：
    // disabled 元素上 .click() 会被浏览器静默丢弃、监听器一次都收不到，而 dispatchEvent 仍然送达 ——
    // 这正好是「点了没反应 → 用合成链路兜底」的客观判据，不是凭感觉回退。
    nativeClickLeaf(target) {
      if (!target || typeof target.click !== 'function') return false;
      // 已脱离文档的节点、disabled 控件：浏览器会静默丢掉这次 click，直接让位给合成链路。
      // aria-disabled=true 不是浏览器级禁用（.click() 照样派发），但组件库通常据此忽略点击，
      // 属于业务层「点了没反应」，同样交给兜底链路去送达事件。
      if (!target.isConnected) return false;
      if (target.disabled === true) return false;
      if (String(target.getAttribute?.('aria-disabled') || '') === 'true') return false;
      const doc = target.ownerDocument || document;
      let delivered = false;
      const probe = () => { delivered = true; };
      try {
        doc.addEventListener('click', probe, true);
      } catch (_) {}
      try {
        target.click();
      } catch (_) {
        return false;
      } finally {
        try { doc.removeEventListener('click', probe, true); } catch (_) {}
      }
      return delivered;
    }

    async clickLeaf(target, hard = false) {
      // 返回 boolean：openLeaf 必须能区分“点到了”和“没点到/被安全核验拦下”，
      // 否则核验时会在目录页上继续 poll 并误判切换。
      if (!target) return false;
      try { target.scrollIntoView({ block: 'nearest' }); } catch (_) {}
      if (hard) {
        // 这里是「点击学习单元」的重试路径。合成 MouseEvent 的 isTrusted 恒为 false，
        // 站点的自动化风控探针（automation-risk-probe）又确实拿 isTrusted 当判据；
        // 但 Chrome 157 实测：element.click() 和 dispatchEvent(new MouseEvent('click')) 派发的
        // click 事件 isTrusted 都是 false，只有真实输入（CDP Input 域 / 扩展 debugger）才是 true ——
        // 页面脚本无法靠换一个 click API 把 isTrusted 变真，所以这段不宣称能降 isTrusted 特征。
        // 仍然先走原生 .click() 的理由是行为更贴真人：它走浏览器的模拟点击算法，和浏览器自身一致地
        // 对不可点击元素静默丢弃，不会把事件硬塞给 disabled 节点；只有它明显打不到（元素已禁用/
        // 已脱离文档，或 click 事件根本没派发出去）时才回落到下面的合成链路兜底 ——
        // 兜底链路不能删：少数版本把处理器绑在 mousedown/mouseup 上，
        // 也有元素被业务置成 aria-disabled 但监听器还在，只有合成事件才送得进去。
        if (this.nativeClickLeaf(target)) return true;
        const view = target.ownerDocument?.defaultView || window;
        let dispatched = false;
        for (const type of ['mousedown', 'mouseup', 'click']) {
          try {
            target.dispatchEvent(new view.MouseEvent(type, { bubbles: true, cancelable: true, view, button: 0 }));
            dispatched = true;
          } catch (_) {}
        }
        return dispatched;
      }
      if (Y.Utils.isFastMode()) {
        try {
          target.click();
          return true;
        } catch (_) {
          return false;
        }
      }
      return Y.Utils.humanClick(target, 600, 1500);
    }

    async waitLeafSwitch(before, box, timeout = 12000) {
      return Y.Utils.poll(() => {
        if (before?.href && location.href !== before.href) return true;
        if (this.isLeafActive(box)) return true;
        const title = Y.AiWorkspace.getActiveLeafTitle();
        return Boolean(title && title !== before?.title);
      }, { interval: 300, timeout });
    }

    // ---- 耗时口径：有效等待 ≠ 墙钟 ----
    // 墙钟（Date.now 前后相减）会把「系统休眠 / 后台标签页定时器被冻结」的时间一起算进去：
    // 真机日志里的「切换用时 61.0 秒」「已等 59.0 秒」「等了 9783 秒」全是这么来的 —— 脚本其实只等了
    // 几秒，多出来的是浏览器把定时器按在后台不动的时间。用户看到这种数字只会以为脚本卡死了。
    // 而 poll 内部本来就是按「有效等待」累计的（短暂隐藏完全不计、长时间隐藏只算超出宽限的部分、
    // 单轮异常冻结按一个 interval 计入），所以这两个口径必须分开：日志报「有效等待」，
    // 墙钟只在两者差得多时作为「这段时间被后台节流」的旁证，不直接写进秒数。
    // lastPollSpent 是 T1 任务在 timing.js 里记的有效耗时（毫秒）；读不到或读数不可信时
    // 一律退回墙钟差值（也就是改动前的算法），不把它做成硬依赖。
    pollSpentMs(wallMs) {
      const wall = Math.max(0, Number(wallMs) || 0);
      // poll 是用 Y.Utils.poll(...) 调起来的，函数里的 this 是装配后的 Y.Utils 而不是 Y.UtilsTiming，
      // 这个读数可能落在任意一边，所以两处都读；取较大的可信值，再夹到墙钟以内
      // （比墙钟还大的只可能是上一次 poll 的残留，不能拿它报更长的耗时）。
      const spent = [Y.UtilsTiming?.lastPollSpent, Y.Utils?.lastPollSpent]
        .map(value => Number(value))
        .filter(value => Number.isFinite(value) && value > 0)
        .reduce((max, value) => Math.max(max, value), 0);
      if (!spent) return wall;
      return Math.min(spent, wall);
    }

    // 有效等待比墙钟少 5 秒以上，说明有一部分时间是被后台节流/系统休眠吃掉的：
    // 日志里补一句「（含后台节流）」，既解释了体感，又不把放大的秒数写出来
    throttleNote(wallMs, effMs) {
      return Number(wallMs) - Number(effMs) >= 5000 ? '（含后台节流）' : '';
    }

    // 切换一节 = humanPause + 点击 + waitLeafSwitch 的 poll。只有 poll 那一段会被节流放大，
    // 所以把它单独切出来：poll 之前的真实停顿照算，poll 用有效等待
    switchCostMs(switchStartedAt, pollStartedAt) {
      const preCost = Math.max(0, Number(pollStartedAt) - Number(switchStartedAt));
      const pollWall = Math.max(0, Date.now() - Number(pollStartedAt));
      return preCost + this.pollSpentMs(pollWall);
    }

    // 非媒体节（图文 / 讨论 / 作业 / PPT）根本没有播放器，别在 waitPlayerReady 上白等 6 秒：
    // 真机上这类节有 50+ 个，每个白等 6 秒就是 5 分钟起的无效耗时。
    leafNeedsMedia(box) {
      const kind = Y.AiWorkspace.kindFromTag(Y.AiWorkspace.leafTag(box));
      return !kind || kind === 'video' || kind === 'audio';
    }

    async waitEnteredReady(box) {
      if (this.leafNeedsMedia(box)) return this.waitPlayerReady();
      await Y.Utils.sleep(500);
      return true;
    }

    async waitPlayerReady(timeout = 6000) {
      const startedAt = Date.now();
      const ready = await Y.Utils.poll(() => {
        const media = Y.AiWorkspace.getMedia();
        if (!media) return false;
        const duration = Number(media.duration || 0);
        if (media.readyState < 2 || !Number.isFinite(duration) || duration <= 1) return false;
        return !this.isStaleMedia(media);
      }, { interval: 400, timeout });
      const wallMs = Date.now() - startedAt;
      // 报「有效等待」而不是墙钟：这一段的耗时经常被误当成“上一节播完后卡住”
      const costMs = this.pollSpentMs(wallMs);
      const cost = costMs / 1000;
      const note = this.throttleNote(wallMs, costMs);
      // 超过 1 秒就单独记一行，避免用户以为接口/播放器卡住却没痕迹
      if (!ready) this.panel.log(`下一节播放器还没就绪（已等 ${cost.toFixed(1)} 秒${note}），继续等它加载`);
      else if (cost >= 1) this.panel.log(`下一节播放器已就绪（等 ${cost.toFixed(1)} 秒${note}）`);
      return ready;
    }

    // 收尾：只有「平台确实没有剩下要刷的小节」才宣布刷完（撒花 + 弹窗）。
    // manual 是本次确认脚本不代做的小节（考试等），它们不进「没刷满」的统计。
    async finishAll({ manual = [] } = {}) {
      this.finished = true;
      let source = 'none';
      let pending = [];
      try {
        const result = await this.pendingSections();
        source = result.source;
        pending = result.items;
      } catch (err) {
        this.panel.log(`收尾核对目录失败：${err?.message || err}`);
      }
      const manualNames = (Array.isArray(manual) ? manual : []).filter(item => this.isManualSection(item));
      for (const item of pending) if (this.isManualSection(item)) this.noteManualSection(item);
      // 剩下要刷的 = 平台还没记满、且不是「脚本不代做」的那些
      const leftovers = pending.filter(item => !this.isManualSection(item)
        && !manualNames.some(section => this.sameSectionName(section.title, item.title)));
      const manualShown = [...manualNames];
      for (const item of pending) {
        if (!this.isManualSection(item)) continue;
        if (!manualShown.some(section => this.sameSectionName(section.title, item.title))) manualShown.push(item);
      }
      // 只有侧栏图标这一条证据时不当结论用：它落后一整节，会把刚播完的最后一节说成没刷完
      if (leftovers.length && source === 'api') {
        // 平台说还没记满 → 不能报「刷完」，否则就是又一次「明明没刷完却说刷完了」
        const head = leftovers.slice(0, 6)
          .map(item => `${item.title}(${item.progress == null ? '进度读不到' : Y.pctText(item.progress)})`)
          .join('、');
        this.panel.warn(`平台还没记满 ${leftovers.length} 节：${head}${leftovers.length > 6 ? '…' : ''}；下次点「继续刷课」会先补这些`);
        this.panel.log('这次先停在这里（不是刷完），处理好后点「继续刷课」接着补');
        this.resetRunButton('继续刷课');
        Y.Store.clearPendingAutoStart();
        return false;
      }
      if (leftovers.length && source === 'dom') {
        this.panel.log(`侧栏还有 ${leftovers.length} 项没打勾，但接口读不到平台记账，按「已刷完」处理（以平台为准，稍后会自动同步）`);
      }
      if (!this.endReported) {
        this.endReported = true;
        if (Array.isArray(this.plan) && this.plan.length) {
          this.panel.log(`平台核对：可自动学习的小节都记满了（目录共 ${this.plan.length} 节）`);
        } else {
          this.panel.log('平台核对：没有剩下未完成的小节');
        }
        this.panel.log('课程刷完啦 🎉');
        if (manualShown.length) {
          this.panel.log(`另有 ${manualShown.length} 项脚本不代做，需要你手动完成：${manualShown.map(item => item.title).join('、')}`);
        }
        this.panel.celebrate({
          title: '本课程已刷完',
          desc: manualShown.length
            ? `能自动学的小节都刷完了；剩下 ${manualShown.length} 项要你手动处理`
            : '平台核对过：这门课已经没有待刷的小节了',
          manual: manualShown.map(item => item.title)
        });
      }
      this.resetRunButton('刷完啦~');
      Y.Store.clearPendingAutoStart();
      return true;
    }
  }

  Object.assign(AiWorkspaceRunner.prototype, Y.WorkspaceMediaMixin, Y.WorkspaceProgressMixin, Y.WorkspaceCreditMixin, Y.WorkspaceExerciseMixin);

  Y.AiWorkspaceRunner = AiWorkspaceRunner;
})(Y);
