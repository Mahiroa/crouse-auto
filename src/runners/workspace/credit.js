((Y) => {
  // 观看缺口补刷与记满

  const WorkspaceCreditMixin = {
    // 平台记账没满时把「哪几段没看」说清楚，面板里能直接对照观看日志弹窗
    logVideoGaps(info, prefix = '') {
      if (!info) return;
      const gaps = Array.isArray(info.gaps) ? info.gaps : [];
      const head = `${prefix}平台记账 ${Y.pctText(info.rate)}`;
      if (!gaps.length) {
        this.panel.log(`${head}，没有可补的缺口`);
        return;
      }
      this.panel.warn(`${head}：有 ${gaps.length} 段没看过（共 ${Y.VideoLedger.mark(info.gapSeconds)}）—— ${Y.VideoLedger.describe(gaps)}`);
    },
    // 播放器播到结尾 ≠ 平台记账 100%。rate = 已观看区间并集 / video_length：
    // 抓包里 last_point 已经 1173.8（≥ 时长 1173.0），rate 却只有 0.7765 —— 因为中间被
    // 拖过去的那几段从来没真播过，平台不认。3.4.0 以前按「缺口 = (1-rate)*时长」估一个秒数
    // 从尾部补，位置是猜的：缺口在中间就完全补不到。
    // 现在改成按 /video-log/detail/ 的 result 区间表算真实缺口，逐段 seek 过去播完，
    // 播完再读一次日志核对缺口有没有真的变少（闭环），没变少就换 1 倍速重试一轮。
    async ensureVideoCredited(route, title, stepId) {
      // 接口不可用时不留任何额外等待：保持 3.3.2「播完立刻进下一节」的口径
      const api = this.platformApi();
      if (!api || !api.enabled) return { verified: false, rate: null };
      const classroomId = this.currentClassroomId();
      if (!classroomId || !route?.leafId) return { verified: false, rate: null };
      const readLog = () => (typeof api.videoLog === 'function'
        ? api.videoLog(classroomId, route.leafId)
        : null);
      let info = await readLog();
      if (!info) {
        // 拿不到观看日志（老接口/权限不足）就退回 3.4.0 的纯 rate 口径，功能不倒退
        return this.ensureVideoCreditedByRate(route, title, stepId);
      }
      if (this.videoFullyCredited(info)) {
        this.panel.log(`平台记账已满：${Y.pctText(info.rate)}${info.gapSeconds ? `（残余 ${Y.VideoLedger.mark(info.gapSeconds)}）` : ''}`);
        return { verified: true, rate: info.rate };
      }
      // 平台 30 秒才发一批心跳，刚播完那几十秒可能还在路上，先等一轮再看
      await Y.Utils.sleep(2500);
      const settled = await readLog();
      if (settled) info = settled;
      if (this.videoFullyCredited(info)) {
        this.panel.log(`平台记账已满：${Y.pctText(info.rate)}`);
        return { verified: true, rate: info.rate };
      }
      this.logVideoGaps(info, '');
      const playback = Y.Store.getPlaybackConf();
      // 补刷倍速：默认跟随配置（抓包里 sp=2 的片段照样进 result，倍速本身不折价），
      // 只有「补完一点没涨」时才退到 1 倍速再试一轮。
      let speed = Number(playback.playbackRate) > 0 ? Math.min(Number(playback.playbackRate), 2) : 1;
      let previous = info.gapSeconds;
      for (let pass = 1; pass <= 3; pass++) {
        const gaps = (Array.isArray(info.gaps) ? info.gaps : [])
          .filter(gap => gap && gap.e - gap.s >= Y.VideoLedger.MIN_GAP);
        if (!gaps.length) break;
        this.panel.track({
          id: `${stepId}-makeup`,
          kind: 'video',
          title,
          status: 'doing',
          detail: `补播没看的 ${gaps.length} 段（${Y.VideoLedger.mark(info.gapSeconds)}，${speed} 倍速）`
        });
        this.panel.log(`第 ${pass} 次补播：${gaps.length} 段、共 ${Y.VideoLedger.mark(info.gapSeconds)}，${speed} 倍速`);
        const played = await this.replayGaps(gaps, { speed });
        if (this.blockedByHumanCheck) {
          // 走统一收口：置停住标志 + 记 skip + 把「开始刷课」按钮复位成可再点
          // （直接置标志而不复位按钮的话，面板会卡在「刷课中…」，用户点开始只会被忽略）
          this.noteVerificationBlock(title, stepId, '补刷时遇到安全核验');
          break;
        }
        if (!played.ok) {
          this.panel.warn('补刷时拿不到可播放的播放器，停止补刷');
          break;
        }
        await Y.Utils.sleep(2000);
        const after = await readLog();
        if (!after) {
          this.panel.warn('补刷后读不到观看日志，按未核对处理');
          break;
        }
        info = after;
        if (this.videoFullyCredited(info)) {
          this.panel.log(`补刷完成：平台记账 ${Y.pctText(info.rate)}`);
          this.panel.track({ id: `${stepId}-makeup`, kind: 'video', title, status: 'done', detail: `补播后平台记账 ${Y.pctText(info.rate)}` });
          return { verified: true, rate: info.rate };
        }
        const improved = info.gapSeconds < previous - 0.5;
        this.logVideoGaps(info, '补播后');
        if (!improved) {
          if (speed > 1) {
            speed = 1;
            previous = info.gapSeconds;
            this.panel.warn('补播后缺口一点没少，改用 1 倍速再试一轮');
            continue;
          }
          this.panel.warn('平台在重播时没有继续记账（1 倍速也一样），先不补了');
          break;
        }
        previous = info.gapSeconds;
      }
      this.panel.track({ id: `${stepId}-makeup`, kind: 'video', title, status: 'skip', detail: `补播后平台记账 ${Y.pctText(info.rate)}` });
      return { verified: false, rate: info.rate };
    },
    // 老口径（拿不到观看日志时的兜底）：只看 rate，缺多少按比例估一个秒数从尾部补。
    // 位置是猜的 —— 缺口在中间补不到，所以只在 videoLog 不可用时才走这条路。
    async ensureVideoCreditedByRate(route, title, stepId) {
      const api = this.platformApi();
      if (!api || !api.enabled) return { verified: false, rate: null };
      const classroomId = this.currentClassroomId();
      if (!classroomId || !route?.leafId) return { verified: false, rate: null };
      const probe = async () => {
        const info = await api.videoProgress(classroomId, route.leafId);
        return info && info.rate != null ? info.rate : null;
      };
      let info = await api.videoProgress(classroomId, route.leafId);
      if (!info || info.rate == null) return { verified: false, rate: null };
      if (info.rate < Y.DONE_RATE) {
        await Y.Utils.sleep(2500);
        const again = await api.videoProgress(classroomId, route.leafId);
        if (again && again.rate != null) info = again;
      }
      if (info.rate >= Y.DONE_RATE) {
        this.panel.log(`平台记账已满：${Y.pctText(info.rate)}`);
        return { verified: true, rate: info.rate };
      }
      let rate = info.rate;
      const length = info.videoLength || 0;
      this.panel.warn(`平台记账还没满：${Y.pctText(rate)}`
        + `${length ? `（watch ${Math.round(info.watchLength)}s / ${Math.round(length)}s）` : ''}`
        + '；这一版没拿到观看日志区间，只能按尾部估着补');
      for (let pass = 1; pass <= 3; pass++) {
        const need = Math.max(8, Math.ceil((1 - rate) * (length || 600) * 1.15) + 5);
        this.panel.track({
          id: `${stepId}-makeup`,
          kind: 'video',
          title,
          status: 'doing',
          detail: `尾部补刷第 ${pass} 次（平台记账 ${Y.pctText(rate)}）`
        });
        const result = await this.playSeasonPass(need, probe);
        if (!result.ok) {
          this.panel.warn('补刷时拿不到可播放的播放器，停止补刷');
          break;
        }
        if (this.blockedByHumanCheck) {
          this.noteVerificationBlock(title, stepId, '补刷时遇到安全核验');
          break;
        }
        await Y.Utils.sleep(2000);
        const after = await probe();
        if (after != null) rate = after;
        if (rate >= Y.DONE_RATE) {
          this.panel.log(`补刷完成：平台记账 ${Y.pctText(rate)}`);
          this.panel.track({ id: `${stepId}-makeup`, kind: 'video', title, status: 'done', detail: `补刷后平台记账 ${Y.pctText(rate)}` });
          return { verified: true, rate };
        }
        if (result.stalled) {
          this.panel.warn(`平台在重播时没有继续记账（停在 ${Y.pctText(rate)}），先不补了`);
          break;
        }
      }
      this.panel.track({ id: `${stepId}-makeup`, kind: 'video', title, status: 'skip', detail: `补刷后平台记账 ${Y.pctText(rate)}` });
      return { verified: false, rate };
    },
    // 逐段补播：第 i 段从 s 播到 e，播完再跳下一段。
    // 为什么 seek 过去是安全的：平台按 timeupdate 采样 cp，只把「连续向前的一小步」并进 result；
    // 跳过去的跨度不算数（前端弹窗原话「观看时有拖拽行为，拖拽部分显示未观看」）。
    // 所以从缺口起点开始连续播，正好把这一段从「未观看」变成「已观看」。
    async replayGaps(gaps, { speed = 1 } = {}) {
      const list = (Array.isArray(gaps) ? gaps : []).filter(gap => gap && gap.e - gap.s >= Y.VideoLedger.MIN_GAP);
      if (!list.length) return { ok: true, played: 0, done: 0, total: 0 };
      await this.waitPlayerReady(15000);
      const media = Y.AiWorkspace.getMedia();
      if (!media) return { ok: false, played: 0, done: 0, total: list.length };
      const targetSpeed = Number(speed) > 0 ? Math.min(Number(speed), 2) : 1;
      const prevSpeed = Number(media.playbackRate) || 1;
      let done = 0;
      try {
        for (let i = 0; i < list.length; i++) {
          const gap = list[i];
          this.panel.log(`补播第 ${i + 1}/${list.length} 段：${Y.VideoLedger.mark(gap.s)} → ${Y.VideoLedger.mark(gap.e)}`
            + `（${Math.round(gap.e - gap.s)} 秒）`);
          const ok = await this.playRange(gap, { speed: targetSpeed });
          if (this.blockedByHumanCheck) break;
          if (!ok) {
            this.panel.warn(`第 ${i + 1} 段没播成（播放器不配合或卡住），先跳过这一段`);
            continue;
          }
          done += 1;
        }
        return { ok: done > 0, played: 0, done, total: list.length };
      } finally {
        try { media.playbackRate = prevSpeed; } catch (_) { }
        try { media.pause(); } catch (_) { }
      }
    },
    // 把 [gap.s, gap.e) 真正播完。返回 false 表示这段没播成（seek 被回滚 / 卡住 / 播到结尾）。
    async playRange(gap, { speed = 1 } = {}) {
      const startAt = Math.max(0, Number(gap.s) || 0);
      const endAt = Number(gap.e);
      // seek 是「拖拽」，位置可能被播放器按防拖拽策略回滚；回滚了就重试一次，仍不行就放弃这一段
      const seekTo = async value => {
        const element = Y.AiWorkspace.getMedia();
        if (!element) return false;
        try { element.currentTime = value; } catch (_) { }
        await Y.Utils.sleep(350);
        const now = Number(Y.AiWorkspace.getMedia()?.currentTime || 0);
        return Math.abs(now - value) <= 2;
      };
      let media = Y.AiWorkspace.getMedia();
      if (!media) return false;
      if (Math.abs(Number(media.currentTime || 0) - startAt) > 1.5) {
        if (!await seekTo(startAt)) {
          await Y.Utils.sleep(200);
          if (!await seekTo(startAt)) {
            this.panel.warn(`播放器不接受跳到 ${Y.VideoLedger.mark(startAt)}（可能是防拖拽），这一段跳过`);
            return false;
          }
        }
      }
      media = Y.AiWorkspace.getMedia() || media;
      try { media.muted = true; } catch (_) { }
      // 多播 0.5 秒：平台的 cp 是采样值，正好停在缺口右端的话最后那一小截可能记不上
      const totalLength = Number(media.duration) || 0;
      const stopAt = totalLength > 0 ? Math.min(endAt + 0.5, totalLength) : endAt + 0.5;
      const playing = media.play();
      if (playing && typeof playing.catch === 'function') playing.catch(() => { });
      const startedAt = Date.now();
      let lastPos = Number(media.currentTime || 0);
      let movedAt = Date.now();
      while (true) {
        await Y.Utils.sleep(500);
        // 用 getMedia 拿当前元素：换集/播放器重挂时旧引用会失效
        const current = Y.AiWorkspace.getMedia() || media;
        if (!current || !current.isConnected) return false;
        Y.Player.noteDuration(current);
        if (Number(current.playbackRate) !== speed) {
          try { current.playbackRate = speed; } catch (_) { }
        }
        if (current.paused) {
          const again = current.play();
          if (again && typeof again.catch === 'function') again.catch(() => { });
        }
        const pos = Number(current.currentTime || 0);
        if (pos >= stopAt - 0.25) return true;
        // 播到材料结尾也算这一段补完（缺口一直延到片尾的情况）
        if (Y.AiWorkspace.isPlayerFinished(current)) return true;
        if (pos > lastPos + 0.2) {
          lastPos = pos;
          movedAt = Date.now();
        } else if (Date.now() - movedAt > 8000) {
          this.panel.warn(`补播卡在 ${Y.VideoLedger.mark(pos)} 不动（8 秒没推进），停止这一段`);
          return false;
        }
        // 补播一播就是几分钟，中途弹安全核验必须立刻收手，不能继续播、继续打接口
        if (Y.Utils.humanCheckMode() === 'skip' && Y.Utils.isHumanCheckVisible()) {
          this.blockedByHumanCheck = true;
          this.panel.warn('补刷时检测到安全核验，已停止补刷');
          return false;
        }
        if ((Date.now() - startedAt) / 1000 > 7200) {
          this.panel.warn('单段补播超过 2 小时，强制收手');
          return false;
        }
      }
    },
    // 兜底口径用：回到尾部、1 倍速播放 needSec 秒（原 3.4.0 的 playCreditPass）
    async playSeasonPass(needSec, probe = null) {
      await this.waitPlayerReady(15000);
      const media = Y.AiWorkspace.getMedia();
      if (!media) return { ok: false, rate: null, stalled: false };
      const state = { stop: false };
      const prevRate = Number(media.playbackRate) || 1;
      let stalled = false;
      try {
        // 兜底路径没有区间表、只能盲补，所以这里固定 1 倍速：
        // 抓包里 2 倍速的采样照样进 result（倍速本身不折价），但盲补不需要再赌一层
        media.playbackRate = 1;
        try { media.muted = true; } catch (_) { }
        const duration = Number(media.duration) || 0;
        let startAt = 0;
        if (duration > needSec + 10) {
          // 起点只能按「缺口 = (1-rate)×时长，大概在片尾」猜；真机证明这猜法对中间缺口无效，
          // 所以只在 /video-log/detail/ 拿不到时才走这里
          startAt = Math.max(0, duration - needSec - 5);
          try { media.currentTime = startAt; } catch (_) { }
          await Y.Utils.sleep(400);
          if (Math.abs(Number(media.currentTime || 0) - startAt) > 2) startAt = 0;
        }
        try { media.currentTime = startAt; } catch (_) { }
        // 注意：这里**不能**用 Player.observePause —— 它每 1 秒 enforceSettings 一次，
        // 会把倍速重新按配置（默认 2 倍）盖回去，补刷就白补了。改成自己续播。
        const playing = media.play();
        if (playing && typeof playing.catch === 'function') playing.catch(() => { });
        const startedAt = Date.now();
        let lastProbeAt = startedAt;
        let baseline = null;
        let stagnant = 0;
        while (!state.stop) {
          await Y.Utils.sleep(1000);
          const current = Y.AiWorkspace.getMedia() || media;
          if (!current || !current.isConnected) break;
          Y.Player.noteDuration(current);
          if (Y.AiWorkspace.isPlayerFinished(current)) break;
          if (current.playbackRate !== 1) {
            try { current.playbackRate = 1; } catch (_) { }
          }
          if (current.paused) {
            const again = current.play();
            if (again && typeof again.catch === 'function') again.catch(() => { });
          }
          const elapsed = (Date.now() - startedAt) / 1000;
          if (elapsed >= needSec) break;
          if (Y.Utils.humanCheckMode() === 'skip' && Y.Utils.isHumanCheckVisible()) {
            this.blockedByHumanCheck = true;
            this.panel.warn('补刷时检测到安全核验，已停止补刷');
            break;
          }
          if (typeof probe === 'function' && Date.now() - lastProbeAt >= 30000) {
            lastProbeAt = Date.now();
            const value = await probe();
            if (value == null) continue;
            if (value >= Y.DONE_RATE) break;
            if (baseline == null || value > baseline + 0.005) {
              baseline = value;
              stagnant = 0;
            } else {
              stagnant += 1;
              if (stagnant >= 2) {
                stalled = true;
                break;
              }
            }
          }
        }
        return { ok: true, stalled };
      } catch (err) {
        this.panel.log(`补刷播放异常：${err?.message || err}`);
        return { ok: false, stalled };
      } finally {
        state.stop = true;
        try { media.playbackRate = prevRate; } catch (_) { }
        try { media.pause(); } catch (_) { }
      }
    },
    // 播放器到结尾后等平台把这一节标成已完成。
    // 3.3.1 及以前只等侧栏目录项的标记，超时固定 40 秒：真机上「已完成」先出现在播放器左上角，
    // 侧栏要晚一步（有时要回目录页才同步），于是一集播完后脚本白等 40 秒才串下一集。
    // 现在两个信号都认：播放器/页面上的完成徽标、侧栏 active 项标记，外加“平台自己翻页了”，
    // 任一命中立刻返回；最长也只等 5 秒，没看到就直接进下一节（本节的 key 已进 handled，
    // 不会被重复播放），不再让固定超时拖住整条串播链。
    async waitForMarked() {
      const before = this.stepSnapshot();
      const startedAt = Date.now();
      this.panel.log('播放器已到结尾，等待课程显示已完成');
      let judgeFailed = false;
      const marked = await Y.Utils.poll(() => {
        // 判定只能返回 boolean：任何 DOM 异常都不能把整条串播链打断
        try {
          return Y.AiWorkspace.isLessonDoneBadge() || Y.AiWorkspace.isActiveLessonMarked() || !this.sameStep(before);
        } catch (err) {
          if (!judgeFailed) {
            judgeFailed = true;
            this.panel.log(`完成标记判定异常，按未标记处理：${err?.message || err}`);
          }
          return false;
        }
      }, { interval: 250, timeout: 5000 });
      const cost = (Date.now() - startedAt) / 1000;
      if (marked) this.panel.log(`已完成标记已确认（等 ${cost.toFixed(1)} 秒），进入下一节`);
      else this.panel.log(`等了 ${cost.toFixed(1)} 秒仍未显示已完成，直接进入下一节（平台可能稍后补记）`);
      return true;
    }
  };

  Y.WorkspaceCreditMixin = WorkspaceCreditMixin;
})(Y);
