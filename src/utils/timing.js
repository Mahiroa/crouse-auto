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
    // 超时按「有效等待时间」累计，三条保证：
    //  1) 标签页短暂隐藏/系统休眠不累计，后台挂机不会被误判超时（原行为）；
    //  2) 连续隐藏超过 hiddenGrace 后，超出部分计入超时，checker 永不满足时也能收敛；
    //  3) wallMax 是墙钟硬上限，定时器被冻结/时钟跳变也不会让 poll 永不返回。
    // 返回值保持 boolean 兼容（true=达成 / false=超时或核验跳过）；需要区分“被安全核验拦下”的
    // 调用方传 onSkip 回调即可，不必改所有 `const done = await poll(...)` 的布尔用法。
    async poll(checker, { interval = 1000, timeout = 20000, hiddenGrace = Math.min(10 * 60 * 1000, Math.max(2 * timeout, 1000)), wallMax = 0, onSkip = null } = {}) {
      const startedAt = Date.now();
      const grace = Math.max(0, Number(hiddenGrace) || 0);
      const hardCap = Number(wallMax) > 0
        ? Number(wallMax)
        : (Number.isFinite(timeout) ? timeout + grace + 120000 : grace + 60 * 60 * 1000);
      let spent = 0;
      let hiddenFrom = 0;
      let hiddenCredited = 0;
      let hiddenNoted = false;
      let throttleNoted = 0;
      let hardCapNoted = false;
      while (spent <= timeout) {
        if (Date.now() - startedAt > hardCap) {
          if (!hardCapNoted) {
            hardCapNoted = true;
            this._pollLog?.(`轮询已达墙钟上限 ${Math.round(hardCap / 1000)} 秒，停止等待`);
          }
          return false;
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
          return false;
        }
        if (checker()) return true;
        const pauseStarted = Date.now();
        await this.sleep(interval);
        const pauseCost = Date.now() - pauseStarted;
        if (this.isTabReallyHidden()) {
          if (!hiddenFrom) hiddenFrom = pauseStarted;
          const hiddenFor = Date.now() - hiddenFrom;
          // 短暂隐藏：完全不计时（原来就是给后台挂机留的余地）
          if (hiddenFor <= grace) continue;
          // 长时间隐藏：只把超过宽限的部分计入，一次长挂机不会瞬间吃掉整个 deadline
          const over = hiddenFor - grace - hiddenCredited;
          if (over > 0) {
            hiddenCredited += over;
            spent += over;
            if (!hiddenNoted) {
              hiddenNoted = true;
              this._pollLog?.(`标签页已隐藏超过 ${Math.round(grace / 1000)} 秒，之后的后台时间开始计入超时`);
            }
          }
          continue;
        }
        hiddenFrom = 0;
        hiddenCredited = 0;
        // 定时器被冻结/系统休眠后的单轮超长等待：按一个 interval 计入，既不把几小时休眠当进度，也不会无限空转
        if (pauseCost > interval * 4) {
          if (throttleNoted < 3) {
            throttleNoted++;
            this._pollLog?.(`轮询单轮等待 ${Math.round(pauseCost / 1000)} 秒（疑似后台节流），按 ${Math.round(interval / 1000)} 秒计入超时`);
          }
          spent += (gate === 'waited' ? 0 : gateCost) + interval;
          continue;
        }
        spent += (gate === 'waited' ? 0 : gateCost) + pauseCost;
      }
      return false;
    }
  };

  Y.UtilsTiming = UtilsTiming;
})(Y);
