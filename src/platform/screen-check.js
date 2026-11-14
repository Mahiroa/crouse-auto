((Y) => {
  // 原生事件注册与切屏拦截兼容层

  // ---- 切屏拦截 ----
  // 页面上的 addEventListener 会被替换成“吞掉 visibilitychange/blur/pagehide”的版本，
  // 这里保留原始 add 供脚本自己使用（否则 keepAlive 注册的 visibilitychange 也会被吞）
  const nativeAddMap = new WeakMap();

  function addNativeListener(target, type, listener, options) {
    const add = nativeAddMap.get(target);
    return add ? add(type, listener, options) : target.addEventListener(type, listener, options);
  }

  // 切走页面时，雨课堂会暂停视频和作业。这里拦住切屏事件，连作业所在的 iframe 一起拦。
  function patchScreenCheck(win, doc) {
    if (!win || !doc || doc._yktScreenCheck) return;
    doc._yktScreenCheck = true;
    const blackList = new Set(['visibilitychange', 'blur', 'pagehide']);
    if (!win._addEventListener) {
      win._addEventListener = win.addEventListener.bind(win);
      nativeAddMap.set(win, win._addEventListener);
      win.addEventListener = (...args) => blackList.has(args[0]) ? undefined : win._addEventListener(...args);
    }
    if (!doc._addEventListener) {
      doc._addEventListener = doc.addEventListener.bind(doc);
      nativeAddMap.set(doc, doc._addEventListener);
      doc.addEventListener = (...args) => blackList.has(args[0]) ? undefined : doc._addEventListener(...args);
    }
    try {
      Object.defineProperties(doc, {
        hidden: { configurable: true, get: () => false },
        visibilityState: { configurable: true, get: () => 'visible' },
        hasFocus: { configurable: true, value: () => true },
        onvisibilitychange: { configurable: true, get: () => undefined, set: () => { } },
        onblur: { configurable: true, get: () => undefined, set: () => { } }
      });
      Object.defineProperties(win, {
        onblur: { configurable: true, get: () => undefined, set: () => { } },
        onpagehide: { configurable: true, get: () => undefined, set: () => { } }
      });
    } catch (_) {}
  }

  function preventScreenCheck() {
    patchScreenCheck(unsafeWindow, document);
    const hookFrame = frame => {
      try {
        if (!frame?.contentWindow || !frame.contentDocument) return;
        patchScreenCheck(frame.contentWindow, frame.contentDocument);
      } catch (_) {}
    };
    for (const frame of document.querySelectorAll('iframe')) hookFrame(frame);
    if (document._yktScreenCheckWatch) return;
    document._yktScreenCheckWatch = true;
    const bind = frame => {
      if (!frame || frame._yktScreenCheckBound) return;
      frame._yktScreenCheckBound = true;
      hookFrame(frame);
      frame.addEventListener('load', () => hookFrame(frame));
    };
    for (const frame of document.querySelectorAll('iframe')) bind(frame);
    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.tagName === 'IFRAME') bind(node);
          else if (node.querySelectorAll) {
            for (const nested of node.querySelectorAll('iframe')) bind(nested);
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  Y.nativeAddMap = nativeAddMap;
  Y.addNativeListener = addNativeListener;
  Y.patchScreenCheck = patchScreenCheck;
  Y.preventScreenCheck = preventScreenCheck;
})(Y);
