((Y) => {
  // 观看缺口补刷与记满

  // ---- 补播闭环的三个常量（3.6.0）----
  // 冷却窗口：一次补播**真的跑过**、最后还是没记满，这一节 30 分钟内不再重复补。
  // 真机日志里「第 1 次补播：24 段、共 09:01」跑完只涨 2 个百分点，然后又从头补一轮 ——
  // 补不动就等一段时间再试，比连着白播 9 分钟强。
  const CREDIT_COOLDOWN_MS = 30 * 60 * 1000;
  // 每段补播前的预滚秒数。默认 0：预滚针对的是「seek 后 fp/tp 会一直带下去、每段开头几秒
  // 可能入不了账」这条【推断】，还没有真机数据证明它有效；而它会把起播点前移到缺口之前，
  // 回归台的 video-gap-middle 要求「必须跳到缺口起点 5s 附近」，开了就判不过（实测）。
  // 等真机确认「每段补完确实没进 result」再把这里调到 5 即可，replayGaps / playRange 的
  // preRoll 参数都还在，不需要改结构。
  const CREDIT_PRE_ROLL = 0;
  // 连续几段「播完却没进 result」就判定这一轮白播
  const CREDIT_MISS_STREAK = 3;

  // 单段核验：这一段补播有没有真的被记账 —— intervals 里存在一段把
  // [gap.s, min(gap.s + 3, gap.e)] 整个盖住的区间，就算这一段进账了。
  // 左端给 1 秒容差：VideoLedger.normalize 合并相邻区间用的是 0.5 秒容差，
  // 再加上平台 result 的右端会比时长多 1~2 秒，边界上本来就有半秒级取整。
  // 右端只要求盖住缺口开头 3 秒（而不是一直到 gap.e）：心跳大约 5 秒采样一次
  // （docs/视频观看日志-取证.md §6.6），刚播完那几秒的记录可能还在路上；
  // 只要缺口开头进了 result，就说明「这一段开始入账了」，没必要把它判成没覆盖。
  // 【推断】「开头进 result ⇒ 整段会陆续入账」是从 §6.10（被判 Partial data anomaly 也照样
  // 部分入账）推出来的，没有逐条心跳对账，所以只拿它做「要不要继续播」的止损判据。
  const gapCovered = (log, gap) => {
    const intervals = Array.isArray(log?.intervals) ? log.intervals : null;
    if (!intervals || !gap) return false;
    const left = Number(gap.s);
    const right = Number(gap.e);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    const target = Math.min(left + 3, right);
    return intervals.some(item => item
      && Number(item.s) <= left + 1
      && Number(item.e) >= target);
  };

  const WorkspaceCreditMixin = {
    // ---- 补播冷却表 ----
    // 结构：leafId -> { at, rate }。**只活在 runner 实例的内存里**：刷新页面 / 重开一轮就是空的，
    // 这是刻意的（也是可以接受的）—— 冷却只用来挡住「同一次运行里反复补同一节」；
    // 用户手动看完、平台延迟记账这些情况，刷新之后要能重新核对，不该被旧的失败记录一直挡着。
    creditCooldown() {
      if (!(this.creditRetryAfter instanceof Map)) this.creditRetryAfter = new Map();
      return this.creditRetryAfter;
    },
    // 冷却还剩多少毫秒；顺手把过期项删掉，避免长跑几十节后 Map 只增不减
    creditCooldownLeft(leafId) {
      const table = this.creditCooldown();
      const key = String(leafId || '');
      if (!key) return 0;
      const entry = table.get(key);
      if (!entry) return 0;
      const left = Number(entry.at || 0) + CREDIT_COOLDOWN_MS - Date.now();
      if (left > 0) return left;
      table.delete(key);
      return 0;
    },
    // 只在「补播跑过、最后还是没记满」时写；成功、快照、被安全核验打断都不写
    noteCreditFailure(leafId, rate) {
      const key = String(leafId || '');
      if (!key) return;
      const now = Date.now();
      const table = this.creditCooldown();
      for (const [id, entry] of table) {
        if (!entry || Number(entry.at || 0) + CREDIT_COOLDOWN_MS <= now) table.delete(id);
      }
      table.set(key, { at: now, rate: rate == null ? null : rate });
    },
    // 记满就清掉这一节的冷却：下次真有新缺口时不该被上一轮的失败挡住
    clearCreditCooldown(leafId) {
      const key = String(leafId || '');
      if (!key) return;
      this.creditCooldown().delete(key);
    },
    // 快照早退的统一收口：平台已经冻结这份观看日志，补播改不了记账，直接记 skip 并把 rate 原样交回
    snapshotSkipCredit(info, title, stepId) {
      this.panel.log('该视频的观看日志已快照（result 不再更新），补播不会改变记账');
      this.panel.track({
        id: `${stepId}-makeup`,
        kind: 'video',
        title,
        status: 'skip',
        detail: `观看日志已快照，补播不会改变记账（${Y.pctText(info?.rate)}）`
      });
      return { verified: false, rate: info ? info.rate : null };
    },
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
      const leafKey = String(route.leafId);
      // 冷却命中：这一节 30 分钟内已经补过且没记满，直接跳过，连观看日志都不用再读。
      // 返回上一次的 rate（不是 null）——调用方据此记 skip，不会谎报 done。
      const cooling = this.creditCooldownLeft(leafKey);
      if (cooling > 0) {
        const last = this.creditCooldown().get(leafKey);
        const lastRate = last && last.rate != null ? last.rate : null;
        this.panel.log(`本节点 30 分钟内已补过且未记满，先跳过，稍后重试（还剩约 ${Math.ceil(cooling / 60000)} 分钟）`);
        return { verified: false, rate: lastRate };
      }
      const readLog = () => (typeof api.videoLog === 'function'
        ? api.videoLog(classroomId, route.leafId)
        : null);
      let info = await readLog();
      if (!info) {
        // 拿不到观看日志（老接口/权限不足）就退回 3.4.0 的纯 rate 口径，功能不倒退
        return this.ensureVideoCreditedByRate(route, title, stepId);
      }
      // 快照早退：/video-log/detail/ 返回 is_snapshot 时，平台已经把这份观看日志**冻结**了，
      // result 不会再更新 —— 这时候补播多少遍都改不了记账，进 3 轮补播纯属白播。
      // 所以拿到 info 就先看这个开关（api.js 早就解析好了，这里一直没人用）。
      if (info.snapshot === true) {
        return this.snapshotSkipCredit(info, title, stepId);
      }
      if (this.videoFullyCredited(info)) {
        this.clearCreditCooldown(leafKey);
        this.panel.log(`平台记账已满：${Y.pctText(info.rate)}${info.gapSeconds ? `（残余 ${Y.VideoLedger.mark(info.gapSeconds)}）` : ''}`);
        return { verified: true, rate: info.rate };
      }
      // 平台 30 秒才发一批心跳，刚播完那几十秒可能还在路上，先等一轮再看
      await Y.Utils.sleep(2500);
      const settled = await readLog();
      if (settled) {
        info = settled;
        if (info.snapshot === true) {
          return this.snapshotSkipCredit(info, title, stepId);
        }
      }
      if (this.videoFullyCredited(info)) {
        this.clearCreditCooldown(leafKey);
        this.panel.log(`平台记账已满：${Y.pctText(info.rate)}`);
        return { verified: true, rate: info.rate };
      }
      this.logVideoGaps(info, '');
      const playback = Y.Store.getPlaybackConf();
      // 补刷倍速：默认跟随配置（抓包里 sp=2 的片段照样进 result，倍速本身不折价），
      // 只有「补完一点没涨」时才退到 1 倍速再试一轮。
      let speed = Number(playback.playbackRate) > 0 ? Math.min(Number(playback.playbackRate), 2) : 1;
      let previous = info.gapSeconds;
      // 单段闭环的状态：
      //   missStreak —— 连续几段「播完了但这段没进 result」，清零靠「这一段真被覆盖」
      //   gapProbe   —— 最近一次单段核验读到的日志，判定停止时直接拿它当最新 info，省一次请求
      let missStreak = 0;
      let gapProbe = null;
      let attempted = false;
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
        attempted = true;
        const played = await this.replayGaps(gaps, {
          speed,
          preRoll: CREDIT_PRE_ROLL,
          // 每段播完核一次「这一段到底进没进 result」。连续 3 段都没进就停：
          // 为什么是 3 —— 真机那 24 段共 09:01，平均一段约 22 秒，3 段≈67 秒，
          // 已经跨过心跳 30 秒一个上报批次（§6.5），所以连读 3 次都没有新覆盖，
          // 就不是「记录还在路上」，而是平台确实没记这一段，再往下播全是白播。
          // 每段只读一次观看日志（单请求、8 秒超时），不并发。
          onGapDone: async (i, gap, ok) => {
            if (!ok) return null;
            // 稍等一下：刚播完的那一批心跳可能正好要发出去（30 秒窗口，尽力而为）
            await Y.Utils.sleep(1000);
            const log = await readLog();
            if (!log) return null; // 读不到 = 没有信息，不当作「没覆盖」
            gapProbe = log;
            if (log.snapshot === true) {
              this.panel.warn('补播中平台把观看日志置成快照，后面的段不会再记账，停止本轮');
              return 'stop';
            }
            if (gapCovered(log, gap)) {
              missStreak = 0;
              return null;
            }
            missStreak += 1;
            this.panel.log(`第 ${i + 1} 段补播后没有出现在观看日志里（连续 ${missStreak}/${CREDIT_MISS_STREAK} 段）`);
            if (missStreak >= CREDIT_MISS_STREAK) {
              this.panel.warn('补播对这段没有记账（连续 3 段），停止本轮，避免白播');
              return 'stop';
            }
            return null;
          }
        });
        if (this.blockedByHumanCheck) {
          // 走统一收口：置停住标志 + 记 skip + 把「开始刷课」按钮复位成可再点
          // （直接置标志而不复位按钮的话，面板会卡在「刷课中…」，用户点开始只会被忽略）
          this.noteVerificationBlock(title, stepId, '补刷时遇到安全核验');
          break;
        }
        if (played.stopped) {
          // 已经在单段核验里判定「这一节补不动」：不再等 2 秒重读日志，直接用最后一次核验结果收口
          if (gapProbe) info = gapProbe;
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
          this.clearCreditCooldown(leafKey);
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
      // 冷却只写「真的补过、最后还是没记满」这一种；被安全核验打断的那一轮不写 ——
      // 用户处理完核验、点「开始刷课」时要能立刻重试这一节，不能被 30 分钟冷却挡住。
      if (attempted && !this.blockedByHumanCheck) this.noteCreditFailure(leafKey, info.rate);
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
    //
    // onGapDone(i, gap, ok)：可选的单段回调，每段播完（ok=true）调一次；返回 'stop' 时
    // 立刻中止剩余段并把这个意图带回给调用方（{ stopped: true }）。核验逻辑放在调用方，
    // 这里只管「播一段 → 问一句 → 要不要继续」。
    async replayGaps(gaps, { speed = 1, preRoll = CREDIT_PRE_ROLL, onGapDone = null } = {}) {
      const list = (Array.isArray(gaps) ? gaps : []).filter(gap => gap && gap.e - gap.s >= Y.VideoLedger.MIN_GAP);
      if (!list.length) return { ok: true, played: 0, done: 0, total: 0, stopped: false };
      await this.waitPlayerReady(15000);
      const media = Y.AiWorkspace.getMedia();
      if (!media) return { ok: false, played: 0, done: 0, total: list.length, stopped: false };
      const targetSpeed = Number(speed) > 0 ? Math.min(Number(speed), 2) : 1;
      const rollSeconds = Math.max(0, Number(preRoll) || 0);
      const prevSpeed = Number(media.playbackRate) || 1;
      let done = 0;
      let stopped = false;
      try {
        for (let i = 0; i < list.length; i++) {
          const gap = list[i];
          // 起播点比缺口左端再往前 rollSeconds 秒（交界处已看过的部分），只为了「先有连续播放」。
          // 预滚区间不是要记账的目标：终点仍然只到 gap.e + 0.5，核验也只看缺口自己的开头。
          const from = Math.max(0, (Number(gap.s) || 0) - rollSeconds);
          this.panel.log(`补播第 ${i + 1}/${list.length} 段：${Y.VideoLedger.mark(from)} → ${Y.VideoLedger.mark(gap.e)}`
            + `（缺口 ${Y.VideoLedger.mark(gap.s)} → ${Y.VideoLedger.mark(gap.e)}，${Math.round(gap.e - gap.s)} 秒`
            + `${rollSeconds > 0 ? `；前 ${Math.round(rollSeconds)} 秒是预滚，不算要记账的目标` : ''}）`);
          const ok = await this.playRange(gap, { speed: targetSpeed, preRoll: rollSeconds });
          if (this.blockedByHumanCheck) break;
          if (!ok) {
            this.panel.warn(`第 ${i + 1} 段没播成（播放器不配合或卡住），先跳过这一段`);
            continue;
          }
          done += 1;
          // 单段闭环：播完立刻核一次，判别对象是「单段」而不是整轮，所以要在这里问
          if (typeof onGapDone === 'function') {
            let verdict = null;
            try {
              verdict = await onGapDone(i, gap, ok);
            } catch (err) {
              // 核验本身出错不能把整条补播链打断，按「没有信息」处理
              this.panel.log(`单段核验异常，按未核对处理：${err?.message || err}`);
            }
            if (verdict === 'stop') {
              stopped = true;
              break;
            }
          }
        }
        return { ok: done > 0, played: 0, done, total: list.length, stopped };
      } finally {
        try { media.playbackRate = prevSpeed; } catch (_) { }
        try { media.pause(); } catch (_) { }
      }
    },
    // 把 [gap.s - preRoll, gap.e) 真正播完。返回 false 表示这段没播成（seek 被回滚 / 卡住 / 播到结尾）。
    async playRange(gap, { speed = 1, preRoll = CREDIT_PRE_ROLL } = {}) {
      const rollSeconds = Math.max(0, Number(preRoll) || 0);
      // 预滚默认 0（见 CREDIT_PRE_ROLL）。真要开的时候，5 秒这个取值的理由是：
      // seek 是「拖拽」，取证 §6.4 实测 seek 那一条记录里的 fp/tp 会一直带到后续所有记录上；
      // 如果 seek 落地就正好停在缺口左端开播，前面几秒的采样还带着「刚拖过来」的痕迹，
      // 这一段可能播了却进不了 result。先往前多播 5 秒（≈ 心跳的采样周期，§6.6：5 秒一次）
      // 能让播放器回到正常前进节奏，再进入真正要记账的缺口。
      // 【推断】5 是折中值：再短盖不满一个采样周期；再长（比如按上报批次取 30 秒）每段都要多播
      // 十几秒，24 段就是好几分钟白播，反而比现在更糟。
      const startAt = Math.max(0, (Number(gap.s) || 0) - rollSeconds);
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
            this.panel.warn(`播放器不接受跳到起播点 ${Y.VideoLedger.mark(startAt)}（含预滚，可能是防拖拽），这一段跳过`);
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
