((Y) => {
  // 页面信息、挂载点与媒体时长

  const UtilsDom = {
    // 主要是规避firefox会创建多个iframe的问题
    inIframe() {
      return window.top !== window.self;
    },
    // 下滑到最底部，触发课程加载
    scrollToBottom(containerSelector) {
      const el = document.querySelector(containerSelector);
      if (el) el.scrollTop = el.scrollHeight;
    },
    getCurrentClassroomId() {
      const query = new URLSearchParams(location.search);
      const queryId = query.get('classroom_id');
      if (queryId) return queryId;

      const path = location.pathname;
      return path.match(/^\/ai-workspace\/lms-graph\/([^/]+)/)?.[1]
        || path.match(/^\/v2\/web\/studentLog\/([^/]+)/)?.[1]
        || path.match(/\/(\d+)\/studycontent$/)?.[1]
        || '';
    },
    returnUrl() { // 得到课程开始的url
      if (location.pathname.includes('/v2/web/studentLog/') || location.pathname.includes('pro/lms/')) {
        return location.href
      }
      return ""
    },
    isSupportedLearningPage() {
      const path = location.pathname;
      return path.includes('/ai-workspace/lms-graph/')
        || path.includes('/v2/web/')
        || path.includes('/pro/lms/');
    },
    waitForMountTarget(timeout = 15000) {
      const getTarget = () => document.body || document.documentElement;
      const existing = getTarget();
      if (existing) return Promise.resolve(existing);

      return new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(getTarget());
        };
        const observer = new MutationObserver(() => {
          if (getTarget()) finish();
        });
        observer.observe(document, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', finish, { once: true });
        window.addEventListener('load', finish, { once: true });
        const timer = setTimeout(finish, timeout);
      });
    },
    async getDDL() {
      const element = document.querySelector('video') || document.querySelector('audio');
      // 读不到整段时长时不要用一个很短的超时把课程掐掉
      const fallback = 3 * 60 * 60 * 1000;
      if (!element) return fallback;

      let duration = Number(element.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        await Promise.race([
          new Promise(resolve => element.addEventListener('loadedmetadata', resolve, { once: true })),
          this.sleep(8000)
        ]);
        duration = Number(element.duration);
      }

      if (!Number.isFinite(duration) || duration <= 1) return fallback;

      const rate = Math.max(Number(Y.Config.playbackRate) || 1, 0.5);
      const playMs = (duration * 1000) / rate;
      // 时长经常先报成当前分片长度，保底 30 分钟，避免几秒后就判定超时
      return Math.max(playMs * 3, 30 * 60 * 1000);
    },
    // 关闭挂机/离开检测弹窗，避免遮罩拦截刷课流程
    dismissPopups() {
      const wrappers = document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper');
      for (const wrapper of wrappers) {
        const style = getComputedStyle(wrapper);
        const rect = wrapper.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0) continue;
        const text = wrapper.innerText || '';
        const buttons = [...wrapper.querySelectorAll('button')];
        const clickBtn = label => {
          const btn = buttons.find(b => (b.innerText || '').trim().includes(label));
          if (btn) btn.click();
        };
        if (text.includes('好好学习') || text.includes('继续观看')) {
          clickBtn('继续观看');
        } else if (text.includes('报告老师')) {
          clickBtn('取消');
        }
      }
    }
  };

  Y.UtilsDom = UtilsDom;
})(Y);
