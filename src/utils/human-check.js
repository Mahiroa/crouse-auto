((Y) => {
  // 安全核验检测与闸门

  const UtilsHumanCheck = {
    isHumanCheckVisible() {
      // 只认完整的核验话术。以前的 /人机|验证码/ 会把课程正文里的
      // 「人机交互」「验证码原理」也当成平台核验，wait 模式下整轮停住。
      const strongPattern = /安全核验|按住.{0,8}起|依次经过|人机验证|安全验证|滑动验证|请完成验证|拖动滑块/;
      // 说明：这里原来还有一个 `weakPattern = /验证码/` 的死变量（声明后从未参与判断，
      // 真正的弱匹配靠下面 node.closest(...) 的核验容器判断），已删除，避免误导后续维护者。
      const anyPattern = /安全核验|按住.{0,8}起|依次经过|人机验证|安全验证|滑动验证|请完成验证|拖动滑块|验证码/;
      const docs = [document];
      for (const frame of document.querySelectorAll('iframe')) {
        // 脚本自己的面板里有「人机验证」这个设置标题，不能把它当成平台的核验弹窗
        if (frame.id === 'ykt-helper-iframe') continue;
        try {
          if (frame.contentDocument?.body) docs.push(frame.contentDocument);
        } catch (_) {}
      }
      for (const doc of docs) {
        const pageText = doc.body?.innerText || '';
        if (!anyPattern.test(pageText)) continue;
        const nodes = doc.querySelectorAll('div, section, p, h1, h2, h3, span');
        for (const node of nodes) {
          const text = (node.innerText || '').trim();
          if (text.length < 4 || text.length > 80 || !anyPattern.test(text)) continue;
          // 「验证码」单独出现时只认弹窗/核验容器里的，避免课程正文误报
          const strong = strongPattern.test(text);
          if (!strong && !node.closest('.el-dialog, .el-message-box, [role="dialog"], [class*="verify"], [class*="captcha"]')) continue;
          const view = doc.defaultView || window;
          const style = view.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;
          return true;
        }
      }
      // 补一层画布判定：圆点在 canvas 里、画布又挂在 open shadow root 上，
      // 正文文本扫描不一定扫得到。漏判会让闸门直接放行（auto 不触发、wait 也不等），
      // 比误判严重得多，所以两边任一命中都算核验在。
      try {
        if (Y.RiskChallenge?.isPresent?.() === true) return true;
      } catch (_) {}
      // 求解模块不在（旧构建）时，按同一套结构自查：host + shadow 里的 canvas。
      // 真机实测（3.6.7）：面板一句提示都没有，就是因为核验挂在作业 iframe 的
      // open shadow root 里，innerText 里根本没有「安全核验」这四个字。
      return this.challengeHostVisible();
    },
    challengeHostVisible() {
      let docs = [document];
      try {
        const found = Y.RiskChallenge?.documents?.();
        if (Array.isArray(found) && found.length) docs = found;
      } catch (_) {}
      for (const doc of docs) {
        if (!doc?.querySelector) continue;
        const host = doc.getElementById?.('homework-automation-risk-challenge')
          || doc.querySelector('[data-risk-target="challenge"]');
        if (!host?.shadowRoot) continue;
        const canvas = host.shadowRoot.querySelector('canvas');
        if (!canvas) continue;
        const rect = canvas.getBoundingClientRect();
        if (rect.width >= 80 && rect.height >= 40) return true;
      }
      return false;
    },
    humanCheckMode() {
      // 三态归一化：'wait' 停住等人 / 'auto' 脚本自己解轨迹核验 / 其它一律 'skip'（默认）
      const saved = Y.Store.getFeatureConf().humanCheckMode;
      if (saved === 'wait') return 'wait';
      if (saved === 'auto') return 'auto';
      return 'skip';
    },
    // 求解模块 utils/risk-challenge.js 在 manifest 里排在本文件之后，取不到就是「没加载」，
    // 一律按「可能不存在 / 可能是旧版」使用，缺方法也不能抛。
    riskChallenge() {
      const mod = Y.RiskChallenge;
      if (!mod || typeof mod !== 'object') return null;
      if (typeof mod.create !== 'function') return null;
      return mod;
    },
    // 句柄复用：整个会话只 create 一次；create/installHooks 抛异常就退回 null，由调用方降级。
    riskHandle() {
      const mod = this.riskChallenge();
      if (!mod) return null;
      if (this._riskHandle) return this._riskHandle;
      const handle = mod.create({
        log: (msg) => Y.panel?.log(String(msg)),
        tries: 1,
        // 生产默认不画调试遮罩：它不影响派发，但会在核验区上闪一层红圈，第一次见容易被吓到。
        // 排查「认错了」时把这里改成 true（或直接 Y.RiskChallenge.create({preview:true}).preview()）。
        preview: false
      });
      this._riskHandle = handle;
      try {
        handle?.installHooks?.();
      } catch (_) {}
      return handle;
    },
    // 自动求解只跑一次，异常一律折成 'error'，绝不外泄到刷课主流程
    async tryAutoSolveHumanCheck() {
      try {
        const mod = this.riskChallenge();
        if (!mod) return 'unavailable';
        const handle = this.riskHandle();
        if (!handle || typeof handle.auto !== 'function') return 'unavailable';
        let present;
        try {
          present = typeof mod.isPresent === 'function' ? mod.isPresent() : handle.isVisible?.();
        } catch (_) {}
        if (present === false) return 'not-found';
        const outcome = await handle.auto({ tries: 1 });
        return typeof outcome === 'string' && outcome ? outcome : 'error';
      } catch (err) {
        Y.panel?.log(`自动过核验时出错，已转为人工等待：${err?.message || err}`);
        return 'error';
      }
    },
    humanCheckAutoFailReason(outcome) {
      switch (outcome) {
        case 'failed': return '轨迹校验未通过';
        case 'recognize-failed': return '没能识别出轨迹';
        case 'not-found': return '没找到核验画布';
        case 'unavailable': return '求解模块未就绪';
        case 'error': return '求解模块异常';
        default: return String(outcome || '未知原因');
      }
    },
    // ---- 平台提交确认弹窗 ----
    // 这三句话来自平台自己的 i18n 文案（抓包里的 problemChangeMessage 等）：
    //   「刚刚答完的习题还没有提交，需要提交吗？」→ 先不用了 / 帮我提交
    //   「{n}道已作答习题未提交，需要一起提交吗？」→ 仅提交本题 / 帮我提交
    //   「有填空未填写，确认提交吗?」        → 取消 / 确定
    // 弹窗带全屏遮罩，弹出来之后所有点击都打在遮罩上：真机日志里每题都写
    // 「已确认本题提交（提交按钮已禁用），直接点下一题」——其实一次都没提交成功，
    // 最后整页被弹窗盖住，脚本看起来就是「卡死」。
    submitDialogRules: [
      { match: /还没有提交，需要提交吗/, accept: /^帮我提交$/, cancel: /先不用了/, note: '上一题还没提交' },
      { match: /道已作答习题未提交|需要一起提交吗/, accept: /^帮我提交$/, cancel: /仅提交本题|回到作业/, note: '多题待提交' },
      { match: /有填空未填写/, accept: /^(确定|确认|提交)$/, cancel: /取消/, note: '有空白没填' }
    ],
    // 弹窗可能在顶层文档，也可能在作业 iframe 里；这里把所有同源文档都收进来
    dialogDocs() {
      const docs = [document];
      const push = root => {
        let frames = [];
        try {
          frames = [...root.querySelectorAll('iframe')];
        } catch (_) {
          frames = [];
        }
        for (const frame of frames) {
          if (frame.id === 'ykt-helper-iframe') continue;
          let inner = null;
          try {
            inner = frame.contentDocument;
          } catch (_) {
            continue;
          }
          if (!inner?.body || docs.includes(inner)) continue;
          docs.push(inner);
          if (docs.length < 8) push(inner);
        }
      };
      push(document);
      try {
        const exerciseDoc = Y.AiWorkspace?.getExerciseDocument?.();
        if (exerciseDoc?.body && !docs.includes(exerciseDoc)) docs.push(exerciseDoc);
      } catch (_) {}
      return docs.filter(doc => doc && doc.body);
    },
    dialogButtonText(el) {
      return String(el.innerText ?? el.textContent ?? '').replace(/\s+/g, '');
    },
    // 在弹窗容器里找按钮：外层行容器的文本是「先不用了帮我提交」（两段拼一起），
    // 直接对容器做正则匹配会把整行当成按钮，所以优先取最内层的那个元素。
    findDialogButton(root, pattern) {
      const candidates = [...root.querySelectorAll('button, [role="button"], .el-button, a, span, div')]
        .filter(el => {
          const label = this.dialogButtonText(el);
          if (!label || label.length > 8) return false;
          if (!pattern.test(label)) return false;
          return this.isDialogNodeVisible(el);
        });
      return candidates.find(el => el.childElementCount === 0)
        || candidates.find(el => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button')
        || candidates[0]
        || null;
    },
    isDialogNodeVisible(el) {      try {
        if (Y.AiWorkspace?.isVisibleElement?.(el) === false) return false;
      } catch (_) {}
      let rect = null;
      try {
        rect = el.getBoundingClientRect();
      } catch (_) {}
      // jsdom / 无布局环境下 rect 恒为 0：只按「有尺寸才算可见」会把回归台全判不可见
      if (!rect || (!rect.width && !rect.height)) return true;
      return rect.width > 0 && rect.height > 0;
    },
    // 真机实测（3.6.8）：这个确认弹窗**不是** el-dialog，只是一个白卡片 + 两个按钮，
    // 按 class 找永远找不到，所以改成按文案找：先在文本节点里命中平台原文，
    // 再向上最多 8 层找「同层有『帮我提交』按钮」的容器，全程不依赖任何 class 名。
    pendingSubmitDialog() {
      for (const doc of this.dialogDocs()) {
        const body = doc.body;
        if (!body) continue;
        const walker = doc.createTreeWalker ? doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */) : null;
        if (!walker) continue;
        let textNode = null;
        let rule = null;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const value = String(node.nodeValue || '').trim();
          if (!value || value.length > 120) continue;
          rule = this.submitDialogRules.find(item => item.match.test(value));
          if (!rule) {
            // 文案可能被插值拆成多个文本节点：再看一眼父级的整段文字
            const parent = node.parentElement;
            const merged = parent ? String(parent.textContent || '') : '';
            if (merged.length <= 160 && merged.length > value.length) {
              rule = this.submitDialogRules.find(item => item.match.test(merged));
            }
          }
          if (rule) {
            textNode = node;
            break;
          }
        }
        if (!textNode || !rule) continue;
        let root = textNode.parentElement;
        for (let depth = 0; depth < 8 && root; depth++) {
          const accept = this.findDialogButton(root, rule.accept);
          if (accept) {
            const cancel = this.findDialogButton(root, rule.cancel);
            return { root, accept, cancel, rule, text: String(root.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) };
          }
          root = root.parentElement;
        }
        // 文案出现了但找不到按钮：留一条明确日志，省得下次只能靠猜
        if (rule && !this._submitDialogOrphanLogged) {
          this._submitDialogOrphanLogged = true;
          Y.panel?.log(`检测到平台提示「${rule.note}」，但没找到可点的按钮（可能被遮罩/动画挡住）`);
        }
      }
      return null;
    },
    // 弹窗会在「脚本正等 AI 接口」的时候弹出来：只有 poll / humanClick 的闸门会漏掉那一段，
    // 期间面板看起来就是「什么都没发生」，弹窗一直挂着。这里挂一个低频看门狗专盯它。
    // 只处理提交确认弹窗（幂等、无副作用）；安全核验仍然只走主流程的闸门，避免两处同时拖。
    startWatchdog(interval = 1500) {
      if (this._watchdogTimer) return;
      try {
        this._watchdogTimer = setInterval(() => {
          try {
            this.handleSubmitDialog();
          } catch (_) {}
        }, interval);
      } catch (_) {}
    },
    stopWatchdog() {
      try {
        clearInterval(this._watchdogTimer);
      } catch (_) {}
      this._watchdogTimer = null;
    },
    // 幂等：同一时刻只让一个调用方去点，避免 poll 与 humanClick 各点一次
    async handleSubmitDialog() {
      if (this._submitDialogBusy) return 'busy';
      const found = this.pendingSubmitDialog();
      if (!found) {
        this._submitDialogTries = 0;
        return 'none';
      }
      const tries = (this._submitDialogTries || 0) + 1;
      this._submitDialogTries = tries;
      if (tries > 5) {
        if (tries === 6) Y.panel?.log('平台提交弹窗连续 5 次都点不掉，已停止处理本题，请手动点「帮我提交」');
        return 'stuck';
      }
      this._submitDialogBusy = true;
      const label = String(found.accept.innerText ?? found.accept.textContent ?? '').replace(/\s+/g, '');
      Y.panel?.log(`检测到平台提示「${found.rule.note}」，点「${label}」`);
      try {
        found.accept.click();
      } catch (_) {
        this._submitDialogBusy = false;
        return 'error';
      }
      await this.sleep(600);
      this._submitDialogBusy = false;
      return 'clicked';
    },
    async gateHumanCheck() {
      // 提交确认弹窗先处理：它盖在整页上，不清掉的话后面每次点击都打在遮罩上
      try {
        await this.handleSubmitDialog();
      } catch (_) {}
      if (!this.isHumanCheckVisible()) {
        this._humanCheckLogged = false;
        this._humanCheckSkipLogged = false;
        // 弹窗消失即复位自动求解的去重位：下一个核验弹窗还能再自动试一次
        this._humanCheckAutoTried = false;
        this._humanCheckAutoFailLogged = false;
        this._humanCheckAnnounced = false;
        return 'ok';
      }
      const mode = this.humanCheckMode();
      // 真机反馈过「一句提示都没有」：核验挂在 shadow root 里，没有可读文案时，
      // 至少要让面板说清楚「检测到了、正在自动过」。skip / wait 两条路本来就会各打一行，
      // 这里只补 auto 缺的那句开场白，避免同一个弹窗刷出两条重复提示。
      if (!this._humanCheckAnnounced) {
        this._humanCheckAnnounced = true;
        if (mode === 'auto') Y.panel?.log('检测到安全核验（轨迹 canvas），开始自动过关');
      }
      // 「跳过当前章节」：不要在核验弹窗上无限等待，直接把控制权交回调用方，
      // 由 poll 返回 false / humanClick 放弃点击，让当前项被记成跳过并进入下一项。
      if (mode === 'skip') {
        if (!this._humanCheckSkipLogged) {
          Y.panel?.log('检测到安全核验，已按设置跳过当前章节');
          this._humanCheckSkipLogged = true;
        }
        return 'skip';
      }
      // 「自动过核验」：同一个核验弹窗只自动试一次（_humanCheckAutoTried 去重，
      // 弹窗消失才复位），失败必须回落成 wait 的人工等待，而不是静默跳过当前章节。
      if (mode === 'auto' && !this._humanCheckAutoTried) {
        this._humanCheckAutoTried = true;
        let outcome = await this.tryAutoSolveHumanCheck();
        // 「核验文案已经出现、shadow root 里的 canvas 还差一帧才挂上」是常见的时序窗口。
        // 这时直接转人工，等于把这道题唯一的一次自动机会白扔了（复核时实测过：auto 调 0 次、
        // 去重位却已置位，随后卡在下面的等待循环里再没机会）。所以 not-found 再等两拍重试。
        for (let i = 0; i < 2 && outcome === 'not-found'; i++) {
          await this.sleep(600);
          outcome = await this.tryAutoSolveHumanCheck();
        }
        if (outcome === 'passed') {
          this._humanCheckAutoFailLogged = false;
          this._humanCheckLogged = false;
          Y.panel?.log('已自动通过安全核验，继续当前章节');
          // 平台一般几十毫秒就拆掉弹窗；给 3 秒宽限，避免下一次 gate 把刚过的弹窗当成新核验再拦一次
          for (let i = 0; i < 6 && this.isHumanCheckVisible(); i++) await this.sleep(500);
          if (!this.isHumanCheckVisible()) this._humanCheckAutoTried = false;
          return 'ok';
        }
        if (!this._humanCheckAutoFailLogged) {
          this._humanCheckAutoFailLogged = true;
          // 置位 _humanCheckLogged：已经明确提示「要人手动上」，不再重复打 wait 的开场白，
          // 但字段语义不变（本弹窗已提示过手动处理），wait 收尾仍会复位并打「窗口已关闭」。
          this._humanCheckLogged = true;
          Y.panel?.log(`检测到安全核验，自动求解未通过（${this.humanCheckAutoFailReason(outcome)}），已转为人工等待。请手动拖完后，脚本会继续当前章节`);
        }
      }
      if (!this._humanCheckLogged) {
        Y.panel?.log('检测到安全核验，脚本已停下。请手动拖完后，脚本会继续当前章节');
        this._humanCheckLogged = true;
      }
      while (this.isHumanCheckVisible()) await this.sleep(1000);
      this._humanCheckLogged = false;
      Y.panel?.log('安全核验窗口已关闭，继续当前章节');
      return 'waited';
    },
    async waitIfHumanCheck() {
      return (await this.gateHumanCheck()) !== 'skip';
    },
    // 平台的反作弊 SDK 会统计「每次点击前的指针轨迹点数」和「每次按下期间的移动点数」
    // （规则 id：pointer.trajectory-points.very-low 20 分 / pointer.move-per-down.very-low 25 分，
    //   阈值 20 分且至少命中 2 条规则才弹核验）。
    // 直接 element.click() 这两项全是 0，加上「非可信直接业务点击」10 分正好 30 分 → 必弹核验。
    // 这里补一条人手轨迹：移动 → 按下 → 微移 → 松开 → click，把点位统计喂饱。
    async pointerClick(element) {
      const doc = element.ownerDocument || document;
      const view = doc.defaultView || window;
      let rect = null;
      try {
        rect = element.getBoundingClientRect();
      } catch (_) {}
      // 拿不到布局（display:none / jsdom）时退回原生 click，别把事件派发到 (0,0)
      if (!rect || !rect.width || !rect.height) {
        element.click();
        return true;
      }
      const cx = rect.left + rect.width / 2 + (Math.random() - 0.5) * Math.min(20, rect.width * 0.35);
      const cy = rect.top + rect.height / 2 + (Math.random() - 0.5) * Math.min(10, rect.height * 0.35);
      const startX = cx - 90 - Math.random() * 140;
      const startY = cy - 30 - Math.random() * 70;
      const fire = (type, x, y, buttons = 0) => {
        const init = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
          button: 0,
          buttons,
          detail: type === 'click' ? 1 : 0,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          metaKey: false
        };
        try {
          if (type.startsWith('pointer') && view.PointerEvent) {
            element.dispatchEvent(new view.PointerEvent(type, {
              ...init,
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true,
              pressure: buttons ? 0.5 : 0
            }));
            return;
          }
          const mouseType = type.startsWith('pointer') ? type.replace('pointer', 'mouse') : type;
          element.dispatchEvent(new view.MouseEvent(mouseType, init));
        } catch (_) {}
      };
      // 1) 走近目标：12~16 个轨迹点，带一点弧度，长度超过 SDK 的「轨迹点极少」阈值（3）
      const steps = 12 + Math.floor(Math.random() * 5);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const ease = t * t * (3 - 2 * t);
        const wobble = Math.sin(t * Math.PI) * (Math.random() - 0.5) * 26;
        fire('pointermove', startX + (cx - startX) * ease, startY + (cy - startY) * ease + wobble);
        fire('mousemove', startX + (cx - startX) * ease, startY + (cy - startY) * ease + wobble);
        await this.sleep(Math.round(4 + Math.random() * 12));
      }
      fire('pointerover', cx, cy);
      fire('pointerenter', cx, cy);
      fire('mouseover', cx, cy);
      // 2) 按下 → 微移 4~6 次（movePerDown 要 > 20 才能躲开 pointer.move-per-down 规则）
      fire('pointerdown', cx, cy, 1);
      fire('mousedown', cx, cy, 1);
      const jitterSteps = 4 + Math.floor(Math.random() * 3);
      for (let i = 0; i < jitterSteps; i++) {
        fire('pointermove', cx + (Math.random() - 0.5) * 3, cy + (Math.random() - 0.5) * 3, 1);
        fire('mousemove', cx + (Math.random() - 0.5) * 3, cy + (Math.random() - 0.5) * 3, 1);
        await this.sleep(Math.round(8 + Math.random() * 16));
      }
      // 3) 松开 → 真正的 click（业务逻辑还是靠它，pointer/mouse 系列只是给统计看的）
      fire('pointerup', cx, cy, 0);
      fire('mouseup', cx, cy, 0);
      element.click();
      return true;
    },
    async humanClick(element, min = 800, max = 2000) {
      if (!element) return false;
      if (!await this.waitIfHumanCheck()) return false;
      const fast = this.isFastMode();
      if (fast) {
        try {
          element.scrollIntoView({ block: 'nearest' });
        } catch (_) {}
      } else {
        if (Math.random() < 0.75) {
          try {
            element.scrollIntoView({ behavior: Math.random() < 0.55 ? 'smooth' : 'auto', block: Math.random() < 0.7 ? 'center' : 'nearest' });
          } catch (_) {}
          await this.humanPause(180, 900);
        }
        await this.humanPause(min, max);
        if (Math.random() < 0.3) await this.humanPause(350, 1600);
      }
      await this.pointerClick(element);
      // 平台的反作弊 SDK 会拦下「提交 / 下一题 / 保存」这类业务按钮的点击
      // （preventDefault + stopImmediatePropagation），换成核验弹窗 —— 也就是说
      // 这一次点击等于没点。所以这类按钮点完等一拍：核验出来了就先过关，再审一次。
      const label = String(element.innerText ?? element.textContent ?? '').replace(/\s+/g, '');
      if (/提交|保存|下一题|上一题|确认|确定/.test(label)) {
        await this.sleep(400);
        if (this.isHumanCheckVisible()) {
          const outcome = await this.gateHumanCheck();
          if (outcome === 'skip') return false;
          Y.panel?.log('核验已过，重新点一次刚才被拦下的按钮');
          await this.pointerClick(element);
        }
      }
      if (!fast && Math.random() < 0.35) await this.humanPause(220, 900);
      return true;
    }
  };

  Y.UtilsHumanCheck = UtilsHumanCheck;

  // 求解模块（utils/risk-challenge.js）按 manifest 顺序排在本文件之后，本文件执行时它还不在。
  // 钩子越早装越好，所以下一轮事件循环（所有分片已执行完）就补装一次；installHooks 幂等，重复装无害。
  try {
    setTimeout(() => {
      try {
        Y.RiskChallenge?.installHooks?.();
      } catch (_) {}
    }, 0);
  } catch (_) {}
})(Y);
