((Y) => {
  // 播放器时长状态与就绪判定

  // ---- 播放器工具 ----
  const mediaDurationState = new WeakMap();

  const PlayerDuration = {
    RESUME_DELAY: 15000,
    // 页面不可见（窗口最小化 / 切到别的标签页）时的续播去抖间隔。
    // 隐藏页里的定时器会被浏览器节流到 1 秒甚至 1 分钟一次，等不到 15 秒的延后续播，
    // 所以隐藏状态改走「pause 事件直连 + 立即 play()」，这个值只用来防止站点反复 pause 时打成死循环。
    QUICK_RESUME_GAP: 2000,
    DURATION_STABLE_TICKS: 3,
    noteDuration(media) {
      if (!media) return false;
      const duration = Number(media.duration || 0);
      let state = mediaDurationState.get(media);
      if (!state) {
        state = { last: 0, ticks: 0 };
        mediaDurationState.set(media, state);
      }
      if (!Number.isFinite(duration) || duration <= 1) {
        state.last = 0;
        state.ticks = 0;
        return false;
      }
      if (state.last > 0 && Math.abs(duration - state.last) < 0.3) {
        state.ticks += 1;
      } else {
        state.last = duration;
        state.ticks = 1;
      }
      return state.ticks >= this.DURATION_STABLE_TICKS;
    },
    isDurationStable(media) {
      const state = media ? mediaDurationState.get(media) : null;
      return Boolean(state && state.ticks >= this.DURATION_STABLE_TICKS && state.last > 1);
    },
    stableDuration(media) {
      return media ? (mediaDurationState.get(media)?.last || 0) : 0;
    },
    isDisplayFinished(current, total) {
      const left = String(current || '').trim();
      const right = String(total || '').trim();
      if (!left || !right || left !== right) return false;
      const parts = right.split(':').map(part => Number(part));
      if (!parts.length || parts.some(part => !Number.isFinite(part))) return false;
      return parts.some(part => part > 0);
    },
    isNearEnd(media, threshold = 1) {
      if (!media || !media.isConnected || !this.isDurationStable(media)) return false;
      const duration = this.stableDuration(media);
      const currentTime = Number(media.currentTime || 0);
      return currentTime > 0 && duration - currentTime <= threshold;
    },
    isReadyToPlay(media) {
      if (!media || !media.isConnected || media.ended || media.seeking) return false;
      return media.readyState >= 3;
    },
    waitForEnd(media, timeout = 0) {
      return new Promise(resolve => {
        if (!media) return resolve();
        if (media.ended) return resolve();
        let timer;
        const onEnded = () => {
          clearTimeout(timer);
          resolve();
        };
        media.addEventListener('ended', onEnded, { once: true });
        if (timeout > 0) {
          timer = setTimeout(() => {
            media.removeEventListener('ended', onEnded);
            resolve();
          }, timeout);
        }
      });
    }
  };

  Y.mediaDurationState = mediaDurationState;
  Y.PlayerDuration = PlayerDuration;
})(Y);
