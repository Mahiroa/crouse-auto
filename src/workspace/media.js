((Y) => {
  // 学习空间路由与媒体元素定位

  // ---- ai-workspace 路由工具 ----

  const WorkspaceMedia = {
    normalizeText(text) {
      return String(text || '').replace(/\s+/g, ' ').trim();
    },
    isVisibleElement(element) {
      if (!element || element.nodeType !== 1) return false;
      const view = element.ownerDocument?.defaultView || window;
      const style = view.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    },
    getRoute() {
      const match = location.pathname.match(/^\/ai-workspace\/lms-graph\/([^/]+)\/([^/]+)\/([^/?#]+)/);
      if (!match) return null;
      const [, classroomId, type, leafId] = match;
      const query = new URLSearchParams(location.search);
      return {
        classroomId,
        type,
        leafId,
        nodeId: query.get('node_id') || ''
      };
    },
    getMediaCandidates() {
      return [...document.querySelectorAll('video, audio')].filter(media => {
        if (!(media instanceof HTMLMediaElement)) return false;
        const rect = media.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0;
        return isVisible || media.tagName.toLowerCase() === 'audio';
      });
    },
    getMedia() {
      const candidates = this.getMediaCandidates().filter(media => !media.ended);
      const pool = candidates.length ? candidates : this.getMediaCandidates();
      if (!pool.length) return document.querySelector('video') || document.querySelector('audio');
      const score = media => {
        const rect = media.getBoundingClientRect();
        const area = rect.width * rect.height;
        const playingBoost = !media.paused && !media.ended ? 1_000_000 : 0;
        const currentBoost = Number(media.currentTime || 0);
        return playingBoost + area + currentBoost;
      };
      return [...pool].sort((a, b) => score(b) - score(a))[0];
    },
    isPlayerDone(media, { startTime = 0, minPlayedDelta = 0 } = {}) {
      if (!media || !media.isConnected) return false;
      const currentTime = Number(media.currentTime || 0);
      const playedDelta = Math.max(0, currentTime - startTime);
      if (playedDelta < minPlayedDelta) return false;
      // 时长要连续几次不变，才把它当成整段长度；分片时长不能用来判定结束
      if (!Y.Player.noteDuration(media)) return false;
      const duration = Y.Player.stableDuration(media);
      if (media.ended && duration - currentTime <= 0.5) return true;
      if (duration > 1 && currentTime > 0 && duration - currentTime <= 0.3) return true;
      const display = media.ownerDocument?.querySelector('.xt_video_player_current_time_display')?.innerText?.trim() || '';
      const [current, total] = display.split(' / ').map(text => text?.trim());
      return Y.Player.isDisplayFinished(current, total);
    },
    // 整节播完的判定：ended 事件最可靠；有些播放器到结尾只暂停不发 ended，
    // 再用“稳定时长 - 当前时间 <= 0.5s”和播放器自带的时间显示兜底
    isPlayerFinished(media) {
      if (!media || !media.isConnected) return false;
      const currentTime = Number(media.currentTime || 0);
      if (media.ended && currentTime > 0) return true;
      const duration = Number(media.duration || 0);
      if (Y.Player.isDurationStable(media) && duration > 1 && currentTime > 0 && duration - currentTime <= 0.5) return true;
      const display = media.ownerDocument?.querySelector('.xt_video_player_current_time_display')?.innerText?.trim() || '';
      const [current, total] = display.split(' / ').map(text => text?.trim());
      return Y.Player.isDisplayFinished(current, total);
    },
    keepAlive(shouldResume = () => true) {
      let lastMedia = null;
      let pausedAt = 0;
      let pausedMark = 0;
      const tick = () => {
        if (!shouldResume() || Y.Utils.isHumanCheckVisible()) return;
        const media = this.getMedia();
        if (!media) return;
        if (lastMedia !== media) {
          if (lastMedia) lastMedia.removeEventListener('pause', tick);
          lastMedia = media;
          pausedAt = 0;
          pausedMark = 0;
          media.addEventListener('pause', tick);
        }
        // 播放器会自己同步音量/倍速，统一走 applySettings：先点原生控件，再兜底改属性
        Y.Player.applySettings(media);
        Y.Player.noteDuration(media);
        if (media.seeking || media.readyState < 3) {
          pausedAt = 0;
          pausedMark = 0;
          return;
        }
        if (!media.paused) {
          pausedAt = 0;
          pausedMark = 0;
          return;
        }
        if (media.ended || Y.Player.isNearEnd(media, 0.2)) return;
        const currentTime = Number(media.currentTime || 0);
        if (!pausedAt) {
          pausedAt = Date.now();
          pausedMark = currentTime;
          return;
        }
        if (Math.abs(currentTime - pausedMark) > 0.5) {
          pausedAt = Date.now();
          pausedMark = currentTime;
          return;
        }
        if (Date.now() - pausedAt >= Y.Player.RESUME_DELAY) {
          pausedAt = Date.now();
          media.play().catch(() => { });
        }
      };
      // 固定 8 秒心跳（setInterval）是自动化探针 automation-risk-probe 最容易抓的节拍特征：
      // 改成「自调度 + 抖动」，每轮跑完再用 Y.Utils.randInt 随机排下一轮（6500~9500ms），节拍不可预测。
      // 首跳不放慢：下面仍然立刻 tick() 一次（保活要第一时间补倍速/静音并接管暂停），之后才进抖动循环。
      // loop 是文件内局部实现，不新增模块、不动 manifest。
      let timer = null;
      let stopped = false;
      const loop = () => {
        if (stopped) return;
        timer = setTimeout(() => {
          timer = null;
          if (stopped) return;
          try {
            tick();
          } finally {
            // 抛错也不许断链：原来的 setInterval 就是「这一轮出错，下一轮照跑」
            if (!stopped) loop();
          }
        }, Y.Utils.randInt(6500, 9500));
      };
      Y.addNativeListener(document, 'visibilitychange', tick);
      Y.addNativeListener(window, 'focus', tick);
      tick();
      loop();
      return () => {
        // 先置标记、再清 id：已经排进队列的那一轮醒来第一件事是看 stopped 并退出，不会再排新链
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (lastMedia) lastMedia.removeEventListener('pause', tick);
        document.removeEventListener('visibilitychange', tick);
        window.removeEventListener('focus', tick);
      };
    }
  };

  Y.WorkspaceMedia = WorkspaceMedia;
})(Y);
