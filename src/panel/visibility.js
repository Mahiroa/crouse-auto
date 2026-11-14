((Y) => {
  // 面板全屏可见性兜底

  // ---- 面板可见性兜底 ----
  // 面板是挂在页面里的 iframe。浏览器进入全屏后只绘制「全屏元素自己的子树」，
  // 面板不在里面就会被整块丢掉 —— 此时 isConnected/display 全都正常，一帧都不画。
  // 又因为面板内容是 document.write 写进去的临时文档，直接 appendChild 换父节点
  // 会重建文档、把面板清空；moveBefore() 是保状态搬运（Chrome 133+），搬完内容不变。
  const REPLACED_TAGS = new Set(['VIDEO', 'IMG', 'CANVAS', 'AUDIO', 'PICTURE', 'EMBED', 'OBJECT', 'IFRAME']);

  function moveKeepingState(node, parent) {
    if (!node || !parent) return false;
    if (node.parentElement === parent) return true;
    if (typeof parent.moveBefore !== 'function') return false;
    try {
      parent.moveBefore(node, null);
    } catch (_) {
      return false;
    }
    return node.parentElement === parent;
  }

  function panelHome() {
    return document.body || document.documentElement;
  }

  function installPanelVisibility(getFrame, log) {
    let replacedNoticed = false;
    const keepAtHome = () => {
      const frame = getFrame();
      if (frame) moveKeepingState(frame, panelHome());
    };
    const sync = () => {
      const frame = getFrame();
      if (!frame) return;
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement || null;
      if (!fsEl) {
        keepAtHome();
        return;
      }
      if (fsEl.contains(frame)) return;
      if (REPLACED_TAGS.has(fsEl.tagName)) {
        // 替换元素（<video> 等）不渲染子节点，搬进去照样看不见，只能如实说明
        if (!replacedNoticed) {
          replacedNoticed = true;
          log(`页面把 <${fsEl.tagName.toLowerCase()}> 直接全屏了：全屏时浏览器只绘制全屏元素本身，面板会被隐藏，退出全屏即恢复`);
        }
        return;
      }
      if (moveKeepingState(frame, fsEl)) log('已进入全屏，面板搬进全屏层继续显示');
    };
    const onFullscreenChange = () => {
      try {
        sync();
      } catch (_) {}
    };
    Y.addNativeListener(document, 'fullscreenchange', onFullscreenChange, true);
    Y.addNativeListener(document, 'webkitfullscreenchange', onFullscreenChange, true);
    // iframe 直接挂在 <html> 下是非法结构（document-start 时 body 还不存在），
    // 站点做整页替换时容易被一起清掉；文档解析完归位到 <body>
    if (document.body) keepAtHome();
    else Y.addNativeListener(document, 'DOMContentLoaded', keepAtHome, { once: true });
  }

  // 面板真的挂不上时，别只留一句 console.error —— 那和「脚本没运行」在页面上完全同形
  function showPanelFailureNotice(err) {
    try {
      const box = document.createElement('div');
      box.setAttribute('data-ykt-helper-notice', '1');
      box.textContent = `雨课堂刷课助手 v${Y.Config.version} 面板没挂上：${err && err.message ? err.message : err}（详见控制台）`;
      box.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;max-width:520px;'
        + 'padding:10px 14px;border-radius:10px;background:#b91c1c;color:#fff;'
        + 'font:13px/1.6 "Microsoft YaHei","PingFang SC",sans-serif;box-shadow:0 10px 24px rgba(0,0,0,.3)';
      (document.body || document.documentElement)?.appendChild(box);
    } catch (_) {}
  }

  Y.REPLACED_TAGS = REPLACED_TAGS;
  Y.moveKeepingState = moveKeepingState;
  Y.panelHome = panelHome;
  Y.installPanelVisibility = installPanelVisibility;
  Y.showPanelFailureNotice = showPanelFailureNotice;
})(Y);
