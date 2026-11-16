((Y) => {
  // 原生事件注册与切屏拦截兼容层
  // 三档 screenGuard：off（默认，页面零改写）/ cdp（外部 CDP 接管，页面零改写）/ patch（加固改写）

  // 页面上的 addEventListener 会被替换成「吞掉 visibilitychange/blur/pagehide」的版本，
  // 这里保留原始 add 供脚本自己使用（否则 keepAlive 注册的 visibilitychange 也会被吞）。
  // 注意：map 里存的永远是原始实现，Y.addNativeListener 依赖它绕过拦截，语义不能变。
  const nativeAddMap = new WeakMap();

  // 已经加固过的 window（同一 window 只包一层，避免重复套 Proxy）
  const patchedWindows = new WeakSet();

  // cdp 档只提示一次，避免每帧刷屏
  let cdpNoticed = false;

  const BLACK_LIST = ['visibilitychange', 'blur', 'pagehide'];

  function addNativeListener(target, type, listener, options) {
    const add = nativeAddMap.get(target);
    return add ? add(type, listener, options) : target.addEventListener(type, listener, options);
  }

  // 把我们的包装函数伪装回原生实现：
  // Proxy 的 apply 转发之后，Function.prototype.toString 拿到的还是
  // "function () { [native code] }"，再把 name/length 按原函数回填，
  // 风控 SDK 最常用的「toString 比对原生」就看不出来了。
  // 只用于包装我们自己的箭头函数，所以 defineProperty 回写 name 不会伤到页面原生函数。
  function maskNative(fn, name) {
    if (typeof fn !== 'function') return fn;
    let wrapped;
    try {
      wrapped = new Proxy(fn, {
        apply(target, thisArg, args) {
          return Reflect.apply(target, thisArg, args);
        }
      });
    } catch (_) {
      return fn;
    }
    try {
      if (name) Object.defineProperty(wrapped, 'name', { configurable: true, value: name });
    } catch (_) {}
    try {
      Object.defineProperty(wrapped, 'length', { configurable: true, value: fn.length });
    } catch (_) {}
    return wrapped;
  }

  // 三档模式：只认 Y.Stealth.conf() 的归一化结果，取不到就当 off（最安全的一档）
  function screenGuardMode() {
    let mode;
    try {
      mode = Y.Stealth?.conf?.()?.screenGuard;
    } catch (_) {
      mode = undefined;
    }
    return mode === 'patch' || mode === 'cdp' ? mode : 'off';
  }

  function currentDocument() {
    try {
      if (typeof document !== 'undefined' && document) return document;
    } catch (_) {}
    try {
      const win = currentWindow(null);
      if (win && win.document) return win.document;
    } catch (_) {}
    return null;
  }

  function currentWindow(doc) {
    try {
      const win = typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
      if (win) return win;
    } catch (_) {}
    try {
      if (doc && doc.defaultView) return doc.defaultView;
    } catch (_) {}
    return null;
  }

  function makeMaskedAdd(target, blackList) {
    const originalAdd = target.addEventListener.bind(target);
    const linkedAdd = (...args) => (blackList.has(args[0]) ? undefined : originalAdd(...args));
    return { originalAdd, maskedAdd: maskNative(linkedAdd, 'addEventListener') };
  }

  // 切走页面时，雨课堂会暂停视频和作业。这里拦住切屏事件，连作业所在的 iframe 一起拦。
  function patchScreenCheck(win, doc) {
    if (!win || !doc || doc._yktScreenCheck) return;
    doc._yktScreenCheck = true;
    const blackList = new Set(BLACK_LIST);
    if (!patchedWindows.has(win)) {
      patchedWindows.add(win);
      const winAdd = makeMaskedAdd(win, blackList);
      nativeAddMap.set(win, winAdd.originalAdd);
      win.addEventListener = winAdd.maskedAdd;
    }
    if (!nativeAddMap.has(doc)) {
      const docAdd = makeMaskedAdd(doc, blackList);
      nativeAddMap.set(doc, docAdd.originalAdd);
      doc.addEventListener = docAdd.maskedAdd;
    }
    try {
      Object.defineProperties(doc, {
        hidden: { configurable: true, get: maskNative(() => false, 'get hidden') },
        visibilityState: { configurable: true, get: maskNative(() => 'visible', 'get visibilityState') },
        hasFocus: { configurable: true, value: maskNative(() => true, 'hasFocus') },
        onvisibilitychange: { configurable: true, get: () => undefined, set: () => { } },
        onblur: { configurable: true, get: () => undefined, set: () => { } }
      });
      Object.defineProperties(win, {
        onblur: { configurable: true, get: () => undefined, set: () => { } },
        onpagehide: { configurable: true, get: () => undefined, set: () => { } }
      });
    } catch (_) {}
  }

  // patch 档：安装加固版拦截（含 iframe 递归与 MutationObserver 兜底）
  function installScreenGuard() {
    const doc = currentDocument();
    if (!doc) return;
    const win = currentWindow(doc);
    patchScreenCheck(win, doc);
    const hookFrame = frame => {
      try {
        if (!frame || !frame.contentWindow || !frame.contentDocument) return;
        patchScreenCheck(frame.contentWindow, frame.contentDocument);
      } catch (_) {}
    };
    const bind = frame => {
      if (!frame || frame._yktScreenCheckBound) return;
      frame._yktScreenCheckBound = true;
      hookFrame(frame);
      frame.addEventListener('load', () => hookFrame(frame));
    };
    try {
      for (const frame of doc.querySelectorAll('iframe')) bind(frame);
    } catch (_) {}
    if (doc._yktScreenCheckWatch) return;
    doc._yktScreenCheckWatch = true;
    try {
      new MutationObserver(mutations => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.tagName === 'IFRAME') bind(node);
            else if (node.querySelectorAll) {
              for (const nested of node.querySelectorAll('iframe')) bind(nested);
            }
          }
        }
      }).observe(doc.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  }

  function preventScreenCheck() {
    const mode = screenGuardMode();
    // off 是默认档：立刻 return，一个字都不碰 window/document。
    // 这是本次改造的核心目的——干净环境里不留任何被改写过的原生 API。
    if (mode === 'off') return;
    if (mode === 'cdp') {
      // 页面同样不动，切屏伪装交给外部 CDP 的 Emulation.setFocusEmulationEnabled
      if (cdpNoticed) return;
      cdpNoticed = true;
      try {
        Y.panel?.log?.('切屏拦截：已切到 CDP 模式，页面不做任何改写');
      } catch (_) {}
      return;
    }
    installScreenGuard();
  }

  Y.nativeAddMap = nativeAddMap;
  Y.addNativeListener = addNativeListener;
  Y.patchScreenCheck = patchScreenCheck;
  Y.preventScreenCheck = preventScreenCheck;
})(Y);
