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
    // ---- 后台播放解锁：窗口最小化后不被 Chrome 当「video-only」暂停 ----
    // 触发链在 Chromium 的 WebMediaPlayerImpl::ShouldPausePlaybackWhenHidden()：
    //   页面隐藏（最小化 / 切走）→ preserve_audio 为 false 就直接 Pause(kPageHidden)，
    //   控制台里那条 AbortError 就是 “video-only background media was paused to save power”。
    // 其中 preserve_audio = HasUnmutedAudio() = HasAudio() && !WasAlwaysMuted()，
    // 而 Blink 的 was_always_muted_ 是一次性闩锁（html_media_element.cc::UpdatePlayState）：
    // 元素只要在「正在播放 + muted 为 false」时过一遍 UpdatePlayState 就永久变 false，
    // 之后就算重新静音，Chrome 仍按「有未静音音频」放行后台播放。
    // 脚本默认静音，元素从加载起就没解过静音 → 最小化后就被浏览器按 video-only 停掉，
    // 用户看到的就是「窗口最小化一会儿视频自己暂停」（偶发：取决于最小化时长与播放器状态）。
    // 修法：接管播放器时先 muted=false + volume=0 播一下把闩锁打掉，拿到 playing/timeupdate
    // 后再恢复用户的静音设置。全程音量为 0 —— 人听不到；Chrome 自动播放判定用的是
    // EffectiveMediaVolume()，0 视作静音，所以也不会触发「未静音要用户手势」的拦截。
    backgroundUnlockTried: new WeakSet(),
    backgroundLatchPending: new WeakSet(),
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
      // 这里的合成 hover 是唯一通道（CSS :hover 无法用原生 .click() 触发），不是失败兜底，保留原行为
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
      // 合成 mouseover→mousemove 是站点要求的前置（见上条注释），必须排在原生 click 之前，不能改成「先 click 失败再合成」
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
    // 打掉 Blink 的「从未解除静音」闩锁（细节见文件顶部 backgroundUnlockTried 的注释）。
    // 只在媒体真的在播时动手：暂停中的元素 play() 可能被拦或把结尾状态打乱，
    // 而 observePause / keepAlive 的校正循环 0.8~1.4 秒一轮，播放起来后自然会再进来。
    ensureBackgroundPlayback(media) {
      if (!media || this.backgroundUnlockTried.has(media)) return;
      let conf = null;
      try {
        conf = Y.Store.getPlaybackConf();
      } catch (_) {}
      // 用户本来就没静音：元素真的放过声音，闩锁早就落了，不用折腾
      if (conf && conf.muted === false) {
        this.backgroundUnlockTried.add(media);
        return;
      }
      if (media.paused || media.ended) return;
      // 还没拿到媒体元数据时 play() 过不了 Blink 的 should_be_playing，闩锁落不下来；
      // 这种情况不记「已尝试」，等 readyState 上来后（enforce 循环下一轮）再补
      if (Number(media.readyState || 0) < 2) return;
      this.backgroundUnlockTried.add(media);
      this.backgroundLatchPending.add(media);
      let timer = null;
      const finish = () => {
        if (!this.backgroundLatchPending.has(media)) return;
        this.backgroundLatchPending.delete(media);
        try {
          media.removeEventListener('playing', finish);
          media.removeEventListener('timeupdate', finish);
          media.removeEventListener('pause', finish);
          media.removeEventListener('ended', finish);
        } catch (_) {}
        if (timer) clearTimeout(timer);
        // 闩锁落下后立刻把静音还回去：声音开关始终按用户设置，后台不暂停才是这次改动的目的
        let muted = true;
        try {
          muted = Y.Store.getPlaybackConf().muted !== false;
        } catch (_) {}
        try {
          this.applyMuteTo(media, muted);
        } catch (_) {}
      };
      try {
        // 静音锁会把 muted/volume 劫持成常量，先解开才能写进去（finish 里按需重新上锁）。
        // 这里不用 unlockMute()：它会先把音量恢复到静音前的值，等于让视频响一下；
        // 只摘掉访问器，音量马上被下面写成 0
        if (this.muteLocks.has(media)) {
          this.muteLocks.delete(media);
          this.muteDrift.delete(media);
          delete media.muted;
          delete media.volume;
        }
        // 闩锁窗口会先把音量压到 0，这里必须替 applyMuteTo 把「静音前的音量」记下来，
        // 否则面板里把静音关掉时没有可恢复的值，会变成「未静音但没声音」
        if (!this.volumeBeforeMute.has(media) && Number(media.volume) > 0) {
          this.volumeBeforeMute.set(media, Number(media.volume));
        }
        // 顺序要紧：先 volume=0 再 muted=false。反过来的话 Chrome 的 setMuted(false) 会看到
        // 非 0 的有效音量，去要用户的「未静音授权」，被拒就直接 pause() —— 修复反而把视频停了
        media.volume = 0;
        media.muted = false;
      } catch (_) {}
      try {
        media.addEventListener('playing', finish);
        media.addEventListener('timeupdate', finish);
        // 闩锁窗口里被暂停/播完，就没必要继续挂着「未静音」：提前把静音还回去
        media.addEventListener('pause', finish);
        media.addEventListener('ended', finish);
      } catch (_) {}
      try {
        // play() 内部会跑一遍 UpdatePlayState，闩锁就在那一瞬间落下
        const playing = media.play();
        if (playing && typeof playing.catch === 'function') playing.catch(() => {});
      } catch (_) {}
      // 兜底：一直没 playing/timeupdate 也要把静音还回去，绝不能让元素永远停在「未静音」
      timer = setTimeout(finish, 8000);
    },
    applyMuteTo(media, muted = true) {
      if (!media) return;
      // 已经播完的媒体不再写 muted/volume：真实浏览器里这只是无意义的写入，
      // 而「播完再改音量」在某些播放器桩/接管逻辑里会被当成「重新开播」，
      // 把 ended 状态打掉（回归台 slow-swap 就是这样被打乱的）。
      // 元素被复用播下一节时，applySettings 会重新套一遍设置。
      if (media.ended) return;
      // 闩锁窗口内保持「muted=false + volume=0」：对人是静音，对 Chrome 是「有未静音音频」
      if (this.backgroundLatchPending.has(media)) {
        try {
          // 同 ensureBackgroundPlayback：先把音量压到 0，再保持未静音，避免触发「未静音授权」
          if (Number(media.volume) !== 0) media.volume = 0;
          if (media.muted) media.muted = false;
        } catch (_) {}
        return;
      }
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
        Y.Stealth?.note?.('播放器反复恢复音量，已锁定媒体静音');
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
      // 先解锁后台播放，再执行用户设置的静音：闩锁窗口内 applyMuteTo 会主动让路
      this.ensureBackgroundPlayback(media);
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
      // 音频也要解锁后台播放：play() 落地之后再打闩锁（此时元素才满足「正在播放」）
      if (playing && typeof playing.catch === 'function') {
        playing.then(() => this.ensureBackgroundPlayback(media)).catch(() => { });
      } else {
        this.ensureBackgroundPlayback(media);
      }
    }
  };

  Y.PlayerControls = PlayerControls;
})(Y);
