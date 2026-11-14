((Y) => {
  // 目录审计与平台记账查询

  const WorkspaceProgressMixin = {
    // ---- 平台进度：目录审计 / 单节进度 / 视频补刷 ----
    // 注意：verify/forum-reply-tests.js 会把 AiWorkspaceRunner 整类切出来，只注入
    // AiWorkspace/Utils/Store/Solver 四个桩（没有 YktApi、也不一定有 getRoute）。
    // 所以下面这些方法一律「取不到当没有」，绝不因为新依赖缺失而抛异常。
    currentClassroomId() {
      try {
        const route = typeof Y.AiWorkspace?.getRoute === 'function' ? Y.AiWorkspace.getRoute() : null;
        return route?.classroomId || '';
      } catch (_) {
        return '';
      }
    },
    platformApi() {
      try {
        return typeof Y.YktApi === 'undefined' || !Y.YktApi ? null : Y.YktApi;
      } catch (_) {
        return null;
      }
    },
    async leafProgressNow(leafId, { force = false } = {}) {
      if (!leafId) return null;
      const api = this.platformApi();
      if (!api || !api.enabled) return null;
      const classroomId = this.currentClassroomId();
      if (!classroomId) return null;
      return api.leafProgress(classroomId, leafId, { force });
    },
    // 观看日志（已观看区间 + 真实覆盖率）。取不到就当没有，绝不让它把主链路拖死。
    async readVideoLog(leafId) {
      if (!leafId) return null;
      const api = this.platformApi();
      if (!api || !api.enabled || typeof api.videoLog !== 'function') return null;
      const classroomId = this.currentClassroomId();
      if (!classroomId) return null;
      try {
        return await api.videoLog(classroomId, leafId);
      } catch (err) {
        this.panel.log(`读观看日志失败：${err?.message || err}`);
        return null;
      }
    },
    activeBox() {
      const list = this.getLeafList();
      const index = this.getActiveIndex(list);
      return index >= 0 ? list[index] : null;
    },
    // 开跑先审一遍课程目录：报「共 N 节 / 已完成 X / 待补 Y」，并把最靠前的未完成项
    // 设成本轮的第一目标（用户的要求：先把没刷完的补掉，再往下走）。
    async auditDirectory() {
      const api = this.platformApi();
      const classroomId = this.currentClassroomId();
      if (!classroomId) return null;
      const list = api && api.enabled ? await api.directory(classroomId, { force: true }) : null;
      const boxes = this.getLeafList();
      if (!list) {
        const percents = boxes.map(box => Y.AiWorkspace.leafDomPercent(box));
        const undone = percents.filter(value => value == null || value < 99.5).length;
        const partial = percents.filter(value => value != null && value > 0 && value < 99.5).length;
        this.panel.log(`平台进度接口不可用，按侧栏三态统计：共 ${boxes.length} 项，未打满 ${undone} 项`
          + `（其中圆环显示部分进度 ${partial} 项）`);
        this.priorityTarget = this.firstUndoneDomIndex(boxes);
        return null;
      }
      this.plan = list;
      this.planVerified = this.verifyPlanAgainstDom(list, boxes);
      const isManual = item => (typeof this.isManualSection === 'function' ? this.isManualSection(item) : false);
      const doneCount = list.filter(item => item.progress >= Y.DONE_RATE).length;
      const restCount = kind => list.filter(item => item.kind === kind && item.progress < Y.DONE_RATE).length;
      const manualRest = list.filter(item => item.progress < Y.DONE_RATE && isManual(item));
      this.panel.log(`课程目录：共 ${list.length} 节，平台已记完成 ${doneCount} 节，待补 ${list.length - doneCount} 节`
        + `（视频 ${restCount('video')} / 图文 ${restCount('graph')} / 讨论 ${restCount('forum')} / 作业 ${restCount('exercise')}）`);
      if (manualRest.length) {
        // 考试这类脚本不代做的小节要是混进「待补」，用户会以为脚本漏了一节
        this.panel.log(`其中 ${manualRest.length} 项脚本不代做、留给你手动完成：`
          + `${manualRest.slice(0, 4).map(item => item.name).join('、')}${manualRest.length > 4 ? '…' : ''}`);
      }
      this.panel.log(this.planVerified
        ? '侧栏与课程目录逐项对上了，后面按平台进度判定每节是否真的刷完'
        : `侧栏 ${boxes.length} 项与目录 ${list.length} 项对不上（可能折叠了章节），改为「进入后查单节进度」`);
      const first = list.find(item => item.progress < Y.DONE_RATE && !isManual(item));
      if (!first) {
        this.panel.log(manualRest.length
          ? '目录里能自动学的小节平台都记满了，本轮只核对（剩下的是需要手动完成的那几项）'
          : '目录里每一节平台都记满了，本轮只做核对');
        return list;
      }
      this.priorityTarget = this.planVerified ? first.index : this.firstUndoneDomIndex(boxes);
      this.panel.log(`先补最靠前的未完成小节：第 ${first.index + 1} 节《${first.name}》（平台记账 ${Y.pctText(first.progress)}）`);
      return list;
    },
    // 目录只有和侧栏逐项对上（条数 + 标题 + 类型）才敢用下标直接定位
    verifyPlanAgainstDom(list, boxes) {
      if (!Array.isArray(list) || !Array.isArray(boxes) || !list.length) return false;
      if (list.length !== boxes.length) return false;
      let mismatch = 0;
      for (let i = 0; i < list.length; i++) {
        const apiItem = list[i];
        const name = String(Y.AiWorkspace.leafLabel(boxes[i]) || '').replace(/[\u200b\s]/g, '');
        const apiName = String(apiItem.name || '').replace(/[\u200b\s]/g, '');
        if (name && apiName && name !== apiName) mismatch++;
        const tagKind = Y.AiWorkspace.kindFromTag(Y.AiWorkspace.leafTag(boxes[i]));
        if (tagKind && apiItem.kind && apiItem.kind !== 'other' && tagKind !== apiItem.kind) mismatch++;
      }
      return mismatch === 0;
    },
    firstUndoneDomIndex(boxes) {
      const isManual = box => {
        if (typeof this.isManualSection !== 'function') return false;
        const tag = Y.AiWorkspace.leafTag(box);
        return this.isManualSection({
          title: this.getLeafTitle(box),
          tag,
          kind: Y.AiWorkspace.kindFromTag(tag) || 'course'
        });
      };
      const index = (boxes || []).findIndex(box => !Y.AiWorkspace.isLeafMarkedDone(box) && !isManual(box));
      return index >= 0 ? index : null;
    },
    // 直接点到「最靠前的未完成小节」。返回 true 表示真的跳过去了。
    async jumpToPriority() {
      const index = this.priorityTarget;
      if (!Number.isInteger(index) || index < 0) return false;
      const list = this.getLeafList();
      if (index >= list.length) {
        this.priorityTarget = null;
        return false;
      }
      if (index === this.getActiveIndex(list)) {
        this.priorityTarget = null;
        return false;
      }
      const box = list[index];
      if (!box || !box.isConnected) {
        this.priorityTarget = null;
        return false;
      }
      const title = this.getLeafTitle(box);
      const tag = Y.AiWorkspace.leafTag(box);
      const kind = Y.AiWorkspace.kindFromTag(tag) || 'course';
      if (typeof this.isManualSection === 'function' && this.isManualSection({ title, tag, kind })) {
        // 考试这类脚本不代做的小节：别把本轮第一目标浪费在它身上（点也点不进去）
        if (typeof this.noteManualSection === 'function') this.noteManualSection({ key: `${index}|${title}`, title, tag, kind });
        this.priorityTarget = null;
        return false;
      }
      this.panel.log(`当前停在别的节，先跳到第 ${index + 1} 节「${title}」补刷`);
      this.priorityTarget = null;
      return this.openLeaf(box, index);
    },
    // 轮询这一节的平台进度；timeout=0 时只查一次。返回 null 表示接口不可用。
    async waitLeafCredited(route, timeout = 6000) {
      const api = this.platformApi();
      const classroomId = this.currentClassroomId();
      if (!api || !classroomId || !route?.leafId) return null;
      const startedAt = Date.now();
      let last = null;
      for (;;) {
        const value = await api.leafProgress(classroomId, route.leafId, { force: true });
        if (value == null) return null;
        last = value;
        if (value >= Y.DONE_RATE) return value;
        const left = timeout - (Date.now() - startedAt);
        if (left <= 0) return last;
        await Y.Utils.sleep(Math.min(2500, left));
      }
    },
    // 图文 / 讨论 / PDF / 测验：平台口径是「点开即完成」。
    // 3.3.x 里它们落进 handleStep 的兜底分支，面板写「当前暂不自动处理此类型」，用户看到的就是「不支持」。
    async handleOpenLeaf(route, kind = 'graph') {
      const title = Y.AiWorkspace.getActiveLeafTitle() || `${kind} ${route.leafId}`;
      const label = Y.KIND_LABEL[kind] || '内容';
      const stepId = `${kind}-${route.leafId || title}`;
      const finish = detail => {
        this.panel.log(`${label}《${title}》${detail}`);
        this.panel.track({ id: stepId, kind, title, status: 'done', detail });
        return true;
      };
      this.panel.log(`开始处理${label}：${title}（打开即完成）`);
      this.panel.track({ id: stepId, kind, title, status: 'doing', detail: `${label}·打开即完成` });
      let progress = await this.waitLeafCredited(route, 0);
      if (progress == null) {
        // 接口不可用：退回侧栏打勾判断
        if (Y.AiWorkspace.isLeafMarkedDone(this.activeBox())) return finish('侧栏已打勾，跳过');
        this.panel.log(`${label}《${title}》已打开，但进度接口读不到，按页面标记继续`);
        this.panel.track({ id: stepId, kind, title, status: 'skip', detail: '打开后无法确认完成' });
        return true;
      }
      if (progress >= Y.DONE_RATE) return finish(`平台已记为完成（${Y.pctText(progress)}）`);
      this.panel.log(`${label}《${title}》打开后平台还没记账（${Y.pctText(progress)}），继续等`);
      progress = await this.waitLeafCredited(route, 4000);
      if (progress != null && progress >= Y.DONE_RATE) return finish(`平台已记为完成（${Y.pctText(progress)}）`);
      // 图文有自己的完成态接口：目录 progress 可能滞后十几秒，这个接口是页面自己用的那个，
      // 又小又快（抓包实证：进图文 0.3 秒就 finish:1）。先按它判一次，省掉整个目录重拉。
      // 只对图文用：讨论看的是 comment/status，作业是另一套，抓包没证过的不乱套。
      const isGraph = kind === 'graph';
      if (isGraph) {
        const article = await this.articleFinishedNow(route.leafId);
        if (article) return finish('图文完成态接口已记为完成');
      }
      // 还没记上：重新点开一次，触发平台的「已学」上报
      this.panel.log(`${label}《${title}》仍未记为完成，重新点开一次`);
      await this.reopenCurrentLeaf();
      progress = await this.waitLeafCredited(route, 4000);
      if (progress != null && progress >= Y.DONE_RATE) return finish(`重新打开后平台已记为完成（${Y.pctText(progress)}）`);
      if (isGraph) {
        const articleAfterReopen = await this.articleFinishedNow(route.leafId);
        if (articleAfterReopen) return finish('重新打开后图文完成态已记为完成');
        // 页面自己确实没上报：把页面那两个请求自己打一遍（同源、同 cookie、不伪造字段）
        const forced = await this.forceArticleDone(route, title, stepId);
        if (forced) return true;
      }
      const detail = progress == null ? '打开后无法确认完成' : `平台进度 ${Y.pctText(progress)}，未记为完成`;
      this.panel.warn(`${label}《${title}》${detail}`);
      this.panel.track({ id: stepId, kind, title, status: 'skip', detail });
      return true;
    },
    // 图文完成态：true 表示平台已经把这个 leaf 记为学完
    async articleFinishedNow(leafId) {
      const api = this.platformApi();
      if (!api || !api.enabled || typeof api.articleStatus !== 'function' || !leafId) return false;
      const status = await api.articleStatus(leafId);
      return Boolean(status && status.done);
    },
    // 兜底补记：页面没上报时，按抓包里页面的那两个请求自己打。
    // 只在「重开一次也没成」时才走到这里，所以正常刷课根本不会碰它。
    async forceArticleDone(route, title, stepId) {
      const api = this.platformApi();
      const classroomId = this.currentClassroomId();
      if (!api || !api.enabled || typeof api.markArticleDone !== 'function' || !classroomId || !route?.leafId) {
        return false;
      }
      this.panel.log(`页面自己没上报完成，改用站点自己的接口补记《${title}》`);
      const result = await api.markArticleDone(classroomId, route.leafId);
      if (!result || !result.ok) {
        this.panel.warn(`${title} 补记没成功（${result?.step || '接口无响应'}）`);
        return false;
      }
      this.panel.log(`${title} 补记成功：${result.step}${result.studyOk ? '' : '（add_study_leaf 返回 ok=false）'}`);
      this.panel.track({
        id: stepId,
        kind: 'graph',
        title,
        status: 'done',
        detail: `页面未上报，已用 ${result.step} 补记完成`
      });
      return true;
    },
    // 视频有没有「真的全看完」：rate 到 0.999 算满；拿到区间表时更准 ——
    // 没有任何 >= VideoLedger.MIN_GAP 的缺口就算满（抓包里区间右端会比时长多 1~2 秒，
    // 所以 rate 可能 >1，不能用 rate>=1 当唯一判据）。
    videoFullyCredited(info) {
      if (!info) return false;
      if (Array.isArray(info.gaps)) return info.gaps.length === 0;
      return info.rate != null && info.rate >= Y.DONE_RATE;
    }
  };

  Y.WorkspaceProgressMixin = WorkspaceProgressMixin;
})(Y);
