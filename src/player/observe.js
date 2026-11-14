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
      const playVideo = () => {
        if (!canResume()) return;
        if (Date.now() - lastPlayAt < this.RESUME_DELAY) return;
        lastPlayAt = Date.now();
        video.play().catch(e => {
          if (!canResume()) return;
          console.warn('自动播放失败:', e);
        });
      };
      const scheduleResume = () => {
        if (resumeTimer) return;
        const pausedAtTime = Number(video.currentTime || 0);
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
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
      const settingsTimer = setInterval(enforceSettings, 1000);
      const timer = setInterval(() => { if (video.paused && canResume()) scheduleResume(); }, 20000);
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
        video.removeEventListener('pause', onPause);
        video.removeEventListener('ratechange', enforceSettings);
        video.removeEventListener('volumechange', enforceSettings);
        clearInterval(settingsTimer);
        clearInterval(timer);
        if (resumeTimer) clearTimeout(resumeTimer);
        if (observer) observer.disconnect();
      };
    }
  };

  Y.PlayerObserve = PlayerObserve;
})(Y);
