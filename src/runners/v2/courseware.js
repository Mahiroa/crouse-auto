((Y) => {
  // v2 作业、课堂与课件处理

  const V2RunnerCoursewareMixin = {
    async handleHomework(item, idx) {
      const featureFlags = Y.Store.getFeatureConf();
      if (!featureFlags.autoAI) {
        this.panel.log('已关闭AI自动答题，跳过该项');
        idx++;
        this.updateProgress(this.outside, idx);
        return idx;
      }
      this.panel.log('进入作业，读取题目并请求 AI');
      if (Y.Utils.isFastMode()) this.panel.log('快速模式已开启，读题和点击不再等待');
      // 点作业项是导航动作：返回值 false 表示被安全核验拦下/没点到，此时仍在目录页。
      // 以前丢弃返回值会继续读题（读不到）→ 判定“第 1 题已完成”→ 最后 history.back()，多退一页且整份作业被跳过。
      const itemTitle = item.querySelector('h2')?.innerText?.trim() || `第${idx + 1}项`;
      const entered = await Y.Utils.humanClick(item, 1200, 2600);
      if (!entered) {
        this.panel.warn(`进入作业「${itemTitle}」被安全核验拦截，已停下（进度保留，核验后重新开始会从这一项续跑）`);
        this.panel.track({ id: `v2-${this.outside}-${idx}`, kind: 'homework', title: itemTitle, status: 'skip', detail: '安全核验，未进入' });
        this.panel.resetStartButton('待核验，已停止');
        this.shouldStop = true;
        return idx;
      }
      await Y.Utils.humanPause(1500, 2800);
      let i = 0;
      const maxRetry = 3; // 最大重试次数
      while (i < 40) {
        const items = document.querySelectorAll('.subject-item.J_order');
        const targetEl = document.querySelector('.item-type')?.parentElement || document.querySelector('.item-body');
        const revealedNow = Y.Solver.revealedResult(targetEl);
        if (revealedNow) {
          this.panel.log(`这题得分 ${revealedNow.score || '0'}，正确答案 ${revealedNow.answer || '见页面'}，进入下一题`);
          const nextItem = items[i + 1];
          if (!nextItem) break;
          await Y.Utils.humanClick(nextItem, 1000, 2400);
          await Y.Utils.humanPause(1200, 2200);
          i++;
          continue;
        }
        // 不再用「提交按钮 disabled」反推已作答：站点在未作答时提交按钮本来就是 disabled，
        // 会把整道题/整份作业误判成已完成。只认当前题干容器里的显式结果/状态文本；
        // 状态扫描也限定在当前题干容器（AiWorkspace.isExerciseAnswered 内做了范围限制）。
        const answeredNow = targetEl ? Y.AiWorkspace.isExerciseAnswered(targetEl) : false;
        if (!targetEl || answeredNow) {
          this.panel.log(targetEl
            ? `第 ${i + 1} 题已完成，等页面自己进入下一题`
            : `第 ${i + 1} 题未找到题干容器，等页面自己进入下一题`);
          const before = (targetEl?.innerText || '').slice(0, 80);
          // 轮询被安全核验拦下时不能当作“页面已自动换题”继续点下一题，否则会在核验弹窗上
          // 一题一题往下跳，最终把整份作业记成处理完。此时停住并保留进度。
          let verificationSkipped = false;
          const moved = await Y.Utils.poll(() => {
            const now = (document.querySelector('.item-body')?.innerText || '').slice(0, 80);
            return now && now !== before;
          }, { interval: 500, timeout: 4000, onSkip: () => { verificationSkipped = true; } });
          if (verificationSkipped) {
            this.panel.warn(`第 ${i + 1} 题检测到安全核验，作业处理已停住（未记完成、未推进进度）`);
            this.panel.track({ id: `q-${this.outside}-${idx}-${i}`, kind: 'question', title: `第 ${i + 1} 题`, status: 'skip', detail: '安全核验，已停住' });
            this.panel.resetStartButton('待核验，已停止');
            this.shouldStop = true;
            return idx;
          }
          if (moved) {
            i++;
            continue;
          }
          const nextItem = items[i + 1];
          if (!nextItem) {
            this.panel.log(`所有题目处理完毕，共 ${items.length} 题，请检查后交卷`);
            break;
          }
          await Y.Utils.humanClick(nextItem, 1000, 2400);
          await Y.Utils.humanPause(1200, 2200);
          i++;
          continue;
        }
        const questionType = Y.Solver.detectQuestionType(targetEl);
        const optionCount = Y.Solver.questionChoices(targetEl).length;
        const captured = await Y.Solver.captureQuestion(targetEl);
        const questionText = captured?.text || '';
        if (captured?.image || questionText.length > 5) {
          this.panel.track({ id: `q-${this.outside}-${idx}-${i}`, kind: 'question', title: `第 ${i + 1} 题`, detail: questionText, status: 'doing' });
          let retryCount = 0;
          let success = false;
          while (retryCount < maxRetry && !success) {
            try {
              if (retryCount > 0) {
                this.panel.log(`🔄 第 ${i + 1} 题重试 ${retryCount}/${maxRetry}...`);
              }
              this.panel.log(`当前是${Y.Solver.questionTypeName(questionType)}`);
              if (i > 0) await Y.Utils.humanPause(2500, 9000);
              const aiText = await Y.Solver.askAI(questionText, optionCount, captured.image, questionType, captured.element);
              const before = Y.Solver.questionStem(targetEl);
              const submitted = await Y.Solver.autoSelectAndSubmit(aiText, targetEl, questionType);
              if (!submitted) throw new Error('未能选中答案或提交');
              success = true;
              let shown = null;
              let jumped = false;
              await Y.Utils.poll(() => {
                const body = document.querySelector('.item-body') || targetEl;
                const stem = Y.Solver.questionStem(body);
                if (stem && stem !== before) {
                  jumped = true;
                  return true;
                }
                shown = Y.Solver.revealedResult(body);
                return Boolean(shown);
              }, { interval: 400, timeout: 8000 });
              if (!jumped) {
                if (shown) {
                  await Y.Utils.sleep(1200);
                  const stem = Y.Solver.questionStem(document.querySelector('.item-body') || targetEl);
                  jumped = Boolean(stem && stem !== before);
                }
                if (!jumped) {
                  const nextItem = items[i + 1];
                  this.panel.log(shown
                    ? `这题得分 ${shown.score || '0'}，正确答案 ${shown.answer || '见页面'}，进入下一题`
                    : '这题没有自动进入下一题，改点下一题号');
                  if (nextItem) await Y.Utils.humanClick(nextItem, 1000, 2400);
                }
              }
            } catch (err) {
              retryCount++;
              this.panel.log(`AI 答题失败：${err}`);
              if (retryCount < maxRetry) {
                this.panel.log(`等待一会儿后重试...`);
                await Y.Utils.humanPause(4000, 9000);
              } else {
                this.panel.log(`⚠️ 第 ${i + 1} 题重试 ${maxRetry} 次后仍失败，跳过`);
              }
            }
          }
          if (!success) {
            const nextItem = items[i + 1];
            this.panel.log(`第 ${i + 1} 题未能完成，${nextItem ? '尝试进入下一题' : '已是最后一题'}`);
            if (nextItem) {
              await Y.Utils.humanClick(nextItem, 1000, 2400);
              await Y.Utils.humanPause(1200, 2200);
            }
          }
        } else {
          // 截图/OCR/字体还原全部失败时不要再静默 i++，否则面板看起来像“跳过”，
          // 实际内部题号已经和页面题号脱钩
          this.panel.log(`第 ${i + 1} 题没有读到题目内容（截图/OCR 失败），跳过`);
          this.panel.track({ id: `q-${this.outside}-${idx}-${i}`, kind: 'question', title: `第 ${i + 1} 题`, status: 'skip', detail: '未能读取题目' });
        }
        await Y.Utils.humanPause(2500, 9000);
        i++;
      }
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Y.Utils.humanPause(1500, 3000);
      return idx;
    },
    async handleClassroom(course) {
      this.panel.log('进入课堂模式...');
      // 导航点击失败（安全核验跳过/元素失效）时仍停在目录页：不能再等 5 秒后 history.go(-1)
      const classroomTitle = course.querySelector('h2')?.innerText?.trim() || '课堂';
      const entered = await Y.Utils.humanClick(course, 1000, 2200);
      if (!entered) {
        this.panel.warn(`进入课堂「${classroomTitle}」被安全核验拦截，已停下（未记完成、未推进进度）`);
        this.panel.track({ id: `v2-${this.outside}`, kind: 'course', title: classroomTitle, status: 'skip', detail: '安全核验，未进入' });
        this.panel.resetStartButton('待核验，已停止');
        this.shouldStop = true;
        return;
      }
      await Y.Utils.sleep(5000);
      const iframe = document.querySelector('iframe.lesson-report-mobile');
      if (!iframe || !iframe.contentDocument) {
        this.panel.log('未找到课堂 iframe，跳过');
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      const video = iframe.contentDocument.querySelector('video');
      const audio = iframe.contentDocument.querySelector('audio');
      // 以前 waitForEnd 不传 timeout，播放器不派发 ended（或被自动播放策略拦住）时会永久挂起整条链
      const timeout = await Y.Utils.getDDL();
      if (video) {
        Y.Player.applyMediaDefault(video);
        const stopObserve = Y.Player.observePause(video);
        try {
          await Y.Player.waitForEnd(video, timeout);
        } finally {
          stopObserve();
        }
        if (!video.ended) this.panel.log('课堂视频等待超时，继续下一项');
      }
      if (audio) {
        Y.Player.applyMediaDefault(audio);
        await Y.Player.waitForEnd(audio, timeout);
        if (!audio.ended) this.panel.log('课堂音频等待超时，继续下一项');
      }
      this.updateProgress(this.outside + 1, 0);
      history.go(-1);
      await Y.Utils.sleep(1200);
    },
    // 等待课件视频播放完毕；播放器被关闭（弹窗关闭/元素销毁）时自动重新打开
    async waitCoursewareVideo() {
      const deadline = await Y.Utils.getDDL();
      const start = Date.now();
      let boundVideo = null;
      let stopObserve = () => { };
      let reopenAttempts = 0;
      let stableDisplay = '';
      try {
        while (Date.now() - start < deadline) {
          Y.Utils.dismissPopups();
          const video = document.querySelector('video');
          const display = document.querySelector('.xt_video_player_current_time_display');
          if (!video) {
            // 播放器被关闭或视频元素被销毁，重新打开视频框
            const videoBox = document.querySelector('.video-box');
            if (videoBox && !videoBox.innerText.includes('已完成')) {
              this.panel.log('播放器被关闭，正在重新打开');
              videoBox.click();
              boundVideo = null;
            }
            reopenAttempts++;
            if (reopenAttempts >= 4) {
              this.panel.log('播放器恢复失败，刷新页面重试');
              location.reload();
              return false;
            }
            await Y.Utils.sleep(2000);
            continue;
          }
          reopenAttempts = 0;
          if (!display) {
            // 播放器加载中，等待渲染
            await Y.Utils.sleep(800);
            continue;
          }
          if (video !== boundVideo) {
            stopObserve();
            Y.Player.applySpeed();
            Y.Player.mute();
            boundVideo = video;
            stopObserve = Y.Player.observePause(video);
            stableDisplay = '';
          }
          Y.Player.noteDuration(video);
          const times = (display.innerText || '').trim();
          const [nowTime, totalTime] = times.split(' / ').map(text => text?.trim());
          // 连续两次读到相同的非零结束时间，避免 00:00 / 00:00 被当成播完
          if (Y.Player.isDisplayFinished(nowTime, totalTime)) {
            if (stableDisplay === times) return true;
            stableDisplay = times;
          } else {
            stableDisplay = '';
          }
          await Y.Utils.sleep(800);
        }
        return false;
      } finally {
        stopObserve();
      }
    },
    async handleCourseware(course) {
      const tableData = course.parentNode?.parentNode?.parentNode?.__vue__?.tableData;
      const rawDeadline = tableData?.deadline || tableData?.end;
      const numericDeadline = Number(rawDeadline);
      const deadlineTs = rawDeadline instanceof Date
        ? rawDeadline.getTime()
        : (Number.isFinite(numericDeadline) && numericDeadline > 0
          ? numericDeadline
          : (typeof rawDeadline === 'string' ? Date.parse(rawDeadline) : NaN));
      const deadlinePassed = Number.isFinite(deadlineTs) && deadlineTs < Date.now();
      if (deadlinePassed) {
        this.panel.log(`${course.querySelector('h2')?.innerText || '课件'} 已结课，跳过`);
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      const coursewareTitle = course.querySelector('h2')?.innerText?.trim() || '课件';
      // 导航点击失败（安全核验跳过/元素失效）时仍停在目录页：不能再往下点 PPT/视频，
      // 否则会在目录页上 updateProgress + history.back()，多退一页。
      const entered = await Y.Utils.humanClick(course, 1000, 2200);
      if (!entered) {
        this.panel.warn(`进入课件「${coursewareTitle}」被安全核验拦截，已停下（未记完成、未推进进度）`);
        this.panel.track({ id: `v2-${this.outside}`, kind: 'ppt', title: coursewareTitle, status: 'skip', detail: '安全核验，未进入' });
        this.panel.resetStartButton('待核验，已停止');
        this.shouldStop = true;
        return;
      }
      await Y.Utils.humanPause(2000, 3500);

      // 检测"查看课件"按钮（课件概况页专用）
      const checkBtn = document.querySelector('.ppt_img_box .check') || document.querySelector('p.check');
      if (checkBtn && checkBtn.innerText?.trim() === '查看课件') {
        this.panel.log('检测到"查看课件"按钮，正在点击...');
        // 进入课件内容同样是导航动作：点不到就停住，避免后续内容操作全部落空还记完成
        const opened = await Y.Utils.humanClick(checkBtn, 900, 1800);
        if (!opened) {
          this.panel.warn(`打开课件「${coursewareTitle}」的“查看课件”按钮没有点成功，已停下`);
          this.panel.track({ id: `v2-${this.outside}`, kind: 'ppt', title: coursewareTitle, status: 'skip', detail: '安全核验/按钮失效，未打开' });
          this.panel.resetStartButton('待核验，已停止');
          this.shouldStop = true;
          return;
        }
        await Y.Utils.humanPause(1500, 2800);
      }
      const classType = document.querySelector('.el-card__header')?.innerText || '';
      const className = document.querySelector('.dialog-header')?.firstElementChild?.innerText || '课件';
      if (classType.includes('PPT')) {
        const slides = document.querySelector('.swiper-wrapper')?.children || [];
        this.panel.log(`开始播放 PPT：${className}`);
        for (let i = 0; i < slides.length; i++) {
          await Y.Utils.humanClick(slides[i], 700, 1600);
          this.panel.log(`${className}：第 ${i + 1} 张`);
          await Y.Utils.humanPause(4500, 8000);
        }
        await Y.Utils.sleep(Y.Config.pptInterval);
        const videoBoxes = document.querySelectorAll('.video-box');
        if (videoBoxes?.length) {
          this.panel.log('PPT 中有视频，继续播放');
          for (let i = 0; i < videoBoxes.length; i++) {
            if (videoBoxes[i].innerText === '已完成') {
              this.panel.log(`第 ${i + 1} 个视频已完成，跳过`);
              continue;
            }
            videoBoxes[i].click();
            await Y.Utils.sleep(2000);
            const played = await this.waitCoursewareVideo();
            if (!played) this.panel.log(`第 ${i + 1} 个视频等待后仍未显示已完成，继续后面的内容`);
          }
        }
        this.panel.log(`${className} 已播放完毕`);
      } else {
        const videoBox = document.querySelector('.video-box');
        if (videoBox) {
          videoBox.click();
          await Y.Utils.sleep(1800);
          const played = await this.waitCoursewareVideo();
          if (!played) this.panel.log(`${className} 等待后仍未显示已完成，进入下一项`);
          else this.panel.log(`${className} 视频播放完毕`);
        }
      }
      this.updateProgress(this.outside + 1, 0);
      history.back();
      await Y.Utils.sleep(1000);
    }
  };

  Y.V2RunnerCoursewareMixin = V2RunnerCoursewareMixin;
})(Y);
