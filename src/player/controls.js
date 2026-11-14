((Y) => {
  // 倍速与静音控制

  const PlayerControls = {
    // 记录最近一次倍速点击，避免同一控件被反复点
    // ---- 播放器倍速 / 静音 ----
    // 雨课堂播放器是 xt-* 自定义元素：倍速按钮是 xt-speedbutton（当前值显示在
    // xt-speedvalue 里，形如 2.00X），备选速度在 xt-speedlist 里；静音按钮是
    // xt-volumebutton 里的 xt-icon。直接改 video 的 playbackRate/volume/muted 会被
    // 播放器按自己的内部状态覆盖回去，所以先点原生控件，再兜底改媒体属性，
    // 并在播放过程中反复校正（见 observePause 的定时器）。
    speedRequests: new WeakMap(),
    // 连续失败几次后拉长重试间隔，别一直弹倍速菜单
    speedAttempts: new WeakMap(),
    // 临时强显倍速列表前的内联样式，点完要还原
    speedListStyles: new WeakMap(),
    syncingSpeed: new WeakSet(),
    syncingMute: new WeakSet(),
    muteClickAt: new WeakMap(),
    muteClickAttempts: new WeakMap(),
    muteDrift: new WeakMap(),
    muteLocks: new WeakSet(),
    volumeBeforeMute: new WeakMap(),
    getPlayerWrap(media) {
      if (!media) return null;
      const closest = media.closest?.('xt-wrap, xt-video-player');
      if (closest) return closest;
      const doc = media.ownerDocument || document;
      const wraps = [...doc.querySelectorAll('xt-wrap, xt-video-player')];
      const medias = [...doc.querySelectorAll('video, audio')];
      // 只有当页面只有一个播放器、且这个媒体就是它的时候才跨容器兜底，
      // 否则可能点到别的播放器（比如课堂 iframe / 课件弹窗）的控件
      return wraps.length === 1 && medias.length === 1 && medias[0] === media ? wraps[0] : null;
    },
    queryPlayer(media, selector) {
      const wrap = this.getPlayerWrap(media);
      return wrap ? wrap.querySelector(selector) : null;
    },
    getSpeedControl(media) {
      return this.queryPlayer(media, 'xt-speedbutton.xt_video_player_speed')
        || this.queryPlayer(media, 'xt-speedbutton');
    },
    // 读播放器控件上显示的倍速，2.00X -> 2
    getControlRate(control) {
      const value = control?.querySelector('xt-speedvalue');
      if (!value) return null;
      const match = String(value.textContent || '').trim().match(/^(\d+(?:\.\d+)?)\s*[xX]$/);
      return match ? Number(match[1]) : null;
    },
    findSpeedOption(media, rate) {
      const scope = this.getPlayerWrap(media);
      if (!scope) return null;
      const options = [...scope.querySelectorAll('xt-speedlist li, xt-speedlist xt-button, xt-speedlist [data-speed], xt-speedlist [keyt], xt-speedlist [data-value]')];
      return options.find(option => {
        if (option.disabled || option.getAttribute('aria-disabled') === 'true' || option.classList.contains('is-disabled')) return false;
        for (const attr of ['data-speed', 'keyt', 'data-value']) {
          const raw = option.getAttribute(attr);
          if (raw !== null && raw !== '' && Number(String(raw).replace(/[xX\s]/g, '')) === rate) return true;
        }
        const match = String(option.textContent || '').trim().match(/^(\d+(?:\.\d+)?)\s*[xX]$/);
        return Boolean(match) && Number(match[1]) === rate;
      }) || null;
    },
    // 倍速列表是 CSS :hover 才显示的 display:none 菜单，合成鼠标事件不会真的 hover，
    // 所以这里先派发 mouseover/mousemove，再临时把列表强显，点完还原内联样式。
    openSpeedList(control) {
      const view = control.ownerDocument?.defaultView || window;
      const rect = control.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
        try {
          control.dispatchEvent(new view.MouseEvent(type, {
            bubbles: type !== 'mouseenter',
            cancelable: true,
            composed: true,
            view,
            clientX: x,
            clientY: y
          }));
        } catch (_) {}
      }
      const list = control.querySelector('xt-speedlist');
      if (!list || !list.style) return;
      if (!this.speedListStyles.has(list)) {
        this.speedListStyles.set(list, ['display', 'visibility', 'opacity'].map(prop => [
          prop,
          list.style.getPropertyValue(prop),
          list.style.getPropertyPriority(prop)
        ]));
      }
      list.style.setProperty('display', 'block', 'important');
      list.style.setProperty('visibility', 'visible', 'important');
      list.style.setProperty('opacity', '1', 'important');
    },
    restoreSpeedList(list) {
      const saved = this.speedListStyles.get(list);
      if (!saved) return;
      this.speedListStyles.delete(list);
      for (const [prop, value, priority] of [...saved].reverse()) {
        if (value) list.style.setProperty(prop, value, priority);
        else list.style.removeProperty(prop);
      }
    },
    // 2026 版播放器的倍速点击要求“先 mouseover、再有非零 mousemove 位移”，否则点了没反应
    clickSpeedOption(media, option) {
      const view = option.ownerDocument?.defaultView || media.ownerDocument?.defaultView || window;
      const rect = option.getBoundingClientRect?.() || { left: 10, top: 10, width: 0, height: 0 };
      const x = rect.left + rect.width / 2 || 10;
      const y = rect.top + rect.height / 2 || 10;
      for (const [type, px] of [['mouseover', x - 1], ['mousemove', x], ['mousedown', x], ['mouseup', x]]) {
        try {
          option.dispatchEvent(new view.MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view,
            clientX: px,
            clientY: y,
            button: 0,
            buttons: type === 'mousedown' ? 1 : 0
          }));
        } catch (_) {}
      }
      try {
        option.click();
      } catch (_) {}
    },
    // 悬停展开倍速列表后点中目标选项；播放器切换倍速时会同步改 video.playbackRate
    syncSpeedControl(media, rate) {
      const control = this.getSpeedControl(media);
      if (!control || !control.querySelector('xt-speedvalue')) return;
      if (this.getControlRate(control) === rate) {
        this.speedRequests.delete(media);
        this.speedAttempts.delete(media);
        return;
      }
      if (this.syncingSpeed.has(media)) return;
      const attempts = this.speedAttempts.get(media) || { count: 0, at: 0 };
      // 控件一直不跟着变（版本不兼容/列表没渲染）时逐步退避，避免每秒都去悬停弹菜单
      const cooldown = attempts.count >= 3 ? 15000 : 1500;
      const last = this.speedRequests.get(media);
      if (last && last.control === control && last.rate === rate && Date.now() - last.at < cooldown) return;
      this.speedRequests.set(media, { control, rate, at: Date.now() });
      this.speedAttempts.set(media, { count: attempts.count + 1, at: Date.now() });
      this.syncingSpeed.add(media);
      this.openSpeedList(control);
      setTimeout(() => {
        const list = control.querySelector('xt-speedlist');
        try {
          const option = this.findSpeedOption(media, rate);
          if (option) this.clickSpeedOption(media, option);
        } catch (_) {
        } finally {
          this.syncingSpeed.delete(media);
          if (list) setTimeout(() => this.restoreSpeedList(list), 400);
          // 原生控件这条路走不通时，至少让媒体真正变速（播放器界面可能仍显示旧值）
          setTimeout(() => {
            if (Math.abs(Number(media.playbackRate || 1) - rate) > 0.01) {
              try {
                media.playbackRate = rate;
              } catch (_) {}
            }
          }, 600);
        }
      }, 120);
    },
    applySpeedTo(media, rate = Number(Y.Config.playbackRate) || 1) {
      if (!media) return;
      if (Math.abs(Number(media.playbackRate || 1) - rate) > 0.01) {
        try {
          media.playbackRate = rate;
        } catch (_) {}
      }
      this.syncSpeedControl(media, rate);
    },
    // 原生静音按钮：xt-volumebutton > xt-icon，静音时图标带 xt_video_player_common_icon_muted
    getMuteControl(media) {
      const icon = this.queryPlayer(media, 'xt-volumebutton xt-icon');
      if (icon) return icon;
      const button = this.queryPlayer(media, 'xt-volumebutton');
      if (button) return button.querySelector('xt-icon') || button;
      // 兜底：只按“静音/音量”特征找，避免误点播放或全屏按钮
      const scope = this.getPlayerWrap(media);
      if (!scope) return null;
      const candidates = [...scope.querySelectorAll('[title*="静音"], [title*="音量"], [aria-label*="静音"], [aria-label*="音量"], [class*="mute"], [class*="volume"]')];
      for (const candidate of candidates) {
        const target = candidate.querySelector('xt-icon') || candidate;
        if (target.isConnected) return target;
      }
      return null;
    },
    isNativeMuted(icon) {
      if (!icon) return null;
      const classes = String(icon.getAttribute?.('class') || '');
      if (/xt_video_player_common_icon_muted/.test(classes)) return true;
      if (/(^|[\s_-])muted($|[\s_-])/i.test(classes) && !/unmuted/i.test(classes)) return true;
      const label = [
        icon.getAttribute?.('title'),
        icon.getAttribute?.('aria-label'),
        icon.parentElement?.getAttribute?.('title'),
        icon.parentElement?.getAttribute?.('aria-label')
      ].filter(Boolean).join(' ');
      if (!label) return null;
      if (/取消静音|取消声音|开启声音|声音已关|unmute/i.test(label)) return true;
      if (/静音|关闭声音|^mute$/i.test(label)) return false;
      return null;
    },
    applyMuteTo(media, muted = true) {
      if (!media) return;
      const icon = this.getMuteControl(media);
      const nativeMuted = this.isNativeMuted(icon);
      if (icon && nativeMuted === muted) this.muteClickAttempts.delete(media);
      if (icon && nativeMuted !== null && nativeMuted !== muted && !this.syncingMute.has(media)) {
        const lastClick = this.muteClickAt.get(media) || 0;
        const attempts = this.muteClickAttempts.get(media) || { count: 0, at: 0 };
        // 点了几次图标状态还不跟上，就停止点击（避免把静音来回切换），只靠下面的属性兜底
        const cooling = attempts.count >= 3 && Date.now() - attempts.at < 30000;
        if (!cooling && Date.now() - lastClick > 1500) {
          this.muteClickAt.set(media, Date.now());
          this.muteClickAttempts.set(media, { count: attempts.count + 1, at: Date.now() });
          this.syncingMute.add(media);
          try {
            icon.click();
          } catch (_) {
          } finally {
            this.syncingMute.delete(media);
          }
        }
      }
      if (muted) {
        // 播放器会自己把音量写回来：连续两次发现又被放开，就锁住这个 media 的音量
        if (!media.muted || Number(media.volume) > 0) {
          if (this.muteLocks.has(media)) this.unlockMute(media);
          const drift = (this.muteDrift.get(media) || 0) + 1;
          this.muteDrift.set(media, drift);
          if (drift >= 2) this.lockMute(media);
        }
        if (!this.muteLocks.has(media)) {
          if (!this.volumeBeforeMute.has(media) && Number(media.volume) > 0) {
            this.volumeBeforeMute.set(media, Number(media.volume));
          }
          if (!media.muted) {
            try {
              media.muted = true;
            } catch (_) {}
          }
          if (Number(media.volume) !== 0) {
            try {
              media.volume = 0;
            } catch (_) {}
          }
        }
      } else {
        // 只有“脚本自己静音过”才恢复音量；用户手动点播放器静音时不要每秒强行改回
        const restoreVolume = this.volumeBeforeMute.get(media);
        this.unlockMute(media);
        if (restoreVolume !== undefined && (media.muted || Number(media.volume) === 0)) {
          try {
            media.muted = false;
          } catch (_) {}
          try {
            media.volume = restoreVolume;
          } catch (_) {}
          this.volumeBeforeMute.delete(media);
        }
      }
    },
    // 媒体元素级静音锁：播放器再写 volume/muted 也不生效，保证挂机时真的没声音
    lockMute(media) {
      if (!media || this.muteLocks.has(media)) return;
      try {
        media.muted = true;
        media.volume = 0;
        Object.defineProperty(media, 'muted', { configurable: true, get: () => true, set: () => { } });
        Object.defineProperty(media, 'volume', { configurable: true, get: () => 0, set: () => { } });
        this.muteLocks.add(media);
        console.info('[刷课助手] 播放器反复恢复音量，已锁定媒体静音');
      } catch (_) {}
    },
    unlockMute(media) {
      if (!media || !this.muteLocks.has(media)) return;
      this.muteLocks.delete(media);
      this.muteDrift.delete(media);
      try {
        delete media.muted;
        delete media.volume;
        media.muted = false;
        media.volume = this.volumeBeforeMute.get(media) ?? 1;
      } catch (_) {}
      this.volumeBeforeMute.delete(media);
    },
    applySettings(media) {
      if (!media) return;
      const conf = Y.Store.getPlaybackConf();
      this.applySpeedTo(media, conf.playbackRate);
      this.applyMuteTo(media, conf.muted);
    },
    applyToAll(root = document) {
      for (const media of root.querySelectorAll('video, audio')) this.applySettings(media);
      for (const frame of root.querySelectorAll('iframe')) {
        try {
          if (frame.contentDocument) this.applyToAll(frame.contentDocument);
        } catch (_) {}
      }
    },
    // 兼容原有调用点：进入视频时统一应用倍速 + 静音
    applySpeed() {
      this.applyToAll();
    },
    mute() {
      this.applyToAll();
    },
    applyMediaDefault(media) {
      if (!media) return;
      this.applySettings(media);
      const playing = media.play();
      if (playing && typeof playing.catch === 'function') playing.catch(() => { });
    }
  };

  Y.PlayerControls = PlayerControls;
})(Y);
