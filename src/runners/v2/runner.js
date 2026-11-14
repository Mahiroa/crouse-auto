((Y) => {
  // v2 刷课主流程（V2Runner）

  // ---- v2 逻辑 ----

  class V2Runner {
    constructor(panel) {
      this.panel = panel;
      this.baseUrl = location.href;
      const { current } = Y.Store.getProgress(this.baseUrl);
      // getProgress 已归一，这里再兜一层：外部（旧版本残留/调试注入）把 current 改成字符串时，
      // this.outside 仍必须是 >=0 的整数，否则 run() 会进入无 await 的原地死循环。
      const outside = Number.isFinite(Number(current.outside))
        ? Math.max(0, Math.floor(Number(current.outside)))
        : 0;
      const inside = Number.isFinite(Number(current.inside))
        ? Math.max(0, Math.floor(Number(current.inside)))
        : 0;
      this.outside = outside;
      this.inside = inside;
      this.shouldStop = false;
    }

    updateProgress(outside, inside = 0) {
      this.outside = outside;
      this.inside = inside;
      Y.Store.setProgress(this.baseUrl, outside, inside);
    }

    async waitForExternalHandoff(timeout = 1200) {
      await Y.Utils.sleep(timeout);
      if (document.visibilityState === 'hidden' || !document.hasFocus()) {
        this.shouldStop = true;
        this.panel.log('已交给新页面继续，返回目录页后会自动续跑');
        return true;
      }
      return false;
    }

    checkCompletionStatus(statusBox, statusText) {
      // 1. 检查明确的完成状态文本
      if (statusText.includes('已完成') || statusText.includes('已读')) {
        return true;
      }

      // 2. 检查明确的未完成状态文本
      if (statusText.includes('未开始') || statusText.includes('未读') || statusText.includes('进行中')) {
        return false;
      }

      // 3. 检查学习进度数字比例
      const progressMatch = statusText.match(/(\d+)\/(\d+)/);
      if (progressMatch) {
        const [, current, total] = progressMatch;
        const currentNum = parseInt(current, 10);
        const totalNum = parseInt(total, 10);

        // 根据数字进度判断：相等且大于0表示已完成
        return currentNum === totalNum && totalNum > 0;
      }

      // 默认返回false（未完成）
      return false;
    }

    async run() {
      // 入口再校验一次进度：localStorage 脏数据曾是 P1（outside=undefined/null/"3" 时
      // `outside >= list.length` 恒假、`list[outside]` 取不到，continue 分支没有 await → 标签页卡死）。
      this.outside = Number.isFinite(Number(this.outside)) ? Math.max(0, Math.floor(Number(this.outside))) : 0;
      this.inside = Number.isFinite(Number(this.inside)) ? Math.max(0, Math.floor(Number(this.inside))) : 0;
      this.panel.log(`检测到已播放到第 ${this.outside} 集，继续刷课...`);
      // 最大轮次硬上限：即使目录 DOM 持续异常（比如 list 一直为空但又不是完全为空），
      // 循环也必须在 500 轮内收尾，不能靠“每轮都有脏数据”无限转下去。
      let rounds = 0;
      // 在课件页恢复时直接续播当前内容，不重新走列表流程
      if (location.pathname.includes('/studentCards/')) {
        const videoBox = document.querySelector('.video-box');
        const boxText = videoBox?.innerText || '';
        if ((videoBox || document.querySelector('video')) && !boxText.includes('已完成')) {
          this.panel.log('检测到当前课件页，直接续播当前内容');
          const played = await this.waitCoursewareVideo();
          if (!played) this.panel.log('当前课件等待后仍未显示已完成，返回目录继续');
          history.back();
          await Y.Utils.sleep(1000);
        }
      }
      let missingListRetries = 0;
      while (true) {
        // 500 轮硬上限：正常课程远小于这个数；命中说明页面状态异常（目录反复渲染失败等），
        // 停下面板并留日志，避免无 await 路径把主线程占满。
        if (++rounds > 500) {
          this.panel.warn('连续处理超过 500 轮仍未结束，已停止。请刷新页面后重新开始');
          this.panel.resetStartButton('开始刷课');
          return;
        }
        await this.autoSlide();
        // 必须是元素集合：childNodes 里可能夹着 Vue 留下的空文本/注释节点，
        // 用 childNodes 会让「全部集数」变多、索引错位，甚至在文本节点上调用 querySelector 抛 TypeError
        const listEl = document.querySelector('.logs-list');
        const list = listEl ? [...listEl.children].filter(node => node.nodeType === 1) : [];
        if (!list.length) {
          // 可能停留在课件页：跳回目录页继续，避免无限重试
          const pending = Y.Store.getPendingAutoStart();
          const currentId = Y.Utils.getCurrentClassroomId();
          const sameClassroom = !currentId || pending?.classroomId === currentId;
          const returnUrl = sameClassroom
            ? (pending?.returnUrl || (pending?.classroomId ? `/v2/web/studentLog/${pending.classroomId}` : ''))
            : '';
          if (returnUrl && !location.pathname.includes('/studentLog/')) {
            this.panel.log('当前页面无课程列表，返回目录页继续');
            location.href = returnUrl;
            return;
          }
          missingListRetries++;
          if (missingListRetries >= 30) {
            this.panel.warn('连续 60 秒没有找到课程列表，已停止，请确认当前页面是课程目录页');
            this.panel.resetStartButton('开始刷课');
            return;
          }
          this.panel.log(`未找到课程列表，稍后重试（${missingListRetries}/30）`);
          await Y.Utils.sleep(2000);
          continue;
        }
        missingListRetries = 0;
        console.log(`当前集数:${this.outside}/全部集数${list.length}`);
        if (this.outside >= list.length) {
          this.panel.log('课程刷完啦 🎉');
          this.panel.track({ id: 'course-done', kind: 'course', title: '本课目录已全部结束', status: 'done', detail: '没有更多内容' });
          this.panel.resetStartButton('刷完啦~');
          Y.Store.removeProgress(this.baseUrl);
          Y.Store.clearPendingAutoStart();
          break;
        }
        const course = list[this.outside]?.querySelector('.content-box')?.querySelector('section');
        if (!course) {
          this.panel.log('未找到当前课程节点，跳过');
          this.updateProgress(this.outside + 1, 0);
          continue;
        }
        const type = course.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || 'piliang';
        const title = course.querySelector('h2')?.innerText?.trim() || `第${this.outside + 1}项`;
        const kind = type.includes('shipin') ? 'video' : type.includes('kejian') ? 'ppt' : type.includes('ketang') ? 'course' : 'course';
        const stepId = `v2-${this.outside}`;

        // 预检查完成状态
        const statusBox = course.querySelector('.statistics-box .aside');
        const statusText = statusBox?.innerText || '';

        // 判断是否已完成
        let isCompleted = this.checkCompletionStatus(statusBox, statusText);

        if (isCompleted) {
          this.panel.log(`✅ ${title} 已完成，跳过`);
          this.panel.track({ id: stepId, kind, title, status: 'done', detail: '已完成' });
          this.updateProgress(this.outside + 1, 0);
          continue;
        }

        this.panel.log(`刷课状态：第 ${this.outside + 1}/${list.length} 个，类型 ${type}，标题：${title}`);
        this.panel.track({ id: stepId, kind, title, status: 'doing', detail: `第 ${this.outside + 1}/${list.length} 个` });
        if (type.includes('shipin')) {
          await this.handleVideo(course);
        } else if (type.includes('piliang')) {
          await this.handleBatch(course, list);
        } else if (type.includes('ketang')) {
          await this.handleClassroom(course);
        } else if (type.includes('kejian')) {
          await this.handleCourseware(course);
        } else if (type.includes('kaoshi')) {
          this.panel.log('考试区域脚本会被屏蔽，已跳过');
          this.updateProgress(this.outside + 1, 0);
        } else {
          this.panel.log('非视频/批量/课件/考试，已跳过');
          this.updateProgress(this.outside + 1, 0);
        }
        if (this.shouldStop) return;
      }
    }

    async autoSlide() {
      // frequency 不能是 NaN（脏 outside 时 for 一次都不跑，等于这一轮没有 await 让出宏任务）
      const outside = Number.isFinite(Number(this.outside)) ? Math.max(0, Math.floor(Number(this.outside))) : 0;
      const frequency = Math.max(1, Math.floor((outside + 1) / 20) + 1);
      for (let i = 0; i < frequency; i++) {
        Y.Utils.scrollToBottom('.viewContainer');
        await Y.Utils.sleep(800);
      }
    }

    // 进度文本每次现查：SPA 换页/播放器重渲染会把旧节点替换掉，
    // 之前把节点在 poll 外取一次，取不到或被替换后就只能干等 DDL
    readProgressText() {
      const node = document.querySelector('.progress-wrap .text')
        || document.querySelector('.progress-wrap')?.querySelector('.text');
      return node ? (node.textContent || '') : '';
    }
  }

  Object.assign(V2Runner.prototype, Y.V2RunnerMediaMixin, Y.V2RunnerCoursewareMixin);

  Y.V2Runner = V2Runner;
})(Y);
