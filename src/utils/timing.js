((Y) => {
  // 计时、轮询与后台节流

  const UtilsTiming = {
    // 短暂睡眠，等待网页加载
    sleep: (ms = 1000) => new Promise(resolve => setTimeout(resolve, ms)),
    humanPause(min = 900, max = 2400) {
      if (this.isFastMode()) return this.sleep(0);
      const low = Math.min(min, max);
      const high = Math.max(min, max);
      const ms = low + Math.floor(Math.random() * (high - low + 1));
      return this.sleep(ms);
    },
    randInt(min, max) {
      const low = Math.min(min, max);
      const high = Math.max(min, max);
      return low + Math.floor(Math.random() * (high - low + 1));
    },
    isTabReallyHidden() {
      try {
        const getter = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')?.get;
        if (getter) return Boolean(getter.call(document));
      } catch (_) {}
      return false;
    },
    isFastMode() {
      return Y.Store.getFeatureConf().fastMode === true;
    },
    // poll 需要输出“为什么提前收尾”，但 Utils 不持有 panel；用可选方法调用，切片单测时也不会炸
    _pollLog(message) {
      try {
        Y.panel?.log?.(message);
      } catch (_) {}
    },
    // 每隔一段时间检查某个条件是否满足（通过 checker 函数），如果满足就成功返回；如果超时仍未满足，就失败返回
    // 超时按「有效等待时间」累计，四条保证：
    //  1) 标签页短暂隐藏/系统休眠不累计，后台挂机不会被误判超时（原行为）；
    //  2) 连续隐藏超过 hiddenGrace 后，超出部分计入超时，checker 永不满足时也能收敛；
    //  3) 定时器被冻结（后台节流/系统休眠）造成的单轮超长等待只按一个 interval 计入超时，
    //     多出来的时长记进 stall 再从墙钟里扣掉。为什么冻结时间不能计入墙钟：墙钟会在标签页
    //     被挂起时整段跳过去，而 checker 代表的真实进度不会跟着跳；按墙钟算，一次 9669 秒的冻结
    //     就让本该成功的 checker 直接判 false（真机日志已复现，回归用例见 verify/poll-freeze-tests.js）。
    //     "冻结"的判据不是 4×interval 而是 throttleThreshold（≥5 秒）：4×interval 对 250~400ms 的轮询
    //     只有 1~1.6 秒，慢机器/重负载页面上普通慢轮就会被误判成冻结，再被折价 + 连续计数提前收尾。
    //     5 秒绝对下限才是「定时器被浏览器按住」的形状；不到 5 秒的慢轮老实按真实时间计入 spent。
    //  4) 收敛兜底两道，防止 stall 全额抵扣把等待拖长（这一轮的目的就是别在挂机后空转）：
    //     a) 连续节流保护：连续 throttleStreakMax 轮都超过 throttleThreshold 而 checker 仍不满足，
    //        立刻收尾。后台节流是持续状态而不是偶发冻结，不能一直按 interval 计入后慢慢等；
    //     b) 绝对保险：原始墙钟超过 hardCap + 30 分钟一律收尾。为什么扣了 stall 还要留它——
    //        stall 记账依赖「冻结看起来像一次超长 sleep」，万一遇到不按这个形状出现的冻结、
    //        或以后有人改坏了记账，原始墙钟仍能把 poll 从永久挂死里拽出来。
    // 返回值保持 boolean 兼容（true=达成 / false=超时或核验跳过）；需要区分“被安全核验拦下”的
    // 调用方传 onSkip 回调即可，不必改所有 `const done = await poll(...)` 的布尔用法。
    // 返回前会把本次有效耗时写进 this.lastPollSpent（毫秒 = 墙钟 − stall，成功与失败都写），
    // 供调用方显示真实等待。注意槽位：生产调用是 Y.Utils.poll(...)，this 就是浅拷贝出来的 Y.Utils，
    // 所以调用方要读 Y.Utils.lastPollSpent；Y.UtilsTiming.lastPollSpent 永远是 undefined。
    // 它只是附加属性，读不到时调用方自己有兜底。
    async poll(checker, { interval = 1000, timeout = 20000, hiddenGrace = Math.min(10 * 60 * 1000, Math.max(2 * timeout, 1000)), wallMax = 0, onSkip = null } = {}) {
      const startedAt = Date.now();
      const grace = Math.max(0, Number(hiddenGrace) || 0);
      const hardCap = Number(wallMax) > 0
        ? Number(wallMax)
        : (Number.isFinite(timeout) ? timeout + grace + 120000 : grace + 60 * 60 * 1000);
      // 被冻结/后台隐藏吃掉、明确不计入考核的时间（毫秒）。硬上限判定和 lastPollSpent 都要减掉它
      let stall = 0;
      // 绝对保险的附加余量：见上面第 4b 条，stall 记账失灵时靠原始墙钟兜底。
      // 30 分钟而不是 2 小时：stall 全额抵扣后，这里是「持续被节流」场景最坏的忍耐上限，
      // 再长就等于没收敛（waitPlayerReady 这种 6 秒的轮询能拖到小时级）
      const absoluteSlack = 30 * 60 * 1000;
      // 「这一轮是不是被浏览器按住了」的判据：4×interval 只是相对参考，真正的下限是 5 秒。
      // 250ms 的轮询 4× 只有 1 秒、400ms 的只有 1.6 秒，页面上一次普通重排/GC 就能越过，
      // 于是慢轮被当成冻结：stall 折价 + 连续计数 12 轮 → 明明在正常推进却被判 false。
      // 因此取 max(4×interval, 5000)：低于 5 秒的慢轮走正常路径，老实按真实耗时计入。
      const throttleThreshold = Math.max(interval * 4, 5000);
      // 连续节流保护的阈值：见上面第 4a 条。偶发一次冻结（切后台、系统休眠）照旧豁免，
      // 连续 12 轮都超过 throttleThreshold 说明标签页一直在后台被压，checker 再怎么等也不会变，直接收尾
      const throttleStreakMax = 12;
      // 所有 return 都走这里：统一记录 lastPollSpent（毫秒 = 墙钟 − stall，尽量不含冻结/后台时间）。
      // 写在 this 上，所以从 Y.Utils 调进来就是 Y.Utils.lastPollSpent（读 Y.UtilsTiming 那个槽位永远是
      // undefined，utils/index.js 里是对象浅拷贝）；读不到时调用方有兜底，这里不抛错、不打印。
      const finish = (result) => {
        this.lastPollSpent = Math.max(0, Date.now() - startedAt - stall);
        return result;
      };
      let spent = 0;
      let hiddenFrom = 0;
      let hiddenCredited = 0;
      let hiddenNoted = false;
      let throttleNoted = 0;
      let throttleStreak = 0;
      let hardCapNoted = false;
      while (spent <= timeout) {
        // 硬上限按「扣掉冻结后的墙钟」判，否则一次后台冻结就把已经满足的 checker 判死
        if (Date.now() - startedAt - stall > hardCap) {
          if (!hardCapNoted) {
            hardCapNoted = true;
            this._pollLog?.(`轮询已达墙钟上限 ${Math.round(hardCap / 1000)} 秒${stall > 0 ? `（已扣除冻结/后台 ${Math.round(stall / 1000)} 秒）` : ''}，停止等待`);
          }
          return finish(false);
        }
        const gateStarted = Date.now();
        const gate = await this.gateHumanCheck();
        const gateCost = Date.now() - gateStarted;
        if (gate === 'skip') {
          // 被安全核验拦下：先通知调用方（停住/记 skip/别清持久化进度），再按原有 boolean 语义返回 false。
          // 回调异常不能影响 poll 的返回，避免一个日志/面板问题把整条刷课链打断。
          if (typeof onSkip === 'function') {
            try {
              onSkip();
            } catch (err) {
              this._pollLog?.(`onSkip 回调异常：${err?.message || err}`);
            }
          }
          return finish(false);
        }
        if (checker()) return finish(true);
        // 绝对保险放在 checker 之后：它只否决「还要继续等」，不否决「本轮已经满足」。
        // 挂机几小时回来时 checker 往往已经成立，如果无条件按原始墙钟在循环顶部收尾，
        // 就变成「人回来了、条件也满足了，却被判 false」。stall 记账正常时这一条永不触发。
        if (Date.now() - startedAt > hardCap + absoluteSlack) {
          this._pollLog?.(`轮询原始墙钟已超过 ${Math.round((hardCap + absoluteSlack) / 1000)} 秒，强制收尾以免挂死`);
          return finish(false);
        }
        const pauseStarted = Date.now();
        await this.sleep(interval);
        const pauseCost = Date.now() - pauseStarted;
        if (this.isTabReallyHidden()) {
          // 隐藏分支有自己的记账（超过宽限才开始计入 spent），不算「节流轮」，把连续节流计数清掉
          throttleStreak = 0;
          if (!hiddenFrom) hiddenFrom = pauseStarted;
          const hiddenFor = Date.now() - hiddenFrom;
          // 短暂隐藏：完全不计时（原来就是给后台挂机留的余地）
          if (hiddenFor <= grace) continue;
          // 长时间隐藏：只把超过宽限的部分计入，一次长挂机不会瞬间吃掉整个 deadline
          const over = hiddenFor - grace - hiddenCredited;
          if (over > 0) {
            hiddenCredited += over;
            spent += over;
            // 这段后台时间已经算进 spent，硬上限判定就不能再按墙钟算第二遍
            stall += over;
            if (!hiddenNoted) {
              hiddenNoted = true;
              this._pollLog?.(`标签页已隐藏超过 ${Math.round(grace / 1000)} 秒，之后的后台时间开始计入超时`);
            }
          }
          continue;
        }
        hiddenFrom = 0;
        hiddenCredited = 0;
        // 定时器被冻结/系统休眠后的单轮超长等待：按一个 interval 计入，既不把几小时休眠当进度，也不会无限空转。
        // 只有超过 throttleThreshold（≥5 秒）才算冻结，慢机器上的普通慢轮不算
        if (pauseCost > throttleThreshold) {
          if (throttleNoted < 3) {
            throttleNoted++;
            // 400ms 用 Math.round 会打成「按 0 秒计入超时」，排查时看不出到底按多少秒算，改成保留 1 位小数
            this._pollLog?.(`轮询单轮等待 ${Math.round(pauseCost / 1000)} 秒（疑似后台节流），按 ${(interval / 1000).toFixed(1)} 秒计入超时`);
          }
          // 多出来的等待是定时器被冻结，不是用户真在等：只按一个 interval 计入超时，
          // 其余记进 stall 从墙钟里扣掉（见上面第 3 条）。先记账再判连续节流，
          // 这样收尾那一轮的冻结时长同样不计入 lastPollSpent
          stall += pauseCost - interval;
          spent += (gate === 'waited' ? 0 : gateCost) + interval;
          // 连续节流保护（见上面第 4a 条）：偶发一次冻结照旧豁免，但连续很多轮都这么长说明标签页
          // 一直在后台被压，checker 等再久也不会变；不提前收尾就会一路按 interval 记到墙钟保险为止
          throttleStreak += 1;
          if (throttleStreak >= throttleStreakMax) {
            this._pollLog?.(`标签页连续 ${throttleStreakMax} 轮处于后台节流，已停止等待`);
            return finish(false);
          }
          continue;
        }
        // 正常轮（单轮等待 ≤ throttleThreshold，比如慢机器上 2 秒的一轮）：连续节流计数清零，
        // 并且按真实耗时计入 spent —— 停了 2 秒就记 2 秒，不折价成 interval，也就不会被误判成冻结
        throttleStreak = 0;
        spent += (gate === 'waited' ? 0 : gateCost) + pauseCost;
      }
      return finish(false);
    }
  };

  Y.UtilsTiming = UtilsTiming;
})(Y);
