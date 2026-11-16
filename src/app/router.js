((Y) => {
  // 页面路由分发（start）

  // ---- 路由 ----
  function start() {
    // ---- ai-workspace获取课程根目录信息并保存（处理完一个课程重定向到根目录） ----
    const classroomId = Y.Utils.getCurrentClassroomId();
    const returnUrl = Y.Utils.returnUrl()
    Y.Store.setPendingAutoStart(classroomId, returnUrl);
    // 刷课流程里任何一步抛异常都要留痕，不能让面板静默停在半路
    const reportCrash = err => {
      // 统一走 Y.Stealth 出口：quietLog 开启后只进面板，不在 console 里自报自动化身份
      // （Y.Stealth 可能不存在：切片测试 / 旧产物，故可选调用；不存在时退回面板留痕）
      Y.Stealth?.warn?.('刷课流程异常', err);
      // 顺序很重要：resetStartButton 会把徽标设回「待机」，以前先 error 再 reset 会让
      // 「异常」徽标只闪一下，异步崩溃时用户在面板上看不到异常态。先复位按钮，最后写 error。
      Y.panel.resetStartButton('开始刷课');
      Y.panel.error(`刷课流程中断：${err?.message || err}`);
    };
    const aiRoute = Y.AiWorkspace.getRoute();
    if (aiRoute) {
      Y.panel.log(`正在匹配处理逻辑：ai-workspace/lms-graph/${aiRoute.type}`);
      new Y.AiWorkspaceRunner(Y.panel).run().catch(reportCrash);
      return;
    }
    // ---- ai-workspace end
    const url = location.host;
    const path = location.pathname.split('/');
    const matchURL = `${url}${path[0]}/${path[1]}/${path[2]}`;
    Y.panel.log(`正在匹配处理逻辑：${matchURL}`);
    if (matchURL.includes('yuketang.cn/v2/web') || matchURL.includes('gdufemooc.cn/v2/web')) {
      new Y.V2Runner(Y.panel).run().catch(reportCrash);
    } else if (matchURL.includes('yuketang.cn/pro/lms') || matchURL.includes('gdufemooc.cn/pro/lms')) {
      if (document.querySelector('.btn-next')) {
        new Y.ProNewRunner(Y.panel).run().catch(reportCrash);
      } else {
        new Y.ProOldRunner(Y.panel).run();
      }
    } else {
      Y.panel.resetStartButton('开始刷课');
      Y.panel.log('当前页面非刷课页面，应匹配 */v2/web/*、*/pro/lms/* 或 */ai-workspace/lms-graph/*');
    }
  }

  Y.start = start;
})(Y);
