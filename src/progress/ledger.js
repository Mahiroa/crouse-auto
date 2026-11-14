((Y) => {
  // 平台进度契约与观看区间算术

  // ---- 平台进度接口（3.4.0 新增，3.5.0 增加观看日志 /video-log/detail/）----
  // 为什么不再只靠页面判断：
  //  1) ai-workspace 侧栏的完成态是三态且只有图形：100% 是一个对勾图标
  //     （icon-yuanquangou-mianzhuang）、部分完成是一个纯 CSS 圆环（.status-pie --p:79，没有文字）、
  //     未开始是空节点。旧实现扫「已完成」文字和 icon-finish 类名，在真机上 0/131 命中；
  //  2) 视频更麻烦：播放器播到结尾 ≠ 平台记账 100%。抓包里 last_point 已经 1173.8（≥ video_length 1173.0），
  //     平台却只记 rate=0.7765（rate = watch_length / video_length = 910.8 / 1173），继续看 60 秒才升到 0.8363。
  //     至于为什么记账会少（倍速折价？心跳批次被判 "Partial data anomaly" 后只部分入账？）抓包不足以定因，
  //     所以脚本不猜原因，只按「查平台实际 rate、差多少补多少」处理。
  // 所以完成判定改成「以平台进度为准，DOM 只用来导航」；接口不可用时整体退回 DOM 三态。
  const LEAF_KIND = { 0: 'video', 3: 'graph', 4: 'forum', 6: 'exercise' };

  // ---- 视频观看日志的区间算术 ----
  // 平台自己的「视频观看日志」弹窗（/video-log/detail/ 的 heartbeat.result）给的是
  // **已观看区间的并集**，不是「看到哪儿了」。抓包实证（docs/视频观看日志-取证.md）：
  //   result:[{s:0,e:644},{s:650,e:752},{s:822,e:1175}], video_length:1173
  //   → rate = (644+102+353)/1173 = 0.9369，与接口返回的 rate 完全对上。
  // 也就是说 rate 是「覆盖率」，跳过去的、没播的都在 result 之外 —— 那些区间就是
  // 前端弹窗里灰色标成「未观看」的部分，也是唯一值得补播的部分。
  const VideoLedger = {
    // 小于这个长度的洞是采样误差（heartbeat 大约每 5 秒一条），补不动也不值得补
    MIN_GAP: 1.5,
    // 收尾留一点余量：区间右端可能比 video_length 多出 1~2 秒（抓包里 e=1175 而时长 1173）
    _round(value) {
      return Math.round(Number(value) * 10) / 10;
    },
    // 把接口给的 result 规整成「升序、互不相接、都落在 [0, length] 内」的区间表
    normalize(raw, length) {
      const end = Number(length) > 0 ? Number(length) : 0;
      const list = [];
      for (const item of Array.isArray(raw) ? raw : []) {
        if (!item) continue;
        let s = Number(item.s);
        let e = Number(item.e);
        if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
        if (e < s) { const swap = s; s = e; e = swap; }
        if (s < 0) s = 0;
        if (end > 0) {
          if (s > end) continue;
          e = Math.min(e, end);
        }
        if (e - s <= 0.05) continue;
        list.push({ s, e });
      }
      list.sort((a, b) => a.s - b.s);
      const merged = [];
      for (const current of list) {
        const last = merged[merged.length - 1];
        if (last && current.s <= last.e + 0.5) {
          if (current.e > last.e) last.e = current.e;
        } else {
          merged.push({ s: current.s, e: current.e });
        }
      }
      return merged;
    },
    // 区间表的补集 = 没看过的段。空区间表 + 有长度 ⇒ 整段没看过，返回 [{0, length}]。
    gaps(intervals, length, minGap = this.MIN_GAP) {
      const end = Number(length) > 0 ? Number(length) : 0;
      const covered = Array.isArray(intervals) ? intervals : [];
      const out = [];
      let cursor = 0;
      for (const item of covered) {
        if (!item) continue;
        if (item.s - cursor >= minGap) out.push({ s: cursor, e: item.s });
        if (item.e > cursor) cursor = item.e;
      }
      if (end - cursor >= minGap) out.push({ s: cursor, e: end });
      return out;
    },
    seconds(list) {
      let total = 0;
      for (const item of Array.isArray(list) ? list : []) {
        const delta = Number(item?.e) - Number(item?.s);
        if (Number.isFinite(delta) && delta > 0) total += delta;
      }
      return Math.round(total * 10) / 10;
    },
    // 秒数 → 00:12 / 1:02:03，面板里读起来比裸秒亲切
    mark(seconds) {
      const value = Math.max(0, Math.round(Number(seconds) || 0));
      const h = Math.floor(value / 3600);
      const m = Math.floor((value % 3600) / 60);
      const s = value % 60;
      const pad = n => String(n).padStart(2, '0');
      return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    },
    // 面板里一行说清「哪几段没看」，最多列 6 段，剩下用「等 N 段」收口
    describe(list, limit = 6) {
      const items = Array.isArray(list) ? list : [];
      const words = items.slice(0, limit).map(item => `${this.mark(item.s)}-${this.mark(item.e)}`);
      if (items.length > limit) words.push(`等 ${items.length} 段`);
      return words.join('、');
    }
  };

  Y.LEAF_KIND = LEAF_KIND;
  Y.VideoLedger = VideoLedger;
})(Y);
