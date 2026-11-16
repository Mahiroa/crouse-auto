((Y) => {
  // 引导启动与面板挂载（boot）

  // ---- 启动 ----
  async function boot() {
    if (Y.Utils.inIframe()) return;
    await Y.Utils.waitForMountTarget();
    // 留一个「脚本真的跑起来了」的痕迹：面板看不见时，靠它一眼区分
    // 「脚本没运行」和「运行了但面板被隐藏/被盖住」，不用再猜。
    // 必须等 waitForMountTarget —— document-start 时 documentElement 往往还不存在，
    // 早写会被可选链静默跳过（实测踩过）。
    try {
      document.documentElement?.setAttribute('data-ykt-helper', Y.Config.version);
    } catch (_) {}
    const mountPanel = () => {
      Y.panel = Y.createPanel();
      Y.panel.log(`雨课堂刷课助手 v${Y.Config.version} 已加载`);
      // 环境体检：把「页面有没有被风控看出来的自动化痕迹」直接报在面板上，
      // 省得再靠页面抛 automation-risk-probe 才知道。Y.Stealth 可能不存在（切片测试），必须可选调用。
      try {
        const risk = Y.Stealth?.report?.();
        if (risk) {
          Y.panel.log(
            '环境体检 score=' + risk.score + '（' + risk.riskLevel + '）'
            + (risk.patchedNatives.length
              ? ' · 被改写：' + risk.patchedNatives.join('/')
              : ' · 原生 API 完整')
          );
        }
      } catch (_) {}
      Y.panel.setStartHandler(Y.start);
      Y.installPanelVisibility(
        () => Y.panel?.frame,
        message => Y.panel?.log(message)
      );
      const pendingAutoStart = Y.Store.getPendingAutoStart();
      const currentClassroomId = Y.Utils.getCurrentClassroomId();
      if (
        pendingAutoStart
        && Y.Utils.isSupportedLearningPage()
        && currentClassroomId
        && pendingAutoStart.classroomId === currentClassroomId
      ) {
        Y.panel.log(`检测到跨页面跳转，自动恢复刷课：课堂 ${currentClassroomId}`);
        setTimeout(() => Y.panel.start(), 1200);
      }
    };
    try {
      mountPanel();
      // 平台的提交确认弹窗会「脚本正在等 AI 接口」的时候弹出来：只靠 poll/humanClick 的
      // 闸门会漏掉整段等待时间（真机 3.6.8 就是这样，弹窗一直挂着没人点）。
      // 挂一个低频看门狗专盯它，主流程忙别的也不会漏。
      try {
        Y.Utils.startWatchdog?.();
      } catch (_) {}
      // 启动后静默查一次 GitHub Release：有新版就把面板上的「更新」按钮亮出来。
      // 延迟几秒，别和课程目录/播放器的首屏抢请求；没有新版本时不说话。
      setTimeout(() => {
        try {
          Y.Updater?.checkForUpdate?.({ force: false });
        } catch (_) {}
      }, 4000);
    } catch (err) {
      Y.Stealth?.warn?.('面板初始化失败', err);
      // 文档没就绪 / 挂载点没出来时等 DOM 就绪再试一次；仍失败就留一条页面级提示
      const retry = () => {
        try {
          mountPanel();
        } catch (err2) {
          Y.Stealth?.warn?.('面板初始化重试失败', err2);
          Y.showPanelFailureNotice(err2);
        }
      };
      if (document.readyState === 'loading') {
        Y.addNativeListener(document, 'DOMContentLoaded', retry, { once: true });
      } else {
        setTimeout(retry, 800);
      }
    }
  }

  Y.boot = boot;
})(Y);
