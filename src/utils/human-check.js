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
      return false;
    },
    humanCheckMode() {
      return Y.Store.getFeatureConf().humanCheckMode === 'wait' ? 'wait' : 'skip';
    },
    async gateHumanCheck() {
      if (!this.isHumanCheckVisible()) {
        this._humanCheckLogged = false;
        this._humanCheckSkipLogged = false;
        return 'ok';
      }
      // 「跳过当前章节」：不要在核验弹窗上无限等待，直接把控制权交回调用方，
      // 由 poll 返回 false / humanClick 放弃点击，让当前项被记成跳过并进入下一项。
      if (this.humanCheckMode() === 'skip') {
        if (!this._humanCheckSkipLogged) {
          Y.panel?.log('检测到安全核验，已按设置跳过当前章节');
          this._humanCheckSkipLogged = true;
        }
        return 'skip';
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
    async humanClick(element, min = 800, max = 2000) {
      if (!element) return false;
      if (!await this.waitIfHumanCheck()) return false;
      if (this.isFastMode()) {
        try {
          element.scrollIntoView({ block: 'nearest' });
        } catch (_) {}
        element.click();
        return true;
      }
      if (Math.random() < 0.75) {
        try {
          element.scrollIntoView({ behavior: Math.random() < 0.55 ? 'smooth' : 'auto', block: Math.random() < 0.7 ? 'center' : 'nearest' });
        } catch (_) {}
        await this.humanPause(180, 900);
      }
      await this.humanPause(min, max);
      if (Math.random() < 0.3) await this.humanPause(350, 1600);
      element.click();
      if (Math.random() < 0.35) await this.humanPause(220, 900);
      return true;
    }
  };

  Y.UtilsHumanCheck = UtilsHumanCheck;
})(Y);
