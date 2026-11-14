((Y) => {
  // v2 视频、音频与批量区处理

  const V2RunnerMediaMixin = {
    async handleVideo(course) {
      const entryTitle = course.querySelector('h2')?.innerText?.trim() || `第 ${this.outside + 1} 项`;
      // 点课程属于导航动作：被安全核验拦下时返回值是 false，此时仍停在目录页。
      // 以前丢弃返回值会继续 poll 进度、再 history.back()，等于在目录页“多退一页”，整轮找不到课程列表。
      const entered = await Y.Utils.humanClick(course, 1000, 2200);
      if (!entered) {
        this.panel.warn(`进入「${entryTitle}」被安全核验拦截，已停下（未记完成、未推进进度）`);
        this.panel.track({ id: `v2-${this.outside}`, kind: 'video', title: entryTitle, status: 'skip', detail: '安全核验，未进入' });
        this.panel.resetStartButton('待核验，已停止');
        this.shouldStop = true;
        return;
      }
      if (await this.waitForExternalHandoff(1500)) return;
      await Y.Utils.sleep(3000);
      const title = document.querySelector('.title')?.innerText || entryTitle;
      this.panel.track({ id: `v2-${this.outside}`, kind: 'video', title, status: 'doing' });
      const isDeadline = document.querySelector('.box')?.innerText.includes('已过考核截止时间');
      if (isDeadline) this.panel.log(`${title} 已过截止，进度不再增加，将直接跳过`);
      Y.Player.applySpeed();
      Y.Player.mute();
      const video = document.querySelector('video');
      const stopObserve = Y.Player.observePause(video);
      // poll 的 boolean 仍表示“是否达成”；onSkip 单独记录“被安全核验拦下”，
      // 这样不会把核验跳过误记成 done，也不会 updateProgress 把这一节当成已刷。
      let verificationSkipped = false;
      const done = await Y.Utils.poll(() => {
        Y.Utils.dismissPopups();
        return isDeadline || Y.Utils.isMarkedDone(this.readProgressText());
      }, { interval: 5000, timeout: await Y.Utils.getDDL(), onSkip: () => { verificationSkipped = true; } });
      stopObserve();
      if (verificationSkipped) {
        this.panel.warn(`${title} 检测到安全核验，已停在本节（未记完成、未推进进度）`);
        this.panel.track({ id: `v2-${this.outside}`, kind: 'video', title, status: 'skip', detail: '安全核验，已停住' });
        this.panel.resetStartButton('待核验，已停止');
        this.shouldStop = true;
        return;
      }
      if (!done) this.panel.log(`${title} 等待后仍未显示已完成，进入下一项`);
      this.panel.track({ id: `v2-${this.outside}`, kind: 'video', title, status: 'done', detail: done ? '播放结束' : '未显示已完成，已继续' });
      this.updateProgress(this.outside + 1, 0);
      history.back();
      await Y.Utils.sleep(1200);
    },
    // 目录列表每轮现查：history.back() 之后 Vue 会重建 .logs-list 下的子节点
    readCourseList() {
      const listEl = document.querySelector('.logs-list');
      return listEl ? [...listEl.children].filter(node => node.nodeType === 1) : [];
    },
    // 批量区所在的课程节点（每轮现查，不能缓存：一次 history.back() 就可能整块换掉）
    getBatchCourse() {
      return this.readCourseList()[this.outside] || null;
    },
    getBatchExpandButton(course = this.getBatchCourse()) {
      return course?.querySelector('.sub-info')?.querySelector('.gray')?.querySelector('span') || null;
    },
    // 展开批量区。文案是「收起」说明已经展开；同一个节点最多点 2 次，
    // 避免「展开/收起」是同一个开关时被反复点回收起状态
    expandBatch(course = this.getBatchCourse()) {
      const button = this.getBatchExpandButton(course);
      if (!button) return false;
      const label = (button.innerText || button.textContent || '').trim();
      if (label.includes('收起')) return true;
      const clicks = Number(button.dataset?.yktExpandClicks || 0);
      if (clicks >= 2) return true;
      if (button.dataset) button.dataset.yktExpandClicks = String(clicks + 1);
      button.click();
      return true;
    },
    // 当前这一组批量项：每次调用都重新查询，返回的才是活节点
    getBatchItems() {
      const wrap = this.getBatchCourse()?.querySelector('.leaf_list__wrap');
      return wrap ? [...wrap.querySelectorAll('.activity__wrap')] : [];
    },
    // 读批量项列表：空列表时有限次重查（必要时补一次 history.back），每轮都有日志，绝不无限重试
    async readBatchItems(maxRounds = 4, { allowBack = false } = {}) {
      let backUsed = 0;
      for (let round = 1; round <= maxRounds; round++) {
        const items = this.getBatchItems();
        if (items.length) return items;
        const hasCatalogDom = Boolean(document.querySelector('.logs-list'));
        if (!hasCatalogDom) {
          const onCatalogPage = location.pathname.includes('/studentLog/');
          if (allowBack && !onCatalogPage && backUsed < 1) {
            backUsed++;
            this.panel.log(`批量区当前不在目录页，返回上一层后重查（${round}/${maxRounds}）`);
            history.back();
          } else {
            this.panel.log(`批量区目录尚未渲染，稍后重查（${round}/${maxRounds}）`);
          }
        } else if (this.expandBatch()) {
          this.panel.log(`批量区列表为空，重新展开后重查（${round}/${maxRounds}）`);
        } else {
          this.panel.log(`批量区没有展开按钮，稍后重查（${round}/${maxRounds}）`);
        }
        await Y.Utils.sleep(1200);
      }
      return [];
    },
    async handleBatch(course, list) {
      if (!this.expandBatch(course)) {
        this.panel.log('未找到批量展开按钮，跳过');
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      await Y.Utils.sleep(1200);
      // 子项处理完 history.back() 后 Vue 可能整块重渲染：这里拿到的只是“这一次”的活节点，
      // 每轮都必须重新查（3.3.0 把 NodeList 缓存到循环外，换页后点到的是脱链节点）
      let items = await this.readBatchItems(4);
      if (!items.length) {
        this.panel.warn('批量区展开后仍读不到子项，已停止（进度保留，重新开始会从当前项续跑）');
        this.panel.track({ id: `v2-${this.outside}`, kind: 'course', title: course?.querySelector('h2')?.innerText?.trim() || '批量内容', status: 'skip', detail: '批量项读取失败' });
        this.shouldStop = true;
        this.panel.resetStartButton('批量区异常，已停止');
        return;
      }
      let idx = this.inside;
      this.panel.log(`进入批量区，内部进度 ${idx}/${items.length}`);
      // 每项最多重查 3 次，再加固定余量：任何异常都不会变成无限循环
      const maxRounds = items.length * 3 + 10;
      let rounds = 0;
      while (idx < items.length) {
        if (++rounds > maxRounds) {
          this.panel.warn(`批量区重查 ${maxRounds} 轮仍未推进，已停止（进度停在第 ${idx + 1} 项，重新开始会续跑）`);
          this.panel.track({ id: `v2-${this.outside}`, kind: 'course', title: course?.querySelector('h2')?.innerText?.trim() || '批量内容', status: 'skip', detail: `停在第 ${idx + 1} 项` });
          this.shouldStop = true;
          this.panel.resetStartButton('批量区异常，已停止');
          return;
        }
        const item = items[idx];
        if (!item || !item.isConnected) {
          this.panel.log(`批量第 ${idx + 1} 项节点已脱链，重查后继续（第 ${rounds}/${maxRounds} 轮）`);
          items = await this.readBatchItems(3, { allowBack: true });
          if (!items.length) {
            this.panel.warn('批量区节点替换后仍读不到子项，已停止（进度保留，重新开始会从当前项续跑）');
            this.panel.track({ id: `v2-${this.outside}`, kind: 'course', title: course?.querySelector('h2')?.innerText?.trim() || '批量内容', status: 'skip', detail: '批量项读取失败' });
            this.shouldStop = true;
            this.panel.resetStartButton('批量区异常，已停止');
            return;
          }
          continue;
        }

        const tagText = item.querySelector('.tag')?.innerText || '';
        const tagHref = item.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || '';
        const title = item.querySelector('h2')?.innerText || `第${idx + 1}项`;

        // 检查当前项目的完成状态
        const statusBox = item.querySelector('.statistics-box .aside');
        const statusText = statusBox?.innerText || '';
        const isCompleted = this.checkCompletionStatus(statusBox, statusText);

        if (isCompleted) {
          this.panel.log(`✅ ${title} 已完成，跳过`);
          this.panel.track({ id: `v2-${this.outside}-${idx}`, kind: tagText === '音频' ? 'audio' : 'video', title, status: 'done', detail: '已完成' });
          idx++;
          this.updateProgress(this.outside, idx);
          items = await this.readBatchItems(3, { allowBack: true });
          continue;
        }

        const before = idx;
        if (tagText === '音频') {
          idx = await this.playAudioItem(item, title, idx);
        } else if (tagHref.includes('shipin')) {
          idx = await this.playVideoItem(item, title, idx);
        } else if (tagHref.includes('tuwen') || tagHref.includes('taolun')) {
          idx = await this.autoCommentItem(item, tagHref.includes('tuwen') ? '图文' : '讨论', idx);
        } else if (tagHref.includes('zuoye')) {
          idx = await this.handleHomework(item, idx);
        } else {
          this.panel.log(`类型未知，已跳过：${title}`);
          idx++;
          this.updateProgress(this.outside, idx);
        }
        if (this.shouldStop) return;
        if (idx <= before) {
          // 子流程没有推进（页面交接/失败）：这里必须自己前进，否则 while 会在同一项上原地打转
          this.panel.log(`批量第 ${before + 1} 项没有推进内部进度，跳过它继续`);
          this.panel.track({ id: `v2-${this.outside}-${before}`, kind: tagText === '音频' ? 'audio' : 'video', title, status: 'skip', detail: '未推进，已跳过' });
          idx = before + 1;
          this.updateProgress(this.outside, idx);
        }
        // 子流程里已经 history.back()，列表多半重渲染过：下一轮必须用新节点
        items = await this.readBatchItems(3, { allowBack: true });
      }
      this.updateProgress(this.outside + 1, 0);
      const batchTitle = course.querySelector('h2')?.innerText?.trim() || '批量内容';
      this.panel.track({ id: `v2-${this.outside}`, kind: 'course', title: batchTitle, status: 'done', detail: '这一组已处理' });
      await Y.Utils.sleep(1000);
    },
    async playAudioItem(item, title, idx) {
      this.panel.log(`开始播放音频：${title}`);
      this.panel.track({ id: `v2-${this.outside}-${idx}`, kind: 'audio', title, status: 'doing' });
      item.click();
      if (await this.waitForExternalHandoff()) return idx;
      await Y.Utils.sleep(2500);
      Y.Player.applyMediaDefault(document.querySelector('audio'));
      const done = await Y.Utils.poll(() => {
        Y.Utils.dismissPopups();
        return Y.Utils.isMarkedDone(this.readProgressText());
      }, { interval: 3000, timeout: await Y.Utils.getDDL() });
      if (!done) this.panel.log(`${title} 等待后仍未显示已完成，进入下一项`);
      this.panel.log(`${title} 播放完成`);
      this.panel.track({ id: `v2-${this.outside}-${idx}`, kind: 'audio', title, status: 'done', detail: done ? '播放结束' : '未显示已完成，已继续' });
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Y.Utils.sleep(1500);
      return idx;
    },
    async playVideoItem(item, title, idx) {
      this.panel.log(`开始播放视频：${title}`);
      this.panel.track({ id: `v2-${this.outside}-${idx}`, kind: 'video', title, status: 'doing' });
      item.click();
      if (await this.waitForExternalHandoff()) return idx;
      await Y.Utils.sleep(2500);
      Y.Player.applySpeed();
      Y.Player.mute();
      const video = document.querySelector('video');
      const stopObserve = Y.Player.observePause(video);
      const done = await Y.Utils.poll(() => {
        Y.Utils.dismissPopups();
        return Y.Utils.isMarkedDone(this.readProgressText());
      }, { interval: 3000, timeout: await Y.Utils.getDDL() });
      stopObserve();
      if (!done) this.panel.log(`${title} 等待后仍未显示已完成，进入下一项`);
      this.panel.log(`${title} 播放完成`);
      this.panel.track({ id: `v2-${this.outside}-${idx}`, kind: 'video', title, status: 'done', detail: done ? '播放结束' : '未显示已完成，已继续' });
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Y.Utils.sleep(1500);
      return idx;
    },
    async autoCommentItem(item, typeText, idx) {
      this.panel.log(`开始处理${typeText}：${item.querySelector('h2')?.innerText || ''}`);
      item.click();
      await Y.Utils.sleep(1200);

      // 检查是否开启自动评论功能
      const featureFlags = Y.Store.getFeatureConf();
      if (!featureFlags.autoComment) {
        this.panel.log(`${typeText}已查看，但未开启自动回复功能`);
        idx++;
        this.updateProgress(this.outside, idx);
        history.back();
        await Y.Utils.sleep(1000);
        return idx;
      }

      // 开启了自动评论功能，执行评论逻辑
      window.scrollTo(0, document.body.scrollHeight);
      await Y.Utils.sleep(800);
      window.scrollTo(0, 0);
      const commentSelectors = ['#new_discuss .new_discuss_list .cont_detail', '.new_discuss_list dd .cont_detail', '.cont_detail.word-break'];
      let firstComment = '';
      for (let retry = 0; retry < 30 && !firstComment; retry++) {
        for (const sel of commentSelectors) {
          const list = document.querySelectorAll(sel);
          for (const node of list) {
            if (node?.innerText?.trim()) {
              firstComment = node.innerText.trim();
              break;
            }
          }
          if (firstComment) break;
        }
        if (!firstComment) await Y.Utils.sleep(500);
      }
      if (!firstComment) {
        this.panel.log('未找到评论内容，跳过该项');
      } else {
        const input = document.querySelector('.el-textarea__inner');
        if (input) {
          Y.AiWorkspace.setFieldValue(input, firstComment);
          await Y.Utils.sleep(800);
          const sendBtn = document.querySelector('.el-button.submitComment') ||
            document.querySelector('.publish_discuss .postBtn button') ||
            document.querySelector('.el-button--primary');
          if (sendBtn && !sendBtn.disabled && !sendBtn.classList.contains('is-disabled')) {
            sendBtn.click();
            this.panel.log(`已在${typeText}区发表评论`);
          } else {
            this.panel.log('发送按钮不可用或不存在');
          }
        } else {
          this.panel.log('未找到评论输入框，跳过');
        }
      }
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Y.Utils.sleep(1000);
      return idx;
    }
  };

  Y.V2RunnerMediaMixin = V2RunnerMediaMixin;
})(Y);
