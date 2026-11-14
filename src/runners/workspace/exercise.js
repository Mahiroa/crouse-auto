((Y) => {
  // 练习与讨论处理

  const WorkspaceExerciseMixin = {
    async solveExerciseQuestion(root, label = '') {
      const questionRoot = Y.AiWorkspace.getExerciseQuestionBody(root);
      if (!questionRoot) {
        this.panel.log('未找到题目容器，停止当前轮次');
        return false;
      }
      if (Y.AiWorkspace.isExerciseAnswered(questionRoot)) {
        this.panel.log(`${label || '当前题目'} 已完成，跳过`);
        return true;
      }

      const choices = Y.Solver.questionChoices(questionRoot);
      const optionCount = choices.length;
      const questionType = Y.Solver.detectQuestionType(questionRoot);
      if (!optionCount) {
        this.panel.log(`${label || '当前题目'} 未找到选项，跳过`);
        return false;
      }

      const captured = await Y.Solver.captureQuestion(questionRoot);
      const questionText = captured?.text || '';
      if (!captured?.image && questionText.length <= 5) {
        this.panel.log(`${label || '当前题目'} 题目内容过短，跳过`);
        return false;
      }
      const questionId = `q-${label || '题目'}-${Date.now()}`;
      this.panel.track({
        id: questionId,
        kind: 'question',
        title: label || '题目',
        detail: questionText,
        status: 'doing'
      });

      const maxRetry = 3;
      for (let retryCount = 0; retryCount < maxRetry; retryCount++) {
        try {
          if (retryCount > 0) this.panel.log(`${label || '当前题目'} 重试 ${retryCount}/${maxRetry - 1}`);
          this.panel.log(`当前是${Y.Solver.questionTypeName(questionType)}`);
          const aiText = await Y.Solver.askAI(questionText, optionCount, captured.image, questionType, captured.element);
          const submitted = await Y.Solver.autoSelectAndSubmit(aiText, questionRoot, questionType);
          if (!submitted) throw new Error('未能选中答案或提交');
          await Y.Utils.humanPause(1800, 8000);
          return true;
        } catch (err) {
          this.panel.log(`AI 答题失败：${err}`);
          if (retryCount < maxRetry - 1) await Y.Utils.humanPause(4000, 9000);
        }
      }
      return false;
    },
    async openNextExerciseQuestion(root, previousStem = '') {
      const currentRoot = Y.AiWorkspace.getExerciseContainer() || root;
      const tabs = Y.AiWorkspace.getExerciseQuestionTabs(currentRoot);
      const activeIndex = tabs.findIndex(tab => /active|current|selected|is-active/.test(tab.className));
      const nextTab = activeIndex >= 0 ? tabs[activeIndex + 1] : null;
      const leftQuestion = () => {
        const body = Y.AiWorkspace.getExerciseQuestionBody(Y.AiWorkspace.getExerciseContainer() || currentRoot);
        const stem = Y.Solver.questionStem(body);
        return Boolean(stem && stem !== previousStem);
      };
      if (nextTab) {
        await Y.Utils.humanClick(nextTab, 800, 1600);
        if (await Y.Utils.poll(leftQuestion, { interval: 400, timeout: 4000 })) return true;
      }
      const nextBtn = Y.AiWorkspace.getExerciseActionButton(Y.AiWorkspace.getExerciseContainer() || currentRoot, /下一题|下一道|下一步/);
      if (!nextBtn) return false;
      await Y.Utils.humanClick(nextBtn, 800, 1600);
      return Y.Utils.poll(leftQuestion, { interval: 400, timeout: 5000 });
    },
    async advanceExerciseQuestion(root, previousFingerprint = '') {
      const currentRoot = Y.AiWorkspace.getExerciseContainer() || root;
      const nextBtn = Y.AiWorkspace.getExerciseActionButton(currentRoot, /下一题|下一道|下一步/);
      if (!nextBtn) return false;
      await Y.Utils.humanClick(nextBtn, 1200, 2800);
      return Y.Utils.poll(() => {
        const latestRoot = Y.AiWorkspace.getExerciseContainer() || currentRoot;
        const questionRoot = Y.AiWorkspace.getExerciseQuestionBody(latestRoot);
        const fingerprint = Y.AiWorkspace.normalizeText(questionRoot?.innerText || '').slice(0, 120);
        return fingerprint && fingerprint !== previousFingerprint;
      }, { interval: 500, timeout: 5000 });
    },
    async handleExercise(route) {
      const featureFlags = Y.Store.getFeatureConf();
      if (!featureFlags.autoAI) {
        this.panel.log('已关闭 AI 自动答题，作业将直接跳过');
        return true;
      }

      const ready = await Y.Utils.poll(() => Boolean(Y.AiWorkspace.getExerciseContainer()), { interval: 500, timeout: 20000 });
      Y.preventScreenCheck();
      const root = Y.AiWorkspace.getExerciseContainer();
      if (!ready || !root) {
        this.panel.log('未找到作业容器，停止当前轮次');
        return false;
      }

      this.panel.log(`开始处理作业：${Y.AiWorkspace.getActiveLeafTitle() || route.leafId}`);
      if (Y.Utils.isFastMode()) this.panel.log('快速模式已开启，读题和点击不再等待');
      let previousFingerprint = '';
      for (let i = 0; i < 40; i++) {
        const currentRoot = Y.AiWorkspace.getExerciseContainer() || root;
        const questionRoot = Y.AiWorkspace.getExerciseQuestionBody(currentRoot);
        const fingerprint = Y.Solver.questionStem(questionRoot);
        if (!fingerprint) break;
        const revealed = Y.Solver.revealedResult(questionRoot);
        if (revealed) {
          this.panel.log(`这题已显示结果，得分 ${revealed.score || '0'}，正确答案 ${revealed.answer || '见页面'}，进入下一题`);
          const opened = await this.openNextExerciseQuestion(currentRoot, fingerprint);
          if (!opened) break;
          continue;
        }
        if (Y.AiWorkspace.isExerciseAnswered(questionRoot)) {
          const opened = await this.openNextExerciseQuestion(currentRoot, fingerprint);
          if (!opened) break;
          continue;
        }
        if (i > 0 && fingerprint === previousFingerprint) break;
        if (i > 0 && !Y.Utils.isFastMode()) {
          this.panel.log('换题后稍等再答');
          await Y.Utils.humanPause(2500, 9000);
        }
        await this.solveExerciseQuestion(currentRoot, `第 ${i + 1} 题`);
        previousFingerprint = fingerprint;
        let shown = null;
        let jumped = false;
        await Y.Utils.poll(() => {
          const latestRoot = Y.AiWorkspace.getExerciseQuestionBody(Y.AiWorkspace.getExerciseContainer() || currentRoot);
          const stem = Y.Solver.questionStem(latestRoot);
          if (stem && stem !== fingerprint) {
            jumped = true;
            return true;
          }
          shown = Y.Solver.revealedResult(latestRoot);
          return Boolean(shown);
        }, { interval: 400, timeout: 8000 });
        if (jumped) continue;
        if (shown) {
          await Y.Utils.sleep(1200);
          const latestRoot = Y.AiWorkspace.getExerciseQuestionBody(Y.AiWorkspace.getExerciseContainer() || currentRoot);
          if (Y.Solver.questionStem(latestRoot) !== fingerprint) continue;
          this.panel.log(`这题得分 ${shown.score || '0'}，正确答案 ${shown.answer || '见页面'}，进入下一题`);
        } else {
          this.panel.log('这题没有自动进入下一题，改点下一题');
        }
        const opened = await this.openNextExerciseQuestion(currentRoot, fingerprint);
        if (!opened) break;
      }
      return true;
    },
    async handleForum(route) {
      const title = Y.AiWorkspace.getActiveLeafTitle() || '讨论';
      const stepId = `forum-${route.leafId || title}`;
      // 讨论节的平台口径同样是「点开即完成」（答疑帖这种不需要发言的也算完成），
      // 所以先看平台进度；已经记满就不必再读题/发言。
      const known = await this.leafProgressNow(route.leafId);
      if (known != null && known >= Y.DONE_RATE) {
        this.panel.log(`讨论《${title}》平台已记为完成（${Y.pctText(known)}），跳过`);
        this.panel.track({ id: stepId, kind: 'forum', title, status: 'done', detail: `平台记账 ${Y.pctText(known)}` });
        return true;
      }
      if (!Y.Store.getFeatureConf().autoComment) {
        // 以前这里直接记 skip，用户看到的就是「不支持」。实际上不发言也算完成，
        // 只要打开并等平台记账即可。
        this.panel.log('未开启「批量区图文和讨论自动回复」：讨论节按「打开即完成」处理，不发言');
        return this.handleOpenLeaf(route, 'forum');
      }
      this.panel.log(`开始处理讨论：${title}`);
      this.panel.track({ id: stepId, kind: 'forum', title, status: 'doing', detail: '读取讨论题' });
      await Y.Utils.poll(() => Y.AiWorkspace.forumStatus() || Y.AiWorkspace.forumTopic() || Y.AiWorkspace.findForumComposer(), { interval: 500, timeout: 12000 });
      const status = Y.AiWorkspace.forumStatus();
      if (status === '已发言' || status === '已完成') {
        this.panel.log(`${title} 已经发过言，跳过`);
        this.panel.track({ id: stepId, kind: 'forum', title, status: 'done', detail: status });
        return true;
      }
      let composer = Y.AiWorkspace.findForumComposer();
      if (!composer) {
        const tab = [...document.querySelectorAll('button, [role="tab"], a, span, div')].find(el => {
          const text = (el.innerText || '').trim();
          return /^讨论区/.test(text) && text.length < 16 && Y.AiWorkspace.isVisibleElement(el);
        });
        if (tab) {
          tab.click();
          await Y.Utils.sleep(800);
          composer = Y.AiWorkspace.findForumComposer();
        }
      }
      const topic = Y.AiWorkspace.forumTopic();
      if (!topic) {
        this.panel.log('没有读到讨论题，跳过');
        this.panel.track({ id: stepId, kind: 'forum', title, status: 'skip', detail: '没有读到题目' });
        return true;
      }
      if (!composer) {
        this.panel.log('没有找到发言框，跳过');
        this.panel.track({ id: stepId, kind: 'forum', title, status: 'skip', detail: '没有发言框' });
        return true;
      }
      this.panel.track({ id: stepId, kind: 'forum', title, status: 'doing', detail: topic });
      this.panel.log(`读到的讨论题：${topic}`);
      let reply = '';
      const rawReplies = [];
      try {
        // 最多重试一次，但前导语/推理/残文绝不进入发言框。
        for (let attempt = 1; attempt <= 2; attempt++) {
          const generated = await Y.Solver.requestChat(
            `下面是讨论题原文。回复必须完成题目里的任务，不要换成别的话题。题目点名的方法、概念要在回复里出现，并按题目要求举一个具体例子。用第一人称，120到180个字。不要标题，不要序号，不要引号。${attempt > 1 ? '上次输出包含不可发布的前导语、分析或无效内容。本次第一句就必须是对讨论题的实质性看法，不要解释将如何作答。' : ''}\n讨论题：\n${topic}`,
            '你是在课程讨论区发言的大学生。只根据讨论题原文作答，不回答题目没问的内容。用简体中文直接输出可发布的讨论回复正文，不要描述答题过程，不要写“我要回答”“我将用中文”“下面是我的回复”等前导语，不要复述任务要求，不要输出分析或思考过程。',
            Y.Solver.answerConf(),
            32768
          );
          rawReplies.push(String(generated || ''));
          reply = Y.Solver.cleanForumReply(generated);
          const problem = Y.Solver.forumReplyProblem(reply);
          if (!problem) break;
          this.panel.log(`第 ${attempt} 次讨论回复不可发布：${problem}；返回摘录：${reply.slice(0, 160)}`);
          reply = '';
          if (attempt === 2) {
            this.panel.track({
              id: stepId,
              kind: 'forum',
              title,
              status: 'skip',
              detail: `${problem}，未发送。原始返回：${rawReplies.join('\n--- 重试 ---\n').slice(0, 2000)}`
            });
            return true;
          }
        }
      } catch (err) {
        const message = String(err?.message || err);
        this.panel.log(`讨论回复生成失败：${message}`);
        this.panel.track({
          id: stepId,
          kind: 'forum',
          title,
          status: 'skip',
          detail: `${message}，未发送${rawReplies.length ? `。此前返回：${rawReplies.join('\n--- 重试 ---\n').slice(0, 2000)}` : ''}`
        });
        return true;
      }
      if (!reply) {
        this.panel.log('模型没有写出可发布的回复，未发送');
        this.panel.track({ id: stepId, kind: 'forum', title, status: 'skip', detail: '回复为空，未发送' });
        return true;
      }
      // 不静默截断残句：超出题目要求的长度时保留生成结果，交给用户检查。
      if (reply.length > 180) {
        this.panel.log(`讨论回复为 ${reply.length} 字，超过 180 字，未发送`);
        this.panel.track({ id: stepId, kind: 'forum', title, status: 'skip', detail: `回复超长，未发送。原始返回：${reply.slice(0, 2000)}` });
        return true;
      }
      await Y.Utils.humanPause(900, 1800);
      Y.AiWorkspace.setFieldValue(composer, reply);
      await Y.Utils.humanPause(700, 1400);
      const sendBtn = Y.AiWorkspace.findForumSendButton(composer);
      const sendable = sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true' && !sendBtn.classList.contains('is-disabled');
      if (sendable) {
        await Y.Utils.humanClick(sendBtn, 600, 1400);
      } else {
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }
      const posted = await Y.Utils.poll(() => {
        const next = Y.AiWorkspace.forumStatus();
        return next === '已发言' || next === '已完成';
      }, { interval: 500, timeout: 12000 });
      if (!posted) {
        this.panel.log('已尝试发送，页面仍显示未发言');
        this.panel.track({ id: stepId, kind: 'forum', title, status: 'skip', detail: reply });
        return true;
      }
      this.panel.log(`讨论已发言：${reply.slice(0, 40)}`);
      this.panel.track({ id: stepId, kind: 'forum', title, status: 'done', detail: reply });
      await Y.Utils.humanPause(1200, 2200);
      return true;
    }
  };

  Y.WorkspaceExerciseMixin = WorkspaceExerciseMixin;
})(Y);
