((Y) => {
  // 安全核验求解（轨迹型 canvas）
  //
  // 平台的安全核验是一道影子 DOM 里的 canvas 轨迹题：
  //   #homework-automation-risk-challenge → open shadowRoot →
  //   <canvas width="340" height="220" aria-label="随机轨迹核验区域">
  // 页面上没有任何可读的 DOM 点，human-check 只能知道「弹窗还在」，看不到「题目是什么」，
  // 所以刷课流程一旦撞上核验就只能停住等人。这个模块负责把题认出来 + 按人手的轨迹拖完。
  //
  // 这道题不需要截图：同一个页面里有两条更硬的路，成本从低到高
  //   Tier A  钩 canvas 2D 绘制 API：组件自己把 fillText('2', x, y) 交出来，
  //           数字、圆心、颜色、绘制顺序全都有 —— 识别成本 0，100% 准。
  //   Tier B  canvas.getContext('2d').getImageData()：画布同源没被污染，
  //           直接读像素做色块分割 + 数字模板匹配，比截图快（不编码 PNG、不依赖外部工具）。
  //   Tier C  才是截图（canvas.toDataURL()/CDP）。本项目不采用，多一次编码和一次异步等待，
  //           而 A/B 两条路已经覆盖了「同页可读」的全部情况。
  //
  // 实测常量（从三张真实弹窗截图量出来，HSV）：
  //   起点蓝 rgb(36,127,255) hue≈215 / 终点绿 rgb(64,162,23) hue≈102 / 数字紫 rgb(118,52,210) hue≈265
  //   网格和背景是低饱和（sat<0.1），所以 sat>0.45 就能把点全切出来，不需要任何阈值调参；
  //   数字是白色实心字：min(R,G,B)>200 且落在圆心 0.72r 以内。
  //
  // 三条调用约定（都是踩过坑才定下来的）：
  //   1) 过程信息一律走注入的 log 回调，默认打到面板。模块内部不 console.log，
  //      否则开控制台查别的问题时会被核验日志刷屏，也看不出哪条是脚本说的、哪条是平台的。
  //   2) installHooks() 必须赶在组件第一次重绘之前装好；userscript 是 @run-at document-start，
  //      所以模块求值时就自装一次（见文件末尾），create() 里再调是幂等的，不会重复包原型。
  //   3) 认不准就不拖：数字必须是 1..N 的排列、起点终点各一个，否则宁可返回 null 让调用方重试，
  //      乱拖一次会被平台判成机器，比不解更糟。

  const HOST_ID = 'homework-automation-risk-challenge';
  const ARIA = /随机轨迹核验|轨迹核验|安全核验/;

  // 钩子只记小画布：页面上还有播放器/课件用的整屏 canvas，那些绘制跟核验无关；
  // 全留下来会把 ops 顶到上限，还会把 Tier A「最近一次整幅 clearRect」的切分位置带偏。
  const MAX_CANVAS_SIDE = 1024;
  // 记录上限：核验组件每帧重绘，长时间挂机不设上限内存会一直涨。
  // 到顶后丢掉前一半（而不是全部），保证「最近一次重绘」还在，Tier A 仍然可用。
  const OPS_LIMIT = 5000;
  const OPS_KEEP = 2500;

  // 数字模板统一降到 12x16 再比，和弹窗里 13px 的实心字宽高比一致
  const TW = 12;
  const TH = 16;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const ri = (a, b) => Math.floor(rnd(a, b + 1));

  // 默认日志出口：面板还没挂上（document-start 阶段）时静默，不能因为日志把流程打断
  const defaultLog = (message) => Y.panel?.log?.(message);

  // 钩子的真身只有这一份：document-start 装一次，之后所有 create() 共用同一份记录。
  // 每个实例各自持有一份数组没有意义 —— 组件只在页面上画一次，谁读到都是同一批绘制。
  const HOOK_STORE = { ops: [], hooked: false };

  // ───────────────────────── 取 canvas（穿透 shadow root） ─────────────────────────
  // 组件挂在 open shadow root 里，document.querySelector('canvas') 是查不到的，
  // 只能沿 shadowRoot 一层层走；深度设上限，避免组件自嵌套时把整棵树翻一遍。
  function walk(root, fn, depth = 0) {
    if (!root || depth > 12) return null;
    const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of nodes) {
      const hit = fn(el);
      if (hit) return hit;
      if (el.shadowRoot) {
        const inner = walk(el.shadowRoot, fn, depth + 1);
        if (inner) return inner;
      }
    }
    return null;
  }

  // 核验弹窗挂在哪个文档里，取决于平台把「作业」放在顶层还是 iframe：
  // 刷课主流程跑在顶层（bootstrap 里 inIframe 直接 return），而作业界面是
  // /v2/web/iframe-exercise/... 的 iframe。只查顶层 document 会永远看不见核验 ——
  // 3.6.7 真机「面板没有任何核验提示、也没有连线动作」就是这个原因。
  function reachableDocuments(root = document, depth = 0) {
    const docs = [root];
    if (depth > 2) return docs;
    let frames = [];
    try {
      frames = [...root.querySelectorAll('iframe')];
    } catch (_) {
      frames = [];
    }
    for (const frame of frames) {
      if (frame.id === 'ykt-helper-iframe') continue;
      let inner = null;
      try {
        inner = frame.contentDocument;
      } catch (_) {
        continue;
      }
      if (!inner || inner === root || docs.includes(inner)) continue;
      for (const doc of reachableDocuments(inner, depth + 1)) {
        if (!docs.includes(doc)) docs.push(doc);
      }
    }
    return docs;
  }

  function findCanvas() {
    for (const doc of reachableDocuments()) {
      const host = doc.getElementById?.(HOST_ID) || doc.querySelector?.('[data-risk-target="challenge"]');
      if (host?.shadowRoot) {
        const direct = host.shadowRoot.querySelector('canvas');
        if (direct) return direct;
        const nested = walk(host.shadowRoot, el => (el.tagName === 'CANVAS' ? el : null));
        if (nested) return nested;
      }
      // 兜底：这个文档里 + 所有 shadow root 找 aria-label 命中的 canvas。
      // 平台改 id 或者把核验区挪进另一个容器时，这条还能命中。
      const byAria = walk(doc, el => (el.tagName === 'CANVAS' && ARIA.test(el.getAttribute('aria-label') || '') ? el : null));
      if (byAria) return byAria;
    }
    return null;
  }

  // 带参数时判那张 canvas；不带参数时判「当前这道核验」——create() 内部和外部调用方
  // 大多数时候只关心「现在还有没有可见的核验」，所以留了无参形态。
  function isVisible(canvas) {
    const cv = canvas || findCanvas();
    if (!cv || !cv.isConnected) return false;
    const rect = cv.getBoundingClientRect();
    // 被 display:none 或折叠起来时 rect 会是 0；这里再兜一道很窄的尺寸下限，
    // 避免把组件预热用的 1x1 离屏画布当成题目
    if (rect.width < 80 || rect.height < 40) return false;
    const view = cv.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
    if (!view) return true;
    let style = null;
    try {
      style = view.getComputedStyle(cv);
    } catch (_) {}
    if (!style) return true;
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.1;
  }

  // 页面里是否已经有可解的核验（找到 canvas 且可见）。调用方拿它决定
  // 「要不要进核验处理分支」，比翻文案（human-check 的活）更硬。
  function isPresent() {
    const canvas = findCanvas();
    return !!canvas && isVisible(canvas);
  }

  // ───────────────────────── Tier A：钩绘制 API ─────────────────────────
  // 只在「第一次调用成功」时包原型；后面每次调用直接复用（幂等），
  // 否则重复包会让一次绘制被记录多份，还会把 orig 链越套越长。
  function installHooks(store) {
    const target = store || HOOK_STORE;
    if (HOOK_STORE.hooked) {
      target.hooked = true;
      return true;
    }
    try {
      const scope = typeof window !== 'undefined' ? window : globalThis;
      const P = scope.CanvasRenderingContext2D?.prototype;
      if (!P) return false;
      // 已经被别的副本（tools/captcha 里同源的独立脚本、或另一个打包版本）包过了：
      // 不重复包，也不假装 Tier A 可用 —— 记录会落到别人的数组里，本模块老实走 Tier B。
      if (P.__riskHooked) return false;

      const rec = HOOK_STORE.ops;
      const snap = (ctx, kind, data) => {
        // 自己造数字模板时的绘制不算「组件的绘制」，否则会挤爆 ops 环（见 buildTemplates）
        if (NO_RECORD) return;
        let cv = null;
        try {
          cv = ctx.canvas;
        } catch (_) {}
        // 大画布直接不记（见 MAX_CANVAS_SIDE 的说明）
        if (cv && (cv.width > MAX_CANVAS_SIDE || cv.height > MAX_CANVAS_SIDE)) return;
        if (rec.length > OPS_LIMIT) rec.splice(0, OPS_KEEP);
        let m = null;
        try {
          m = ctx.getTransform?.();
        } catch (_) {}
        rec.push({
          kind,
          data,
          fill: typeof ctx.fillStyle === 'string' ? ctx.fillStyle : null,
          font: ctx.font,
          m: m ? { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f } : null,
          canvas: cv,
        });
      };

      const orig = {};
      // 只记「能还原题目」的四类调用：圆（arc/ellipse）、白字（fillText/strokeText）、
      // 以及切帧用的 clearRect。drawImage / roundRect / Path2D.arc 曾经也记，但下游没有
      // 任何消费者 —— 白占 ops 环，还把平台真实的绘制往外挤，所以不记了。
      // 真机若确认组件用 Path2D 画圆，需要连带把 getTransform 一起接上再来，不能只记圆心。
      for (const name of ['arc', 'ellipse', 'fillText', 'strokeText', 'clearRect']) {
        if (typeof P[name] !== 'function') continue;
        orig[name] = P[name];
        P[name] = function (...args) {
          // 记录失败绝不影响页面自己的绘制：平台红屏一次，核验就再也过不去了
          try {
            if (name === 'arc') snap(this, 'arc', { x: +args[0], y: +args[1], r: +args[2] });
            else if (name === 'ellipse') snap(this, 'arc', { x: +args[0], y: +args[1], r: Math.max(+args[2], +args[3]) });
            else if (name === 'fillText' || name === 'strokeText') snap(this, 'text', { text: String(args[0]), x: +args[1], y: +args[2] });
            else snap(this, 'clear', { x: +args[0], y: +args[1], w: +args[2], h: +args[3] });
          } catch (_) {}
          return orig[name].apply(this, args);
        };
      }

      // 标记打在原型上，配合上面的 __riskHooked 判定，做到「跨副本也只包一次」
      P.__riskHooked = true;
      HOOK_STORE.hooked = true;
      target.hooked = true;
      return true;
    } catch (_) {
      // 装不上就当没有 Tier A：recognize() 看 store.hooked，自然会落到像素路径
      HOOK_STORE.hooked = false;
      return false;
    }
  }

  // 从钩子里还原题目：把「最近一次整幅 clearRect」之后的绘制当成本题。
  // 组件每帧都是 clearRect → 画网格 → 画圆 → 画数字，所以最后一个整幅 clear 就是本题起点；
  // 没有整幅 clear 的实现就从头算（start=0），不影响识别。
  function dotsFromHooks(canvas, ops) {
    if (!ops?.length) return [];
    let start = 0;
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      if (op.kind === 'clear' && op.data.w >= canvas.width * 0.9 && op.data.h >= canvas.height * 0.9 && op.canvas === canvas) {
        start = i;
        break;
      }
    }
    const slice = ops.slice(start).filter(op => !op.canvas || op.canvas === canvas);

    // 组件可能对 context 做过 scale/translate（高分屏适配），绘制参数是逻辑坐标，
    // 派发事件要的是设备坐标，所以按记录时的变换矩阵换算，同时把半径按缩放比放大
    const toDev = (op, x, y) => {
      const m = op.m;
      return m ? { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f } : { x, y };
    };

    const circles = [];
    for (const op of slice) {
      if (op.kind !== 'arc') continue;
      const p = toDev(op, op.data.x, op.data.y);
      const scale = op.m ? Math.hypot(op.m.a, op.m.b) : 1;
      circles.push({ x: p.x, y: p.y, r: op.data.r * scale, fill: op.fill, order: circles.length });
    }
    const texts = slice.filter(op => op.kind === 'text').map((op) => {
      const p = toDev(op, op.data.x, op.data.y);
      return { text: op.data.text.trim(), x: p.x, y: p.y, font: op.font };
    });

    const dots = [];
    for (const circle of circles) {
      // 半径过滤：太小是网格点/美化装饰，太大是背景圆
      if (!(circle.r >= 6 && circle.r <= canvas.width * 0.2)) continue;
      let best = null;
      let bestDist = Infinity;
      for (const t of texts) {
        // 文字基线和圆心有几像素偏差（textBaseline 不同），所以纵坐标让 0.05r 的余量
        const dist = Math.hypot(t.x - circle.x, t.y - circle.y - circle.r * 0.05);
        if (dist < circle.r * 1.2 && dist < bestDist) {
          bestDist = dist;
          best = t;
        }
      }
      // 只有圆没有字的（背景装饰）不要
      if (!best) continue;
      dots.push({ x: circle.x, y: circle.y, r: circle.r, text: best.text, fill: circle.fill, order: circle.order, font: best.font, src: 'hook' });
    }
    return dots;
  }

  // ───────────────────────── Tier B：getImageData 像素分割 ─────────────────────────
  function hueOf(r, g, b) {
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx === mn) return { h: 0, s: 0, v: mx / 255 };
    const d = mx - mn;
    let h;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return { h, s: d / mx, v: mx / 255 };
  }

  // 三个色相区间就是三种点。区间开得比实测值宽，是因为弹窗背景（浅灰网格）和
  // 浏览器色彩管理会让同一颜色的 hue 漂几个像素，但三者之间隔了 40 度以上，不会串。
  function kindOfHue(h) {
    if (h >= 195 && h <= 240) return 'start';
    if (h >= 85 && h <= 145) return 'end';
    if (h >= 245 && h <= 305) return 'num';
    return null;
  }

  function dotsFromPixels(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { dots: [], why: 'no-2d-context' };
    let img;
    try {
      img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (e) {
      // 只有跨域图片被画进这块 canvas 才会走到这里（画布被污染）
      return { dots: [], why: 'canvas-tainted:' + e.message };
    }
    const { width: W, height: H, data } = img;
    const n = W * H;
    const sat = new Uint8Array(n); // 0 无, 1 start, 2 end, 3 num
    const rgb = new Uint8Array(n * 3);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const { h, s } = hueOf(r, g, b);
      // 背景/网格线是一刀切掉：它们的饱和度远低于 0.45
      if (s < 0.45) continue;
      const kind = kindOfHue(h);
      if (!kind) continue;
      sat[i] = kind === 'start' ? 1 : kind === 'end' ? 2 : 3;
      rgb[i * 3] = r;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = b;
    }

    // 连通域（4 邻域，栈式 BFS；340x220=74800 像素，毫秒级）。
    // 不用递归：栈深 7 万会爆调用栈，这是踩过的坑。
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    const blobs = [];
    for (let i = 0; i < n; i++) {
      if (!sat[i] || seen[i]) continue;
      const kind = sat[i];
      let sp = 0;
      stack[sp++] = i;
      seen[i] = 1;
      let area = 0;
      let sx = 0;
      let sy = 0;
      let minx = W;
      let maxx = 0;
      let miny = H;
      let maxy = 0;
      let cr = 0;
      let cg = 0;
      let cb = 0;
      while (sp) {
        const q = stack[--sp];
        const x = q % W;
        const y = (q / W) | 0;
        area++;
        sx += x;
        sy += y;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
        cr += rgb[q * 3];
        cg += rgb[q * 3 + 1];
        cb += rgb[q * 3 + 2];
        if (x > 0 && sat[q - 1] === kind && !seen[q - 1]) { seen[q - 1] = 1; stack[sp++] = q - 1; }
        if (x < W - 1 && sat[q + 1] === kind && !seen[q + 1]) { seen[q + 1] = 1; stack[sp++] = q + 1; }
        if (y > 0 && sat[q - W] === kind && !seen[q - W]) { seen[q - W] = 1; stack[sp++] = q - W; }
        if (y < H - 1 && sat[q + W] === kind && !seen[q + W]) { seen[q + W] = 1; stack[sp++] = q + W; }
      }
      const bw = maxx - minx + 1;
      const bh = maxy - miny + 1;
      // 面积/外接框/填充率三道筛：点半径约 14~16px（面积≈600~800），
      // 网格残留是几像素的小块，描边圆环（如果有）填充率只有 0.2 左右
      if (area < 60) continue;
      if (bw < 10 || bh < 10) continue;
      if (Math.abs(bw - bh) > Math.max(bw, bh) * 0.35) continue; // 圆：外接框近正方形
      if (area / (bw * bh) < 0.5) continue; // 实心圆填充率≈0.78
      const kindName = kind === 1 ? 'start' : kind === 2 ? 'end' : 'num';
      blobs.push({
        kind: kindName,
        area,
        cx: sx / area,
        cy: sy / area,
        r: Math.sqrt(area / Math.PI),
        minx,
        miny,
        maxx,
        maxy,
        col: [cr / area, cg / area, cb / area],
      });
    }

    if (!blobs.length) return { dots: [], why: 'no-blobs' };

    // 每个数字点取内部白字
    const dots = [];
    for (const blob of blobs) {
      const kind = blob.kind;
      let text = '';
      let score = null;
      if (kind === 'num') {
        // 圆形内 0.72r 的白像素（再往外就是点自己的紫色描边过渡）
        const x0 = Math.max(0, Math.floor(blob.cx - blob.r));
        const x1 = Math.min(W - 1, Math.ceil(blob.cx + blob.r));
        const y0 = Math.max(0, Math.floor(blob.cy - blob.r));
        const y1 = Math.min(H - 1, Math.ceil(blob.cy + blob.r));
        const pts = [];
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const dx = x + 0.5 - blob.cx;
            const dy = y + 0.5 - blob.cy;
            if (dx * dx + dy * dy > (blob.r * 0.72) ** 2) continue;
            const p = (y * W + x) * 4;
            if (Math.min(data[p], data[p + 1], data[p + 2]) > 200) pts.push([x, y]);
          }
        }
        // 「1」在 13px 下只有十几个白像素，阈值不能高；低于 8 个就当没字
        if (pts.length < 8) {
          text = '';
        } else {
          let gx0 = 1e9;
          let gy0 = 1e9;
          let gx1 = -1;
          let gy1 = -1;
          for (const [x, y] of pts) {
            if (x < gx0) gx0 = x;
            if (x > gx1) gx1 = x;
            if (y < gy0) gy0 = y;
            if (y > gy1) gy1 = y;
          }
          const gw = gx1 - gx0 + 1;
          const gh = gy1 - gy0 + 1;
          const mask = new Float32Array(gw * gh);
          for (const [x, y] of pts) mask[(y - gy0) * gw + (x - gx0)] = 1;
          const res = classifyDigit(mask, gw, gh);
          text = res.text;
          score = Math.round(res.score * 100) / 100;
        }
      }
      dots.push({
        x: blob.cx,
        y: blob.cy,
        r: blob.r,
        text: kind === 'start' ? '起' : kind === 'end' ? '终' : text,
        fill: `rgb(${blob.col.map(Math.round).join(',')})`,
        score,
        src: 'pixel',
      });
    }
    return { dots, why: 'ok' };
  }

  // ───────────────────────── 数字：模板匹配（不依赖 OCR 库） ─────────────────────────
  // 从真实弹窗截图量出来的 1/2/3（12x16，'#'=墨）。它比渲染模板更接近线上笔画，
  // 但要和运行时字形走同一套口径才有意义：先裁墨迹外接框、再面积平均拉到 12×16（见 fromRows）。
  // 4~9 只可能来自运行时渲染。
  const RAW_TEMPLATES = {
    1: ['.....##.....', '...####.....', '.######.....', '#######.....', '#######.....', '#...###.....', '....###.....', '....###.....', '....###.....', '....###.....', '....###.....', '....###.....', '....###.....', '....###.....', '....###.....', '....###.....'],
    2: ['..#####.....', '.######.....', '###..###....', '###...##....', '##....##....', '##....##....', '......##....', '......#.....', '.....#......', '....##......', '...##.......', '..##........', '.###........', '.####.......', '########....', '########....'],
    3: ['..####......', '.######.....', '.######.....', '.##..###....', '.#...##.....', '.....##.....', '....##......', '....##......', '......##....', '......##....', '##....##....', '###...##....', '###...##....', '.#######....', '.#######....', '..#####.....'],
  };

  // 硬模板必须先归一化再进模板表：实测字符网格（12×16）里带空边，而实测字形走的是
  // 「裁 bbox 再拉满 12×16」。直接按原网格比对，同一个「1」自己跟自己只有 -0.14 的余弦，
  // 等于硬模板全废 —— 复核时这条是真的会翻车，不是洁癖。
  const fromRows = (rows) => {
    const pts = [];
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) if (rows[y][x] === '#') pts.push([x, y]);
    return pts.length ? normalize(pts, TW, TH) : null;
  };

  // 每个数字留多个候选模板：截图硬模板 + 运行时用几套常见字体渲染的。
  // 为什么不用单模板：组件一旦换字体/换字号（Arial ↔ 苹方、13px ↔ 18px），
  // 单模板的余弦会整体掉到 0.4 以下，题目直接认不出来；多模板取最高分就稳了。
  const FONT_STACKS = [
    'bold 40px system-ui',
    'bold 40px Arial',
    'bold 40px "Microsoft YaHei"',
    'bold 40px "PingFang SC"',
    'bold 40px "Helvetica Neue"',
    'bold 40px sans-serif',
  ];

  let TPL = null;
  // 造模板期间关掉记录（见 buildTemplates 里的说明）
  let NO_RECORD = false;

  function buildTemplates() {
    const out = new Map();
    for (const [key, rows] of Object.entries(RAW_TEMPLATES)) {
      const tpl = fromRows(rows);
      if (tpl) out.set(key, [tpl]);
    }
    // 运行时渲染模板造不出来（没有 document / 拿不到 2d context）就只剩硬模板 1/2/3，
    // 4 以上认不出 —— 这时 classifyDigit 会返回低分并让 order() 的一致性校验拦下，
    // 结果是「放弃自动求解、转人工」，而不是乱点。不要因此抛错把整条核验链打断。
    let cx = null;
    try {
      const cv = document.createElement('canvas');
      cv.width = 64;
      cv.height = 64;
      cx = cv.getContext('2d', { willReadFrequently: true });
    } catch (_) {}
    if (!cx) return out;
    // 造模板用的是同一个 CanvasRenderingContext2D，不挡一下会被自己装的钩子记进
    // HOOK_STORE（54 个数字 × 6 套字体），把平台真实的绘制往 2500 条裁剪线外挤。
    NO_RECORD = true;
    try {
      for (const digit of '123456789') {
        const list = out.get(digit) || [];
        for (const font of FONT_STACKS) {
          try {
            cx.clearRect(0, 0, 64, 64);
            cx.font = font;
            cx.fillStyle = '#fff';
            cx.textBaseline = 'middle';
            cx.fillText(digit, 14, 32);
          } catch (_) {
            continue;
          }
          const im = cx.getImageData(0, 0, 64, 64).data;
          const pts = [];
          for (let y = 0; y < 64; y++) {
            for (let x = 0; x < 64; x++) if (im[(y * 64 + x) * 4 + 3] > 128) pts.push([x, y]);
          }
          if (pts.length < 30) continue;
          list.push(normalize(pts, 64, 64));
        }
        if (list.length) out.set(digit, list);
      }
    } finally {
      NO_RECORD = false;
    }
    return out;
  }

  function templates() {
    if (!TPL) TPL = buildTemplates();
    return TPL;
  }

  // 归一化到 12x16：先按墨迹外接框裁掉留白，再用面积平均降采样。
  // 面积平均而不是最近邻：13px 的字降到 12x16 是缩放比例不到 1 的情况，
  // 最近邻会随机丢笔画，「1」的竖笔会整根消失。
  function normalize(pts, srcW, srcH) {
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1;
    let y1 = -1;
    for (const [x, y] of pts) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const gw = x1 - x0 + 1;
    const gh = y1 - y0 + 1;
    const src = new Float32Array(gw * gh);
    for (const [x, y] of pts) src[(y - y0) * gw + (x - x0)] = 1;
    const out = new Float32Array(TW * TH);
    for (let y = 0; y < TH; y++) {
      for (let x = 0; x < TW; x++) {
        const sx0 = (x / TW) * gw;
        const sx1 = ((x + 1) / TW) * gw;
        const sy0 = (y / TH) * gh;
        const sy1 = ((y + 1) / TH) * gh;
        let sum = 0;
        let cnt = 0;
        for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
          for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
            if (sx < 0 || sy < 0 || sx >= gw || sy >= gh) continue;
            sum += src[sy * gw + sx];
            cnt++;
          }
        }
        out[y * TW + x] = cnt ? sum / cnt : 0;
      }
    }
    return out;
  }

  // 去均值余弦：先减各自均值，抵消「笔画粗细/抗锯齿灰度」带来的整体偏置，
  // 剩下的形状相似度才可比。全零模板（空图）返回 -1，不会被误当成最佳匹配。
  function cosine(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    let ma = 0;
    let mb = 0;
    for (let i = 0; i < a.length; i++) {
      ma += a[i];
      mb += b[i];
    }
    ma /= a.length;
    mb /= b.length;
    for (let i = 0; i < a.length; i++) {
      const u = a[i] - ma;
      const v = b[i] - mb;
      dot += u * v;
      na += u * u;
      nb += v * v;
    }
    return na && nb ? dot / Math.sqrt(na * nb) : -1;
  }

  function classifyDigit(mask, gw, gh) {
    const pts = [];
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (mask[y * gw + x] > 0.5) pts.push([x, y]);
    if (!pts.length) return { text: '', score: -2 };
    const grid = normalize(pts, gw, gh);
    let best = '';
    let bestScore = -2;
    for (const [digit, cands] of templates()) {
      for (const tpl of cands) {
        const s = cosine(grid, tpl);
        if (s > bestScore) {
          bestScore = s;
          best = digit;
        }
      }
    }
    // 0.4 是「像不像一个数字」的下限。低于它就当没认出来（text=''），
    // 让 order() 的 1..N 排列校验去否决整题，而不是拿一个错数字去拖。
    return { text: bestScore > 0.4 ? best : '', score: bestScore };
  }

  // ───────────────────────── 排序 + 轨迹 + 派发 ─────────────────────────
  const isStart = t => /^(起|始|开始)$/.test(t);
  const isEnd = t => /^(终|结束|完成)$/.test(t);

  // 关键闸门：起点/终点各一个，数字必须是 1..N 的严格排列。
  // 只要少一个数字、或者出现 1,2,4，说明识别错了 —— 返回 null，宁可不解。
  function order(dots) {
    const start = dots.filter(d => isStart(d.text));
    const end = dots.filter(d => isEnd(d.text));
    const nums = dots.filter(d => /^[1-9]$/.test(d.text)).sort((a, b) => +a.text - +b.text);
    if (start.length !== 1 || end.length !== 1 || !nums.length) return null;
    for (let i = 0; i < nums.length; i++) if (+nums[i].text !== i + 1) return null;
    return [start[0], ...nums, end[0]];
  }

  const cubicPoint = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
  };

  // 两点之间不画直线：真人拖鼠标走的是带弧度的曲线，而且起步快、落点慢（缓出）。
  // 直线 + 匀速是最好判的机器特征，所以每条边都随机偏一点，弯曲方向也随机。
  function segPath(from, to) {
    const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const bend = (Math.random() < 0.5 ? -1 : 1) * Math.min(26, Math.max(4, len * rnd(0.1, 0.22)));
    const nx = -(to.y - from.y) / len;
    const ny = (to.x - from.x) / len;
    const c1 = { x: from.x + (to.x - from.x) * 0.25 + nx * bend, y: from.y + (to.y - from.y) * 0.25 + ny * bend };
    const c2 = { x: from.x + (to.x - from.x) * 0.75 + nx * bend * 0.55, y: from.y + (to.y - from.y) * 0.75 + ny * bend * 0.55 };
    // 步长 2.2~4.2px：太稀像跳帧，太密是脚本能跑多快拖多快的特征
    const steps = Math.max(7, Math.round(len / rnd(2.2, 4.2)));
    const pts = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const eased = 1 - Math.pow(1 - t, rnd(1.8, 2.6));
      const p = cubicPoint(from, c1, c2, to, eased);
      // 每点 0.6px 抖动：手抖是连续的，但采样点上看起来就是噪声
      pts.push({ x: p.x + rnd(-0.6, 0.6), y: p.y + rnd(-0.6, 0.6) });
    }
    return { pts, len };
  }

  // 事件发送器：坐标是画布内坐标，事件要的是视口坐标，所以按
  // rect.left + px * rect.width / canvas.width 映射（宽高各算一次，不假设等比）。
  // 合成的 pointerdown 带着 pointerId=1，但它不是浏览器认定的活动指针，
  // canvas.setPointerCapture(1) 会抛 NotFoundError。组件把这一步和「手势开始」
  // 的初始化写在同一个表达式里，抛了就等于整段手势没开始（详见 solve() 的注释）。
  // 这里只在拖动期间把这几个方法换成空实现，拖完立刻还原，不动组件其它逻辑。
  function mutePointerCapture(canvas) {
    const saved = {
      set: canvas.setPointerCapture,
      release: canvas.releasePointerCapture,
      has: canvas.hasPointerCapture,
    };
    try {
      canvas.setPointerCapture = () => {};
      canvas.releasePointerCapture = () => {};
      canvas.hasPointerCapture = () => true;
    } catch (_) {}
    return () => {
      try {
        if (saved.set) canvas.setPointerCapture = saved.set;
        if (saved.release) canvas.releasePointerCapture = saved.release;
        if (saved.has) canvas.hasPointerCapture = saved.has;
      } catch (_) {}
    };
  }

  function makeFirer(canvas) {    const doc = canvas.ownerDocument || document;
    const view = doc.defaultView || (typeof window !== 'undefined' ? window : globalThis);
    const rect = canvas.getBoundingClientRect();
    const kx = rect.width / canvas.width;
    const ky = rect.height / canvas.height;
    const toClient = p => ({ x: rect.left + p.x * kx, y: rect.top + p.y * ky });
    const fire = (type, p, extra = {}) => {
      const c = toClient(p);
      const base = {
        bubbles: true,
        cancelable: true,
        // composed:true 是这里的命门：canvas 在 shadow root 里，
        // 不设它事件就到不了 document，组件挂在 document 上的监听收不到
        composed: true,
        view,
        clientX: c.x,
        clientY: c.y,
        screenX: c.x,
        screenY: c.y,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      };
      let ev;
      if (type.startsWith('pointer') && view.PointerEvent) {
        ev = new view.PointerEvent(type, {
          ...base,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          width: 1,
          height: 1,
          button: type === 'pointermove' ? -1 : 0,
          buttons: extra.buttons ?? (type === 'pointerup' ? 0 : 1),
          pressure: extra.pressure ?? (type === 'pointerup' ? 0 : 0.5),
        });
      } else {
        // 有些环境没有 PointerEvent，退回 mouse 系列（事件类型要跟着改，否则 new MouseEvent('pointerdown') 也发得出去但没人认）
        const mType = type.startsWith('pointer') ? type.replace('pointer', 'mouse') : type;
        ev = new view.MouseEvent(mType, {
          ...base,
          button: 0,
          buttons: extra.buttons ?? (mType === 'mouseup' ? 0 : 1),
          detail: mType === 'mousemove' ? 0 : 1,
        });
      }
      // 关键：派发到 canvas 本身（shadow DOM 内），composed:true 让它照常冒到 document
      canvas.dispatchEvent(ev);
    };
    return { fire, rect, toClient };
  }

  // 一次完整拖动：悬停 → 按下 → 每个点停顿 → 松开。
  // canvas 这个参数只为签名对称（坐标都在 fire 的闭包里），留着是为了以后要按画布尺寸调时序时不用改调用点。
  async function performTrace(canvas, path, cfg, fire) {
    const first = path[0];
    fire('pointerover', first, { buttons: 0 });
    fire('pointermove', first, { buttons: 0 });
    fire('mousemove', first, { buttons: 0 });
    // 停在起点上再按：真实人手不会 hover 和 down 同时发生
    await sleep(ri(cfg.pressDelay[0], cfg.pressDelay[1]));
    fire('pointerdown', first, { buttons: 1, pressure: 0.6 });
    fire('mousedown', first, { buttons: 1 });
    await sleep(ri(60, 180));
    // 按下后原地微抖 2~4 次：按下瞬间手指/鼠标必然有位移
    for (let i = 0; i < ri(2, 4); i++) {
      fire('pointermove', { x: first.x + rnd(-1.2, 1.2), y: first.y + rnd(-1.2, 1.2) }, { buttons: 1 });
      fire('mousemove', { x: first.x + rnd(-1.2, 1.2), y: first.y + rnd(-1.2, 1.2) }, { buttons: 1 });
      await sleep(ri(12, 34));
    }
    for (let s = 1; s < path.length; s++) {
      const { pts, len } = segPath(path[s - 1], path[s]);
      // 长边走得快一点、短边慢一点：等价于「速度大致恒定」，也是人手特征。
      // 下限 2ms 是 setTimeout 的有效粒度，再小浏览器也会按 2~4ms 给
      const gap = Math.min(20, Math.max(4, cfg.speedFactor * 900 / Math.max(60, len)));
      for (const p of pts) {
        fire('pointermove', p, { buttons: 1 });
        fire('mousemove', p, { buttons: 1 });
        await sleep(Math.max(2, Math.round(gap + rnd(-2, 2))));
      }
      // 落点停顿：到每个数字点都要「看清了再走」，停顿长度随机
      await sleep(ri(cfg.dwell[0], cfg.dwell[1]));
      for (let i = 0; i < ri(1, 3); i++) {
        const p = { x: path[s].x + rnd(-1.4, 1.4), y: path[s].y + rnd(-1.4, 1.4) };
        fire('pointermove', p, { buttons: 1 });
        fire('mousemove', p, { buttons: 1 });
        await sleep(ri(10, 26));
      }
    }
    // 终点停顿后再松手：松手太快会被判成「拖过但没确认」
    const last = path[path.length - 1];
    await sleep(ri(cfg.releaseDelay[0], cfg.releaseDelay[1]));
    fire('pointerup', last, { buttons: 0, pressure: 0 });
    fire('mouseup', last, { buttons: 0 });
  }

  // 调试遮罩：把识别到的顺序画在 canvas 上方，肉眼确认后再真拖。
  // 只读不改，pointer-events:none，4 秒自动消失；给排查「认错了」时用，生产默认也开，
  // 因为它不影响事件派发，而误判时是唯一能一眼看出问题在哪的线索。
  function drawPreview(canvas, path) {
    const doc = canvas.ownerDocument || document;
    if (!doc?.body) return null;
    const rect = canvas.getBoundingClientRect();
    const kx = rect.width / canvas.width;
    const ky = rect.height / canvas.height;
    let box = doc.getElementById('__risk_preview');
    if (box) box.remove();
    box = doc.createElement('div');
    box.id = '__risk_preview';
    box.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;pointer-events:none;z-index:2147483647`;
    box.innerHTML = path.map((d, i) => {
      const x = d.x * kx;
      const y = d.y * ky;
      return `<i style="position:absolute;left:${x - 11}px;top:${y - 11}px;width:22px;height:22px;border:2px solid #ff2d55;border-radius:50%;font:11px/20px monospace;color:#ff2d55;text-align:center;background:#fff8">${i}</i>`;
    }).join('') + `<svg width="${rect.width}" height="${rect.height}" style="position:absolute;left:0;top:0"><polyline points="${path.map(d => `${d.x * kx},${d.y * ky}`).join(' ')}" fill="none" stroke="#ff2d55" stroke-width="1.5" stroke-dasharray="4 3"/></svg>`;
    doc.body.appendChild(box);
    setTimeout(() => box.remove(), 4000);
    return box;
  }

  function create(options = {}) {
    const cfg = {
      // 日志默认打到面板；调用方可以换成自己的收集器（自测就是靠这个把过程取出来比对）
      log: typeof options.log === 'function' ? options.log : defaultLog,
      pressDelay: options.pressDelay || [140, 380],
      dwell: options.dwell || [45, 140],
      releaseDelay: options.releaseDelay || [90, 240],
      speedFactor: options.speedFactor ?? 1,
      retryGap: options.retryGap || [1600, 3200],
      tries: options.tries ?? 2,
      // 像素路径强制：钩子不可用时的默认行为，也是排查 Tier A 是否说谎的开关
      pixelOnly: options.pixelOnly ?? false,
      // 调试遮罩默认开。注意它只画在 canvas 上方、不吃事件，不影响派发
      preview: options.preview !== false,
    };
    // 所有实例共用模块级单例：组件只画一次，各持一份记录没有意义
    const store = HOOK_STORE;

    // 返回值永远是同一个形状（五个键都在），调用方不用猜「没找到 canvas 时有没有 dots」
    function recognize() {
      const canvas = findCanvas();
      if (!canvas) return { canvas: null, path: null, src: null, dots: [], why: 'no-canvas' };
      if (!isVisible(canvas)) return { canvas, path: null, src: null, dots: [], why: 'invisible' };

      // 钩子路径优先：它拿到的是组件自己画的原话，不存在识别误差
      if (!cfg.pixelOnly && store.hooked) {
        const dots = dotsFromHooks(canvas, store.ops);
        const path = order(dots);
        if (path) return { canvas, path, src: 'hook', dots, why: 'ok' };
      }
      const { dots, why } = dotsFromPixels(canvas);
      return { canvas, path: order(dots), src: 'pixel', dots, why };
    }

    // 带 (canvas, path) 参数时直接画那两个；不带参数时自己认一遍再画。
    // 后者是给「只想看一眼识别结果」的调用方用的：preview() 不需要真的拖。
    function preview(canvas, path) {
      if (canvas && path) return drawPreview(canvas, path);
      const r = recognize();
      if (!r.canvas || !r.path) return null;
      return drawPreview(r.canvas, r.path);
    }

    async function solve() {
      const r = recognize();
      if (!r.canvas) {
        cfg.log('没找到核验 canvas');
        return 'not-found';
      }
      // 画布尺寸为 0 说明组件还没布局完，等下一轮比现在拖更靠谱
      if (!r.canvas.width) return 'not-found';
      if (!r.path) {
        cfg.log(`取点失败（${r.why}）：${JSON.stringify((r.dots || []).map(d => ({ t: d.text, x: Math.round(d.x), y: Math.round(d.y) })))}`);
        return 'recognize-failed';
      }
      cfg.log(`核验取点[${r.src}]：` + r.path.map(d => `${d.text}(${Math.round(d.x)},${Math.round(d.y)})`).join(' → '));
      if (cfg.preview) drawPreview(r.canvas, r.path);
      const { fire } = makeFirer(r.canvas);
      // 平台组件在 pointerdown 里会调 canvas.setPointerCapture(e.pointerId)。
      // 合成事件的 pointerId 不是真实活动指针，这个调用直接抛 NotFoundError，
      // 而它在 `setPointerCapture?.(); v = {…手势状态…}` 这同一个逗号表达式里 ——
      // 一抛就跳过整段手势初始化，后面的 pointermove/pointerup 全被组件忽略：
      // 表现就是「明明画了线，平台当没画，弹窗还在」。
      const restoreCapture = mutePointerCapture(r.canvas);
      // 动手前停一下：从「识别完」到「开始拖」零延迟本身就不是人
      await sleep(ri(180, 460));
      try {
        await performTrace(r.canvas, r.path, cfg, fire);
      } finally {
        restoreCapture();
      }
      // 20×120ms ≈ 2.4 秒：组件校验/关闭弹窗一般在这之前完成。
      // 判「过了」的依据是核验区消失（不依赖平台的具体文案，文案改过一次）
      for (let i = 0; i < 20; i++) {
        await sleep(120);
        if (!isVisible(findCanvas())) {
          cfg.log('核验已通过');
          return 'passed';
        }
      }
      cfg.log('核验未通过（弹窗仍在）：事件进了组件却仍被判成机器，或坐标映射失效');
      return 'failed';
    }

    // 重试只重试「拖了但没过」；取点失败/没找到直接返回，重试也是同样结果，白等一轮
    async function auto(opts = {}) {
      const n = Math.max(1, Number(opts.tries ?? cfg.tries) || 1);
      for (let i = 1; i <= n; i++) {
        const result = await solve();
        if (result === 'passed') return 'passed';
        if (result !== 'failed') return result;
        if (i < n) await sleep(ri(cfg.retryGap[0], cfg.retryGap[1]));
      }
      return 'failed';
    }

    return {
      installHooks: () => installHooks(store),
      recognize,
      preview,
      solve,
      auto,
      isVisible: () => isVisible(findCanvas()),
      _store: store,
      _cfg: cfg,
    };
  }

  Y.RiskChallenge = {
    create,
    findCanvas,
    isPresent,
    isVisible,
    installHooks,
    // 给 human-check 复用：核验可能在顶层，也可能在作业 iframe 里
    documents: reachableDocuments,
  };

  // document-start 就把钩子装好：本脚本 @run-at document-start，早于页面脚本执行，
  // 此刻 CanvasRenderingContext2D 已经存在，而核验组件还没画第一帧；
  // 等 create() 再装就晚了 —— 第一帧漏掉，题目只能退回像素路径（能解，但白丢了最准的那条路）。
  // 失败不抛错：装不上就 store.hooked=false，recognize() 自动走 Tier B。
  try {
    Y.RiskChallenge.installHooks();
  } catch (_) {}
})(Y);
