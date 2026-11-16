((Y) => {
  // pro/lms 旧版与新版流程

  // ---- pro/lms 旧版（仅做转发） ----
  class ProOldRunner {
    constructor(panel) {
      this.panel = panel;
    }
    run() {
      this.panel.log('准备打开新标签页...');
      const leafDetail = document.querySelectorAll('.leaf-detail');
      let classCount = Y.Store.getProClassCount() - 1;
      let guard = 0;
      // firstChild 可能是空文本节点；<i> 也可能不存在，直接用会抛 TypeError
      while (leafDetail[classCount] && guard++ < leafDetail.length) {
        const icon = leafDetail[classCount].firstElementChild?.querySelector('i');
        if (icon && String(icon.className || '').includes('shipin')) break;
        classCount++;
        Y.Store.setProClassCount(classCount + 1);
        this.panel.log('课程不属于视频，已跳过');
      }
      leafDetail[classCount]?.click();
    }
  }

  // ---- pro/lms 新版（主要逻辑） ----
  class ProNewRunner {
    constructor(panel) {
      this.panel = panel;
    }
    async run() {
      Y.preventScreenCheck();
      let classCount = Y.Store.getProClassCount();
      let stalledRounds = 0;
      while (true) {
        this.panel.log(`准备播放第 ${classCount} 集...`);
        await Y.Utils.sleep(2000);
        const className = document.querySelector('.header-bar')?.firstElementChild?.innerText || '';
        const classType = document.querySelector('.header-bar')?.firstElementChild?.firstElementChild?.getAttribute('class') || '';
        const classStatus = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
        let finished = true;
        if (classType.includes('tuwen') && !classStatus.includes('已读')) {
          this.panel.log(`正在阅读：${className}`);
          await Y.Utils.sleep(2000);
        } else if (classType.includes('taolun')) {
          this.panel.log(`讨论区暂不自动发帖，${className}`);
          await Y.Utils.sleep(2000);
        } else if (classType.includes('shipin') && !classStatus.includes('100%')) {
          this.panel.log(`2s 后开始播放：${className}`);
          await Y.Utils.sleep(2000);
          let statusTimer = null;
          let videoTimer = null;
          let statusStopped = false;
          let videoStopped = false;
          let stopObserve = () => { };
          // 固定节拍（setInterval 200 / 5000）是自动化探针 automation-risk-probe 最稳的机器特征，
          // 改成「自调度 + 抖动」：每轮跑完再用 Y.Utils.randInt 随机排下一轮。停链靠 stopped 标记
          // 加 clearTimeout：回调醒来第一件事就是看标记，所以 finally 清理后不会再长出第二条链。
          const stopStatusLoop = () => {
            statusStopped = true;
            if (statusTimer) {
              clearTimeout(statusTimer);
              statusTimer = null;
            }
          };
          const stopVideoLoop = () => {
            videoStopped = true;
            if (videoTimer) {
              clearTimeout(videoTimer);
              videoTimer = null;
            }
          };
          const loopStatus = () => {
            if (statusStopped) return;
            statusTimer = setTimeout(() => {
              statusTimer = null;
              if (statusStopped) return;
              try {
                const status = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
                if (Y.Utils.isMarkedDone(status)) {
                  this.panel.log(`${className} 播放完毕`);
                  // 判到完毕即自停，等价于原来的 clearInterval(statusTimer)
                  statusStopped = true;
                }
              } finally {
                // 抛错也不许断链：原来的 setInterval 就是「这一轮出错，下一轮照跑」
                if (!statusStopped) loopStatus();
              }
            }, Y.Utils.randInt(180, 320));
          };
          try {
            loopStatus();

            const videoWaitStart = Date.now();
            const loopVideo = () => {
              if (videoStopped) return;
              videoTimer = setTimeout(() => {
                videoTimer = null;
                if (videoStopped) return;
                try {
                  const video = document.querySelector('video');
                  if (video) {
                    // 直接同步注册观察器：observePause 内部自带 0.8~1.4 秒的抖动轮询，不需要外部再延时 2s。
                    // 关键是不能在 setTimeout 回调里延迟赋值 stopObserve —— video 在轮询末段才出现时，
                    // finished 的 poll 可能先返回，finally 调用到的仍是初始空函数，
                    // 之后照样会挂上一整套轮询和监听器（每集泄漏一套）。
                    Y.Player.applySpeed();
                    Y.Player.mute();
                    // 保存清理函数：每集都挂一套轮询/监听器会越积越多
                    stopObserve = Y.Player.observePause(video);
                    // 等到播放器即自停，等价于原来的 clearInterval(videoTimer)
                    videoStopped = true;
                  } else if (Date.now() - videoWaitStart > 20000) {
                    // 20 秒上限仍是墙钟硬判定，与抖动无关：单轮最长 6 秒，所以最迟第 4~6 轮
                    // （约 20.0~26.0 秒）必然 reload，不会因为抖动把「多久收尾」变成不确定
                    location.reload();
                  }
                } finally {
                  if (!videoStopped) loopVideo();
                }
              }, Y.Utils.randInt(4000, 6000));
            };
            loopVideo();

            await Y.Utils.sleep(8000);
            finished = await Y.Utils.poll(() => {
              const status = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
              return Y.Utils.isMarkedDone(status);
            }, { interval: 1000, timeout: await Y.Utils.getDDL() });
          } finally {
            // 两条自调度链一起停：先置标志再清 id，已在队列里的那一轮醒来不会重排
            stopStatusLoop();
            stopVideoLoop();
            // 观察器现在是同步注册的，finally 一定能拿到真实清理函数（不再有空函数竞态）
            stopObserve();
          }
          if (!finished) this.panel.log(`${className} 等待后仍未显示已完成，进入下一集`);
        } else if (classType.includes('zuoye')) {
          this.panel.log(`进入作业：${className}（暂无自动答题）`);
          await Y.Utils.sleep(2000);
        } else if (classType.includes('kaoshi')) {
          this.panel.log(`进入考试：${className}（不会自动答题）`);
          await Y.Utils.sleep(2000);
        } else if (classType.includes('ketang')) {
          this.panel.log(`进入课堂：${className}（暂无自动功能）`);
          await Y.Utils.sleep(2000);
        } else {
          this.panel.log(`已看过：${className}`);
          await Y.Utils.sleep(2000);
        }
        this.panel.log(`第 ${classCount} 集处理完成`);
        // “下一节”按钮有时要等平台把本节标记完成后才出现/才可点，
        // 这里等它一下，避免刚播完就误判成“课程播放完毕”
        const findNextButton = () => [...document.querySelectorAll('.btn-next')].find(btn => {
          if (!btn.isConnected) return false;
          const rect = btn.getBoundingClientRect();
          const style = getComputedStyle(btn);
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          const disabled = btn.disabled || btn.classList.contains('is-disabled') || btn.getAttribute('aria-disabled') === 'true';
          return visible && !disabled;
        });
        let nextBtn = findNextButton();
        // poll 只返回 boolean，不返回 checker 的返回值：以前 `nextBtn = await poll(...)` 会把 true
        // 当按钮传给 humanClick → TypeError: element.click is not a function，整轮 Pro 刷课直接崩。
        // 正确做法：先等“按钮出现”，再重新 findNextButton() 拿真实元素。
        let nextBtnPollSkipped = false;
        if (!nextBtn) {
          const appeared = await Y.Utils.poll(() => Boolean(findNextButton()), {
            interval: 500,
            timeout: 15000,
            onSkip: () => { nextBtnPollSkipped = true; }
          });
          if (appeared) nextBtn = findNextButton();
        }
        if (!nextBtn) {
          if (nextBtnPollSkipped) {
            // 安全核验导致按钮读不到 ≠ 课程结束：不能清 proClassCount / pendingAutoStart，
            // 否则用户核验后重新开始会从第 1 集重刷。这里只停下，保留持久化进度。
            this.panel.warn('检测到安全核验，已停在当前集。请手动完成核验后再点「开始刷课」，会从当前集继续');
            this.panel.track({ id: `pro-${classCount}`, kind: 'video', title: className || `第 ${classCount} 集`, status: 'skip', detail: '安全核验，已停住' });
            this.panel.resetStartButton('待核验，已停止');
            break;
          }
          localStorage.removeItem(Y.Config.storageKeys.proClassCount);
          this.panel.log('课程播放完毕 🎉');
          Y.Store.clearPendingAutoStart();
          this.panel.resetStartButton('开始刷课');
          break;
        }
        const beforeTitle = document.querySelector('.header-bar')?.firstElementChild?.innerText || '';
        // 点“下一节”同样是导航动作：被核验拦下时停住并保留进度，不要继续 poll switched
        const clickedNext = await Y.Utils.humanClick(nextBtn, 1200, 2600);
        if (!clickedNext) {
          this.panel.warn('点击「下一节」被安全核验拦截，已停在当前集（进度保留）');
          this.panel.track({ id: `pro-${classCount}`, kind: 'video', title: className || `第 ${classCount} 集`, status: 'skip', detail: '安全核验，未切换' });
          this.panel.resetStartButton('待核验，已停止');
          break;
        }
        const switched = await Y.Utils.poll(() => {
          const title = document.querySelector('.header-bar')?.firstElementChild?.innerText || '';
          return Boolean(title) && title !== beforeTitle;
        }, { interval: 500, timeout: 20000 });
        if (!switched) {
          // 不再先自增再验证：点不动时旧代码会一路把持久化集数写大，
          // 每轮重播当前集且永远退不出去
          stalledRounds++;
          this.panel.log(`点了下一节但页面还没切过去（${stalledRounds}/3）`);
          if (stalledRounds >= 3) {
            this.panel.warn('连续 3 次切换下一节失败，已停止。请手动点一次下一节后再开始');
            this.panel.resetStartButton('开始刷课');
            break;
          }
          await Y.Utils.sleep(1500);
          continue;
        }
        stalledRounds = 0;
        classCount++;
        Y.Store.setProClassCount(classCount);
      }
    }
  }

  Y.ProOldRunner = ProOldRunner;
  Y.ProNewRunner = ProNewRunner;
})(Y);
