((Y) => {
  // 练习与讨论处理

  const WorkspaceExerciseMixin = {
    // 幂等集合挂在 mixin 实例上，只活在本实例的内存里：同一指纹成功提交过一次，之后
    // 再遇到同一指纹就不再提交（同一题干两次不同答案会互相覆盖）。刷新页面 / 重开一轮后
    // answeredFingerprints 就是空的 —— 这是预期行为，跨运行复用靠 Y.Store 的答案缓存。
    exerciseAnsweredKeys() {
      if (!(this.answeredFingerprints instanceof Set)) this.answeredFingerprints = new Set();
      return this.answeredFingerprints;
    },
    // 提交确认信号：只认结果类文本和「提交按钮 disabled」这两种保守判据。
    // 刻意不用「提交按钮消失」——平台切题/重渲染时按钮会短暂消失，那种判据会把没交上的题
    // 当成已提交直接跳过。本方法只在点过提交之后才被轮询，所以不会把未作答的题当已提交。
    exerciseSubmitConfirmed(root) {
      const container = Y.AiWorkspace.getExerciseContainer() || root;
      if (!container) return '';
      // 提交确认弹窗还开着时，提交按钮的禁用态是「等你确认」而不是「已交卷」：
      // 这时把禁用当确认信号，会让每一题都被记成已提交，实际全没交（v3.6.6 真机就是这样）。
      if (Y.Utils.pendingSubmitDialog?.()) return '';
      const questionRoot = Y.AiWorkspace.getExerciseQuestionBody(container) || container;
      if (Y.Solver.revealedResult(questionRoot)) return '本题得分/正确答案已出现';
      if (Y.AiWorkspace.isExerciseAnswered(questionRoot)) return '已作答/已完成';
      // isExerciseAnswered 只看 .result / .status 这类节点，纯文本状态（有的题型只写一行「已作答」）
      // 会漏掉，这里按题干容器补一次正文扫描。
      const statusText = Y.AiWorkspace.normalizeText(questionRoot?.innerText || '').match(/已作答|已完成/);
      if (statusText) return `页面出现「${statusText[0]}」`;
      const submitBtn = Y.AiWorkspace.getExerciseActionButton(container, /提交|保存|确认|确定/);
      if (!submitBtn) return '';
      const disabled = submitBtn.disabled === true
        || submitBtn.getAttribute('aria-disabled') === 'true'
        || submitBtn.classList.contains('is-disabled');
      return disabled ? '提交按钮已禁用' : '';
    },
    // 「第 1 题 未找到选项」在真机日志里每份作业都出现，而且只出现在第一题：比「这题是填空题」
    // 更像「选项还没渲染完就被读到了」。所以判无选项之前给一个很短（1.2 秒）的宽限，
    // 真的没有选项才按填空/简答翻页；宽限命中就正常答题，不会把刚打开的选择题跳过。
    async waitExerciseChoices(questionRoot) {
      if (Y.Solver.questionChoices(questionRoot).length) return true;
      // 填空题本来就没有选项：有填空框就不用再等选项渲染
      if (Y.Solver.fillInputs(questionRoot).length) return true;
      return Y.Utils.poll(() => Y.Solver.questionChoices(questionRoot).length > 0, { interval: 250, timeout: 1200 });
    },
    async solveExerciseQuestion(root, label = '', fingerprint = '') {
      const questionRoot = Y.AiWorkspace.getExerciseQuestionBody(root);
      if (!questionRoot) {
        this.panel.log('未找到题目容器，停止当前轮次');
        return false;
      }
      if (Y.AiWorkspace.isExerciseAnswered(questionRoot)) {
        this.panel.log(`${label || '当前题目'} 已完成，跳过`);
        return true;
      }

      // 选项还没渲染出来时先宽限等一下，再决定是不是真的没有选项。
      if (!Y.Solver.questionChoices(questionRoot).length) await this.waitExerciseChoices(questionRoot);
      const choices = Y.Solver.questionChoices(questionRoot);
      // 填空题没有选项，但「空的数量」要传给模型（决定它输出几个答案）
      const blanks = Y.Solver.fillInputs(questionRoot);
      const optionCount = choices.length || blanks.length;
      const questionType = Y.Solver.detectQuestionType(questionRoot);
      // 既没有选项、也没有填空输入框：这才是「没有可作答的东西」（简答/主观题），直接翻页。
      // 以前只要没有选项就翻页，结果填空题（input.blank-item-dynamic）被整页跳过。
      if (!optionCount) {
        this.panel.log(`${label || '当前题目'} 没有选项也没有填空框（简答/其他题型），直接翻到下一题`);
        await this.advanceExerciseQuestion(questionRoot, fingerprint);
        return true;
      }

      // 缓存 key = 题干 + 选项文本的指纹：选项顺序一变 key 就变，不会误命中。
      const questionKey = Y.Solver.questionFingerprint(questionRoot);
      const answeredKeys = this.exerciseAnsweredKeys();
      if (questionKey && answeredKeys.has(questionKey)) {
        this.panel.log(`${label || '当前题目'} 本题已提交过，直接翻到下一题`);
        await this.advanceExerciseQuestion(questionRoot, fingerprint);
        return true;
      }

      // 命中缓存就直接提交，不再截图/OCR/请求模型；提交失败（返回 false）才回退 AI 流程。
      const cached = questionKey ? Y.Store.getAnswerCache(questionKey) : null;
      if (cached?.answer) {
        this.panel.log(`${label || '当前题目'} 命中本地答案缓存：${cached.answer}，不再请求 AI`);
        const cacheSubmitted = await Y.Solver.autoSelectAndSubmit(`答案：${cached.answer}`, questionRoot, questionType);
        if (cacheSubmitted) {
          answeredKeys.add(questionKey);
          await Y.Utils.humanPause(1200, 4000);
          return true;
        }
        this.panel.log('缓存答案提交失败，改走正常 AI 答题流程');
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
          // 重试之间平台可能已经重渲染题目节点：每次都重新解析，别拿旧引用去查选项。
          // 真机日志里同一题连续 3 次「⚠️ 未找到选项容器」就是旧节点被换掉导致的。
          const liveRoot = Y.Solver.liveQuestionRoot(questionRoot);
          const liveType = Y.Solver.detectQuestionType(liveRoot) || questionType;
          const liveCount = Y.Solver.questionChoices(liveRoot).length
            || Y.Solver.fillInputs(liveRoot).length
            || optionCount;
          if (retryCount > 0) this.panel.log(`${label || '当前题目'} 重试 ${retryCount}/${maxRetry - 1}`);
          this.panel.log(`当前是${Y.Solver.questionTypeName(liveType)}`);
          const aiText = await Y.Solver.askAI(questionText, liveCount, captured.image, liveType, captured.element || liveRoot);
          const submitted = await Y.Solver.autoSelectAndSubmit(aiText, liveRoot, liveType);
          if (!submitted) throw new Error('未能选中答案或提交');
          // 只有真正提交成功才写缓存：提交失败时答案可能是错的/没点上，缓存下来会污染后续运行。
          // 选择题存字母 token，填空题存按空拼起来的答案（多个空用 | 分隔）。
          if (questionKey) {
            if (liveType === 'fill') {
              const fillAnswers = Y.Solver.extractFillAnswer(aiText, liveCount);
              if (fillAnswers.length) {
                Y.Store.setAnswerCache(questionKey, { answer: fillAnswers.join('|'), type: 'fill', at: Date.now() });
              }
            } else {
              const answerToken = Y.Solver.extractAnswerToken(aiText);
              if (answerToken) {
                Y.Store.setAnswerCache(questionKey, { answer: answerToken, type: liveType, at: Date.now() });
              }
            }
          }
          answeredKeys.add(questionKey);
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
      // 比较口径必须和调用方一致（都用 questionStem）。以前这里用 normalizeText(innerText).slice(0,120)，
      // 和调用方传进来的去空白题干永远不相等，poll 第一次就返回 true，等于根本没检测翻页。
      return Y.Utils.poll(() => {
        const latestRoot = Y.AiWorkspace.getExerciseContainer() || currentRoot;
        const questionRoot = Y.AiWorkspace.getExerciseQuestionBody(latestRoot);
        const fingerprint = Y.Solver.questionStem(questionRoot);
        return Boolean(fingerprint) && fingerprint !== previousFingerprint;
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
      // 作业里没答成的题记在这里：以前失败只打一行「AI 答题失败」，整份作业结束时
      // 看不出还剩几题没交，用户只能翻平台。收尾统一报一次。
      const unsolved = [];
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
        // 填空/简答这类没有选项的题：没有可点的选项，也不该走「答题后」等待链。
        // 但填空题有 input 可以作答（blank-item-dynamic），只有连填空框都没有才翻页。
        // 先给一次很短的宽限，避免把选项还没渲染完的选择题当成填空题跳过。
        await this.waitExerciseChoices(questionRoot);
        const hasChoices = Y.Solver.questionChoices(questionRoot).length > 0;
        const hasBlanks = Y.Solver.fillInputs(questionRoot).length > 0;
        if (!hasChoices && !hasBlanks) {
          this.panel.log(`第 ${i + 1} 题没有选项也没有填空框（简答/其他题型），直接翻到下一题`);
          const advanced = await this.advanceExerciseQuestion(questionRoot, fingerprint);
          previousFingerprint = fingerprint;
          if (!advanced) break;
          continue;
        }
        const solved = await this.solveExerciseQuestion(currentRoot, `第 ${i + 1} 题`, fingerprint);
        if (!solved) unsolved.push(`第 ${i + 1} 题`);
        previousFingerprint = fingerprint;
        let shown = null;
        let jumped = false;
        let confirmed = '';
        await Y.Utils.poll(() => {
          const latestRoot = Y.AiWorkspace.getExerciseQuestionBody(Y.AiWorkspace.getExerciseContainer() || currentRoot);
          const stem = Y.Solver.questionStem(latestRoot);
          if (stem && stem !== fingerprint) {
            jumped = true;
            return true;
          }
          shown = Y.Solver.revealedResult(latestRoot);
          if (shown) return true;
          // 早退信号保守：出现结果类文本或提交按钮 disabled 就当作已提交，立刻去点下一题，
          // 不再固定干等 8 秒。本题根本没答成（solved 为 false）时不看提交信号，
          // 免得把「本来就没交上去」的题当成已提交。
          confirmed = solved ? this.exerciseSubmitConfirmed(latestRoot) : '';
          return Boolean(confirmed);
        }, { interval: 400, timeout: 3000 });
        if (jumped) continue;
        if (shown) {
          await Y.Utils.sleep(1200);
          const latestRoot = Y.AiWorkspace.getExerciseQuestionBody(Y.AiWorkspace.getExerciseContainer() || currentRoot);
          if (Y.Solver.questionStem(latestRoot) !== fingerprint) continue;
          this.panel.log(`这题得分 ${shown.score || '0'}，正确答案 ${shown.answer || '见页面'}，进入下一题`);
        } else if (confirmed) {
          this.panel.log(`已确认本题提交（${confirmed}），直接点下一题`);
        } else {
          this.panel.log('这题没有自动进入下一题，改点下一题');
        }
        const opened = await this.openNextExerciseQuestion(currentRoot, fingerprint);
        if (!opened) break;
      }
      if (unsolved.length) {
        this.panel.log(`本次作业有 ${unsolved.length} 题没答成：${unsolved.join('、')}。可以重跑本小节，命中答案缓存的题会直接提交`);
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
