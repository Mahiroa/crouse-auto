((Y) => {
  // 学习空间媒体接管与返回

  const WorkspaceMediaMixin = {
    // 接管这一节的播放器：记下它当时是哪一节、哪个媒体源，并开始监听它是否被换源。
    // 播放器复用同一个 <video> 换集时，一定会先派发 emptied / loadstart，这就是“已不是旧内容”的证据。
    rememberMedia(media, route) {
      if (!media) return;
      this.lastMedia = media;
      this.lastMediaInfo = {
        leafId: route?.leafId || '',
        nodeId: route?.nodeId || '',
        src: String(media.currentSrc || media.src || ''),
        at: Date.now()
      };
      this.mediaEpoch += 1;
      this.lastMediaEpoch = this.mediaEpoch;
      this.watchMediaSource(media);
    },
    watchMediaSource(media) {
      if (!media || this.watchedMedia === media) return;
      this.unwatchMediaSource();
      this.watchedMedia = media;
      this.mediaSourceBump = () => {
        if (this.watchedMedia !== media) return;
        this.mediaEpoch += 1;
        this.panel?.log?.('播放器已换源，按新播放器处理');
      };
      media.addEventListener('emptied', this.mediaSourceBump);
      media.addEventListener('loadstart', this.mediaSourceBump);
    },
    unwatchMediaSource() {
      if (this.watchedMedia && this.mediaSourceBump) {
        this.watchedMedia.removeEventListener('emptied', this.mediaSourceBump);
        this.watchedMedia.removeEventListener('loadstart', this.mediaSourceBump);
      }
      this.watchedMedia = null;
      this.mediaSourceBump = null;
    },
    // 换集后旧播放器经常还停在上一条结尾：这种媒体不能当作“这一节的新播放器”。
    // 只有两类证据能证明“同一个元素已经是这一节的新播放器”，才放行：
    //  ① 媒体源变了（currentSrc/src 与接管时不同）；
    //  ② 元素真的重新 load 过（emptied/loadstart 让 mediaEpoch 前进）。
    // 只看路由 leafId 不算证据：SPA 里路由常常比播放器换源先变，那样会把上一节停在结尾的
    // 旧元素当成本节播放器，直接误判“已播完”，比等 20 秒更危险。
    isStaleMedia(media) {
      if (!media) return true;
      if (media !== this.lastMedia) return false;
      const info = this.lastMediaInfo || {};
      const src = String(media.currentSrc || media.src || '');
      if (info.src && src && info.src !== src) return false;
      if (this.mediaEpoch !== this.lastMediaEpoch) return false;
      if (media.ended) return true;
      const duration = Number(media.duration || 0);
      const currentTime = Number(media.currentTime || 0);
      return duration > 1 && currentTime > 0 && duration - currentTime <= 0.5;
    },
    // 获取父窗口对象 window.opener
    getSourceWindow() {
      try {
        if (!window.opener || window.opener.closed) return null;
        if (window.opener.location.origin !== location.origin) return null;
        return window.opener;
      } catch (_) {
        return null;
      }
    },
    async returnToSource(returnUrl) {
      const sourceWindow = this.getSourceWindow();
      if (!sourceWindow) return false;
      try {
        this.panel.log('媒体播放完成，返回课程目录页继续下一节');
        await Y.Utils.sleep(800);
        sourceWindow.location.href = returnUrl;
        try { sourceWindow.focus(); } catch (_) {}
        await Y.Utils.sleep(600);
        try { window.close(); } catch (_) {}
        return true;
      } catch (e) {
        console.error('跳转父窗口异常', e);
        this.panel.log(`返回课程目录页失败：${e.message || e}`);
        return false;
      }
    },
    async handleMedia(route) {
      const title = Y.AiWorkspace.getActiveLeafTitle() || `${route.type} ${route.leafId}`;
      const stepId = `ai-${route.leafId || title}`;
      // 先问平台：侧栏三态会滞后（抓包里就有「接口 progress=1、侧栏还没打勾」的视频），
      // 只信侧栏会把已经刷完的节再播一遍。接口不可用时退回读侧栏圆环的百分比。
      const platformRate = await this.leafProgressNow(route.leafId);
      const domPercent = Y.AiWorkspace.leafDomPercent(this.activeBox());
      const knownRate = platformRate != null
        ? platformRate
        : (domPercent != null ? domPercent / 100 : null);
      // 观看日志比目录里的 progress 准：目录对视频是「最终完成度 ≥90% 就记 1」，
      // 只有 /video-log/detail/ 才给真实覆盖率和「哪几段没看过」。拿到就以日志为准。
      const log = await this.readVideoLog(route.leafId);
      const credited = log ? this.videoFullyCredited(log) : (knownRate != null && knownRate >= Y.DONE_RATE);
      if (credited) {
        const media = Y.AiWorkspace.getMedia();
        if (media && !media.paused) media.pause();
        const shownRate = log && log.rate != null ? log.rate : knownRate;
        this.panel.log(`${title} ${platformRate != null || log ? '平台' : '侧栏'}已记为完成（${Y.pctText(shownRate)}），跳过`);
        this.panel.track({ id: stepId, kind: 'video', title, status: 'done', detail: `已完成 ${Y.pctText(shownRate)}，跳过` });
        return true;
      }
      const alreadyDone = await Y.Utils.poll(() => Y.AiWorkspace.isCurrentLessonDone(), { interval: 200, timeout: 1500 });
      if (alreadyDone) {
        const media = Y.AiWorkspace.getMedia();
        if (media && !media.paused) media.pause();
        this.panel.log(`${title} 已经完成，跳过`);
        this.panel.track({ id: stepId, kind: 'video', title, status: 'done', detail: '已完成，跳过' });
        return true;
      }
      if (log) {
        this.logVideoGaps(log, `${title} `);
      } else if (knownRate != null && knownRate > 0 && knownRate < Y.DONE_RATE) {
        this.panel.log(`${title} 上次只刷到 ${Y.pctText(knownRate)}，这次先把这一节补满`);
      }
      // 已经看掉一大半、缺口只是几小段（拖拽/丢心跳留下的）：不用整段重播，
      // 直接按缺口补播即可 —— 这就是「重新播放未观看的部分」。缺口太大还是老老实实整段播。
      const patchOnly = Boolean(log)
        && log.gapSeconds > 0
        && log.videoLength > 0
        && (log.rate >= 0.5 || log.gapSeconds <= Math.max(180, log.videoLength * 0.35));
      this.panel.log(`开始播放：${title}`);
      this.panel.track({ id: stepId, kind: 'video', title, status: 'doing' });
      // 换集后旧的播放器常常还停在上一条结尾（ended），要先等“新的、能播的”媒体元素，
      // 否则会拿着上一节的残留元素判定失败，整条自动播放链就停在这里
      const stepStartedAt = Date.now();
      // 单次就绪预算保留 45 秒：回归台的 slow-start-25（前 25 秒 readyState=0）与
      // slow-swap-48（48 秒后才挂播放器）都要靠这段窗口 + handleStep 的第二次尝试才救得回来；
      // 实测缩到 20 秒会把这两个场景直接判死。真机上该砍的是「重试前的停顿」和
      // 「墙钟把休眠时间当等待」这两处（见 handleStep / poll），不是这段等待本身。
      const ready = await Y.Utils.poll(() => {
        const current = Y.AiWorkspace.getMedia();
        if (!current || current.seeking) return false;
        const duration = Number(current.duration || 0);
        if (current.readyState < 2 || !Number.isFinite(duration) || duration <= 1) return false;
        return !this.isStaleMedia(current);
      }, { interval: 400, timeout: 45000 });
      // 耗时要和墙钟分开：墙钟（Date.now 差值）会把后台标签页被节流、系统休眠的时间一起算进来，
      // 日志里就会冒出「等了 9783 秒」这种根本没发生过的数字；poll 记下的有效等待才是脚本真正等掉的
      // 时长（口径见 runner.js 的 pollSpentMs / throttleNote），拿不到时它会退回墙钟，行为与改动前一致。
      const readyWallMs = Date.now() - stepStartedAt;
      const readyCostMs = this.pollSpentMs(readyWallMs);
      const readyCost = readyCostMs / 1000;
      const readyNote = this.throttleNote(readyWallMs, readyCostMs);
      let media = Y.AiWorkspace.getMedia();
      if (!ready || !media) {
        this.panel.log(`等了 ${Math.round(readyCost)} 秒仍没等到可播放的视频/音频元素，本节先跳过${readyNote}`);
        return false;
      }
      this.rememberMedia(media, route);

      const playbackState = { completed: false };
      const shouldResume = () => !playbackState.completed;
      let stopObserve = () => { };
      if (media.tagName.toLowerCase() === 'video') {
        Y.Player.applySpeed();
        Y.Player.mute();
        stopObserve = Y.Player.observePause(media, shouldResume);
      } else {
        Y.Player.applyMediaDefault(media);
      }
      const stopKeepAlive = Y.AiWorkspace.keepAlive(shouldResume);
      const playback = Y.Store.getPlaybackConf();
      this.panel.log(`已接管播放器：${media.tagName.toLowerCase()}，目标倍速 ${playback.playbackRate}x，静音${playback.muted ? '开启' : '关闭'}（就绪等待 ${readyCost.toFixed(1)} 秒${readyNote}）`);
      if (patchOnly) {
        // 只看掉了一大半、缺口是几小段：不整段重播，直接按缺口补播。
        // 要先停掉 observePause —— 它每 1 秒 enforceSettings 一次，会把我们 seek 好的位置和
        // 1 倍速补刷速度盖回去，补刷就白补了。
        stopObserve();
        // 观察器停掉后播放器还在播，先按住：后面 2.5 秒「等平台补记账」的空档里让它继续播，
        // 会把续播点往后那几秒提前记上，缺口位置跟着变，补播就补错地方了
        try { media.pause(); } catch (_) { }
        let patchCredit = { verified: false, rate: log.rate };
        try {
          this.panel.log(`这一节平台记账 ${Y.pctText(log.rate)}，只补没看的 ${Y.VideoLedger.mark(log.gapSeconds)}，不整段重播`);
          this.panel.track({ id: stepId, kind: 'video', title, status: 'doing', detail: `只补缺口 ${Y.VideoLedger.mark(log.gapSeconds)}` });
          patchCredit = await this.ensureVideoCredited(route, title, stepId);
        } finally {
          stopKeepAlive();
        }
        if (this.blockedByHumanCheck) return true;
        await this.waitForMarked();
        if (patchCredit.rate != null && !patchCredit.verified) {
          // 补播没补满：老老实实记 skip，下一轮「目录补刷」还会再来，不再谎报 done
          this.creditSkipped.add(String(route.leafId || title));
          this.panel.warn(`${title} 平台记账只到 ${Y.pctText(patchCredit.rate)}，已记入待补，稍后继续补`);
          this.panel.track({ id: stepId, kind: 'video', title, status: 'skip', detail: `平台记账 ${Y.pctText(patchCredit.rate)}，补播后仍未满` });
          return true;
        }
        this.panel.log(`${title} 缺口已补齐（本节共 ${((Date.now() - stepStartedAt) / 1000).toFixed(1)} 秒）`);
        this.panel.track({ id: stepId, kind: 'video', title, status: 'done', detail: `补播缺口后平台记账 ${Y.pctText(patchCredit.rate)}` });
        return true;
      }
      let boundMedia = null;
      let onEnded = () => { };
      try {
        const startTime = Number(media.currentTime || 0);
        const started = await Y.Utils.poll(() => {
          const currentMedia = Y.AiWorkspace.getMedia();
          if (currentMedia) media = currentMedia;
          if (!media) return false;
          // 这一节本来就从结尾续播（上次已看到最后几秒）：没有可播的增量，
          // 直接按“已播完”继续，否则会白等 30 秒再跳过本节
          Y.Player.noteDuration(media);
          if (Y.AiWorkspace.isPlayerFinished(media)) {
            this.panel.log('播放器已停在结尾，按已播完继续');
            return true;
          }
          const currentTime = Number(media.currentTime || 0);
          return currentTime > startTime + 0.5 || (!media.paused && media.readyState >= 2 && currentTime > startTime + 0.2);
        }, { interval: 500, timeout: 30000 });
        if (!started) {
          if (Y.Utils.humanCheckMode() === 'skip' && Y.Utils.isHumanCheckVisible()) {
            this.panel.log('检测到人机验证，跳过本节并进入下一项');
            this.panel.track({ id: stepId, kind: 'video', title, status: 'skip', detail: '安全核验，已跳过' });
            return true;
          }
          this.panel.log('30 秒内没确认到视频真正开始播放，本节先跳过');
          return false;
        }

        let resolveEnded;
        const endedPromise = new Promise(resolve => {
          resolveEnded = resolve;
        });
        // ended 就是这一节播完，不再额外要求“至少播放了 3 秒”：
        // 从上次看的进度续播到结尾时，播放增量很小，但这一节确实结束了
        onEnded = (event) => {
          const target = event.currentTarget;
          if (!target || !target.isConnected) return;
          playbackState.completed = true;
          resolveEnded(true);
        };
        const bindEnded = (nextMedia) => {
          if (!nextMedia || boundMedia === nextMedia) return;
          if (boundMedia) boundMedia.removeEventListener('ended', onEnded);
          boundMedia = nextMedia;
          boundMedia.addEventListener('ended', onEnded);
        };
        bindEnded(media);
        const done = await Promise.race([
          endedPromise,
          Y.Utils.poll(() => {
            if (playbackState.completed) return true;
            const currentMedia = Y.AiWorkspace.getMedia();
            if (currentMedia && currentMedia !== media) {
              media = currentMedia;
              bindEnded(media);
            }
            if (!media || !media.isConnected) return false;
            Y.Player.noteDuration(media);
            if (Y.AiWorkspace.isPlayerFinished(media)) {
              playbackState.completed = true;
              return true;
            }
            return false;
          }, { interval: 1000, timeout: await Y.Utils.getDDL() })
        ]);
        playbackState.completed = true;
        if (!done) this.panel.log('等待播放完成超时，准备进入下一集');
      } finally {
        if (boundMedia) boundMedia.removeEventListener('ended', onEnded);
        stopObserve();
        stopKeepAlive();
      }

      this.rememberMedia(media, route);
      // 播到结尾 ≠ 平台记账 100%：回头查 rate，差多少补多少
      const credit = await this.ensureVideoCredited(route, title, stepId);
      if (this.blockedByHumanCheck) return true;
      await this.waitForMarked();
      this.panel.log(`${title} 播放完成（本节共 ${((Date.now() - stepStartedAt) / 1000).toFixed(1)} 秒）`);
      // rate == null：接口根本读不到（断网/降级），这时候没有任何依据说「没刷完」，
      // 只能按页面标记走（3.4.0 就是这个口径）。只有「读到了百分比且确实没满」才记 skip。
      if (credit.rate != null && !credit.verified) {
        // 补刷没补满：老老实实记 skip，下一轮「目录补刷」还会再来，不再谎报 done
        this.creditSkipped.add(String(route.leafId || title));
        this.panel.warn(`${title} 平台记账只到 ${Y.pctText(credit.rate)}，已记入待补，稍后继续补`);
        this.panel.track({ id: stepId, kind: 'video', title, status: 'skip', detail: `平台记账 ${Y.pctText(credit.rate)}，补刷后仍未满` });
        return true;
      }
      this.panel.track({
        id: stepId,
        kind: 'video',
        title,
        status: 'done',
        detail: credit.rate != null ? `平台记账 ${Y.pctText(credit.rate)}` : '播放结束'
      });
      return true;
    }
  };

  Y.WorkspaceMediaMixin = WorkspaceMediaMixin;
})(Y);
