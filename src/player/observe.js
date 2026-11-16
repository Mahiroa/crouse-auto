((Y) => {
  // 播放过程中的倍速/静音校正

  const PlayerObserve = {
    observePause(video, shouldResume = () => true) {
      if (!video) return () => { };
      const canResume = () => {
        this.noteDuration(video);
        if (Y.Utils.isHumanCheckVisible()) return false;
        return shouldResume() && this.isReadyToPlay(video) && !this.isNearEnd(video, 0.2);
      };
      let resumeTimer = null;
      let lastPlayAt = 0;
      // 重排链路统一收口到一个 stopped 标记 + 「在跑的 timeout」集合：
      // 清理函数调用一次就彻底停摆，不会出现「clearTimeout 之后回调醒来又把下一轮排上」的幽灵链
      // （切集/销毁后残留的定时器正是自动化探针最容易抓到的特征之一）。
      let stopped = false;
      const pendingTimers = new Set();
      const playVideo = () => {
        if (stopped || !canResume()) return;
        if (Date.now() - lastPlayAt < this.RESUME_DELAY) return;
        lastPlayAt = Date.now();
        video.play().catch(e => {
          if (!canResume()) return;
          // 日志归口：quiet 时只进面板，不往页面控制台写（控制台输出也是探针可读的旁证）
          Y.Stealth?.warn?.('自动播放失败:', e);
        });
      };
      const scheduleResume = () => {
        if (stopped || resumeTimer) return;
        const pausedAtTime = Number(video.currentTime || 0);
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          if (stopped) return;
          if (!video.paused || !canResume()) return;
          if (Math.abs(Number(video.currentTime || 0) - pausedAtTime) > 0.5) return;
          playVideo();
        }, this.RESUME_DELAY);
      };
      if (video.paused) scheduleResume();
      const onPause = () => { if (canResume()) scheduleResume(); };
      video.addEventListener('pause', onPause);
      // 每轮都重新应用一次倍速/静音：播放器切集、重新加载或自己刷新状态后不会退回 1 倍速/有声
      const enforceSettings = () => {
        try {
          this.applySettings(video);
        } catch (_) {}
      };
      enforceSettings();
      video.addEventListener('ratechange', enforceSettings);
      video.addEventListener('volumechange', enforceSettings);
      // 固定节拍（setInterval 1000 / 20000）是最稳的机器特征，站点探针 automation-risk-probe 会直接抓；
      // 改成「自调度 + 抖动」：每轮执行完再用 Y.Utils.randInt 随机排下一轮，节拍不再可预测。
      // 仍然是有界轮询 —— 一轮做完必然排下一轮，原来在定时器里能完成的事（补倍速/补静音/续播）
      // 一件不少，只是间隔从固定值变成区间。loop 是文件内局部实现，不新增模块、不动 manifest。
      const loop = (fn, min, max) => {
        if (stopped) return;
        const id = setTimeout(() => {
          pendingTimers.delete(id);
          if (stopped) return;
          try {
            fn();
          } finally {
            // 抛错也不许断链：原来的 setInterval 就是「这一轮出错，下一轮照跑」
            if (!stopped) loop(fn, min, max);
          }
        }, Y.Utils.randInt(min, max));
        pendingTimers.add(id);
      };
      loop(enforceSettings, 800, 1400);
      loop(() => { if (video.paused && canResume()) scheduleResume(); }, 16000, 24000);
      // 播放控件提示可能在 iframe 里：用媒体自己的文档，别去顶层 document 找
      const target = video.ownerDocument?.getElementsByClassName('play-btn-tip')[0];
      let observer = null;
      if (target) {
        observer = new MutationObserver(list => {
          for (const mutation of list) {
            if (mutation.type === 'childList' && target.innerText === '播放' && canResume()) {
              scheduleResume();
            }
          }
        });
        observer.observe(target, { childList: true });
      }
      return () => {
        // 先置标记、再清 id：即使某轮回调刚好已排进队列，它醒来第一件事也是看 stopped 并退出，
        // 不会在销毁/切集之后再排出一条新链
        stopped = true;
        for (const id of pendingTimers) clearTimeout(id);
        pendingTimers.clear();
        video.removeEventListener('pause', onPause);
        video.removeEventListener('ratechange', enforceSettings);
        video.removeEventListener('volumechange', enforceSettings);
        if (resumeTimer) {
          clearTimeout(resumeTimer);
          resumeTimer = null;
        }
        if (observer) observer.disconnect();
      };
    }
  };

  Y.PlayerObserve = PlayerObserve;
})(Y);
