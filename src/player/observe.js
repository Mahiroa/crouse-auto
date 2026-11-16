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
      // 「页面不可见时被暂停」的快速续播：它不依赖定时器，所以后台节流也拦不住（见 playNow）
      let lastQuickAt = 0;
      let quickNotes = 0;
      // 重排链路统一收口到一个 stopped 标记 + 「在跑的 timeout」集合：
      // 清理函数调用一次就彻底停摆，不会出现「clearTimeout 之后回调醒来又把下一轮排上」的幽灵链
      // （切集/销毁后残留的定时器正是自动化探针最容易抓到的特征之一）。
      let stopped = false;
      const pendingTimers = new Set();
      const doc = video.ownerDocument || document;
      const addDoc = (type, fn, options) => {
        // 站点把 document.addEventListener 换成「吞掉 visibilitychange」的版本时（screenGuard=patch），
        // 脚本自己的监听必须走保留的原生实现，否则看不见真实事件
        if (typeof Y.addNativeListener === 'function') Y.addNativeListener(doc, type, fn, options);
        else doc.addEventListener(type, fn, options);
      };
      const hiddenNow = () => {
        try {
          if (typeof Y.Utils?.isTabReallyHidden === 'function') return Boolean(Y.Utils.isTabReallyHidden());
        } catch (_) {}
        try {
          return Boolean(doc.hidden);
        } catch (_) {
          return false;
        }
      };
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
      // 页面不可见时的续播：pause 事件一到就直接 play()，不走 RESUME_DELAY 的 setTimeout。
      // 原因：隐藏页的定时器会被浏览器节流（Chrome 隐藏 5 分钟后是 1 分钟一轮），
      // 15 秒的延后续播在后台等不到；而站点自己的防挂机（visibilitychange / blur 后 pause）
      // 恰恰就发生在窗口最小化的时候 —— 表现为「最小化后视频停住不动」。
      const playNow = (why) => {
        if (stopped || !canResume()) return false;
        const now = Date.now();
        if (now - lastQuickAt < this.QUICK_RESUME_GAP) return false;
        lastQuickAt = now;
        if (quickNotes < 3) {
          quickNotes += 1;
          Y.Stealth?.note?.(`播放器被暂停（${why}），已立即续播`);
        }
        // 防挂机弹窗会挡住 play()：先按页面已有的清理逻辑关掉（拿不到就跳过）
        try {
          Y.Utils?.dismissPopups?.();
        } catch (_) {}
        const playing = video.play();
        if (playing && typeof playing.catch === 'function') {
          playing.catch(e => {
            if (!canResume()) return;
            Y.Stealth?.warn?.('后台续播失败:', e);
          });
        }
        return true;
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
      if (video.paused) {
        if (hiddenNow()) playNow('接管时已暂停');
        else scheduleResume();
      }
      const onPause = () => {
        if (!canResume()) return;
        // 隐藏状态（最小化/切走）下立即续播；可见时保持原来的 15 秒节奏，
        // 免得把用户自己点的暂停也当成异常拉回来
        if (hiddenNow()) {
          playNow('暂停');
          return;
        }
        scheduleResume();
      };
      // 站点在 visibilitychange / blur 里暂停播放器：事件里先查一次，pause 事件随后还会补一次
      const onVisibility = () => {
        if (stopped || !video.paused) return;
        if (!hiddenNow()) return;
        playNow('visibilitychange');
      };
      // freeze → resume / pageshow / focus：页面从冻结或后台恢复时，媒体多半已被浏览器按
      // kFrameFrozen / kPageHidden 暂停，这次属于「授权恢复」，可以立刻拉回
      const onLifecycle = () => {
        if (stopped || !video.paused) return;
        playNow('页面恢复');
      };
      // 暂停时 readyState 掉到 3 以下（切源/缓冲）：canResume 为 false 会漏掉这一次续播，
      // 等能播了再补一次，避免整节停在「已暂停」上
      const onReady = () => {
        if (stopped || !video.paused) return;
        if (!hiddenNow()) return;
        playNow('canplay');
      };
      video.addEventListener('pause', onPause);
      video.addEventListener('canplay', onReady);
      video.addEventListener('loadeddata', onReady);
      addDoc('visibilitychange', onVisibility);
      addDoc('freeze', onLifecycle);
      addDoc('resume', onLifecycle);
      addDoc('pageshow', onLifecycle);
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
      loop(() => {
        if (!video.paused || !canResume()) return;
        if (hiddenNow()) playNow('定时检查');
        else scheduleResume();
      }, 16000, 24000);
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
        video.removeEventListener('canplay', onReady);
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('ratechange', enforceSettings);
        video.removeEventListener('volumechange', enforceSettings);
        doc.removeEventListener('visibilitychange', onVisibility);
        doc.removeEventListener('freeze', onLifecycle);
        doc.removeEventListener('resume', onLifecycle);
        doc.removeEventListener('pageshow', onLifecycle);
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
