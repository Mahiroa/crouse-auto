((Y) => {
  // 面板静态模板（HTML/CSS）

  const PanelMarkup = version => `
      <style>
        :root {
          --brand: #2f6fed;
          --brand-strong: #1d4ed8;
          --brand-soft: #eef4ff;
          --ink: #1a2233;
          --ink-2: #334155;
          --muted: #6b7890;
          --line: #e3e9f2;
          --line-soft: #eef2f8;
          --bg: #f4f6fb;
          --ok: #15803d;
          --warn: #b45309;
          --danger: #b91c1c;
          --radius: 12px;
        }
        * { box-sizing: border-box; }
        html, body {
          height: 100%;
          margin: 0;
          padding: 0;
          overflow: hidden;
          background: transparent;
          color: var(--ink);
          font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", Avenir, Helvetica, Arial, sans-serif;
          font-size: 13px;
          -webkit-font-smoothing: antialiased;
        }
        button, input, select, summary { font-family: inherit; }
        button { border: 0; }
        button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible {
          outline: 2px solid rgba(47, 111, 237, 0.45);
          outline-offset: 1px;
        }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-thumb { background: #d5deea; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #c2cddd; }
        ::-webkit-scrollbar-track { background: transparent; }

        /* 最小化气泡 */
        .mini-basic {
          position: absolute;
          inset: 0;
          display: none;
          align-items: center;
          justify-content: center;
          border-radius: 16px;
          background: linear-gradient(135deg, #4d86ff, #2556c9);
          color: #fff;
          cursor: pointer;
          box-shadow: 0 12px 28px rgba(37, 86, 201, 0.42);
          user-select: none;
        }
        .mini-basic.show { display: flex; }
        .mini-basic:hover { filter: brightness(1.06); }
        .mini-logo { font-size: 21px; font-weight: 700; letter-spacing: 1px; }
        .mini-dot {
          position: absolute;
          right: 9px;
          bottom: 9px;
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: #cbd5e1;
          box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35);
        }
        .mini-dot.running { background: #fde68a; }
        .mini-dot.done { background: #86efac; }
        .mini-dot.error { background: #fca5a5; }

        /* 面板骨架 */
        .panel {
          position: relative;
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
          overflow: hidden;
          border-radius: 16px;
          background: var(--bg);
        }
        .header {
          flex: none;
          height: 48px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 0 10px 0 12px;
          background: #fff;
          border-bottom: 1px solid var(--line);
          cursor: move;
          user-select: none;
        }
        .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .logo {
          flex: none;
          width: 28px;
          height: 28px;
          border-radius: 9px;
          display: grid;
          place-items: center;
          background: linear-gradient(135deg, #4d86ff, #2556c9);
          color: #fff;
          font-size: 13px;
          font-weight: 700;
          box-shadow: 0 4px 10px rgba(37, 86, 201, 0.28);
        }
        .brand-text { min-width: 0; line-height: 1.2; }
        .title { display: flex; align-items: center; gap: 5px; font-size: 13px; font-weight: 650; color: var(--ink); white-space: nowrap; }
        .version {
          font-size: 9px;
          font-weight: 600;
          color: #8b98ad;
          background: #f1f5f9;
          border-radius: 4px;
          padding: 1px 4px;
        }
        .brand-sub { font-size: 10px; color: #94a3b8; margin-top: 1px; white-space: nowrap; }
        .header-actions { display: flex; align-items: center; gap: 4px; flex: none; }
        .badge {
          font-size: 10px;
          font-weight: 650;
          line-height: 1;
          padding: 4px 7px;
          border-radius: 999px;
          color: #64748b;
          background: #f1f5f9;
          white-space: nowrap;
        }
        .badge.running { color: #1d4ed8; background: #e8f0ff; }
        .badge.done { color: var(--ok); background: #e8f8ef; }
        .badge.error { color: var(--danger); background: #fef2f2; }
        .icon-btn {
          width: 28px;
          height: 28px;
          display: grid;
          place-items: center;
          border-radius: 8px;
          background: transparent;
          color: #64748b;
          font-size: 17px;
          line-height: 1;
          cursor: pointer;
        }
        .icon-btn:hover { background: #eef2f7; color: var(--ink); }

        /* 主体 */
        .body {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 10px;
          overflow: hidden;
        }
        .status-card {
          flex: none;
          padding: 9px 11px 10px;
          border: 1px solid var(--line);
          border-radius: var(--radius);
          background: #fff;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
        }
        .status-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .status-label { font-size: 10px; font-weight: 600; color: #94a3b8; letter-spacing: 0.06em; }
        .status-count { font-size: 10px; color: #8b98ad; background: #f4f7fb; border-radius: 999px; padding: 2px 7px; }
        .status-main {
          margin-top: 3px;
          font-size: 15px;
          font-weight: 650;
          line-height: 1.3;
          color: var(--ink);
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .status-sub {
          margin-top: 2px;
          font-size: 11px;
          line-height: 16px;
          color: #7b8aa0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .quick-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
        .chip {
          height: 24px;
          padding: 0 9px;
          border: 1px solid #dfe7f2;
          border-radius: 7px;
          background: #f8fafd;
          color: #52627a;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
        }
        .chip:hover { border-color: #bcd0f5; background: #f0f5ff; color: var(--brand-strong); }
        .chip.on { border-color: #bcd0f5; background: var(--brand-soft); color: var(--brand-strong); }

        .timeline-wrap {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          padding: 8px 10px 6px;
          border: 1px solid var(--line);
          border-radius: var(--radius);
          background: #fff;
        }
        .section-label {
          flex: none;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 0 1px 6px;
          font-size: 10px;
          font-weight: 600;
          color: #94a3b8;
          letter-spacing: 0.06em;
        }
        .section-hint { font-weight: 400; color: #b6c1d0; letter-spacing: 0; }
        .timeline { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
        .step { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 6px; margin-bottom: 6px; }
        .step:last-child { margin-bottom: 0; }
        .step-rail { position: relative; }
        .step-rail::before {
          content: "";
          position: absolute;
          left: 5px;
          top: 14px;
          bottom: -8px;
          width: 1.5px;
          background: #e6ecf5;
        }
        .step:last-child .step-rail::before { display: none; }
        .step-dot {
          width: 10px;
          height: 10px;
          margin-top: 4px;
          border-radius: 50%;
          background: #94a3b8;
          box-shadow: 0 0 0 3px #eef2f7;
          position: relative;
          z-index: 1;
        }
        .step.doing .step-dot { background: var(--brand); box-shadow: 0 0 0 3px #e2ecff; }
        .step.done .step-dot { background: var(--ok); box-shadow: 0 0 0 3px #e6f7ee; }
        .step.skip .step-dot { background: #cbd5e1; box-shadow: 0 0 0 3px #f1f5f9; }
        .step-card { min-width: 0; padding: 5px 8px; border: 1px solid var(--line-soft); border-radius: 8px; background: #fcfdff; }
        .step-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
        .step-title { min-width: 0; font-size: 12px; font-weight: 600; color: var(--ink-2); line-height: 1.4; }
        .step-name { word-break: break-all; }
        .step-kind { display: inline-block; margin-right: 5px; padding: 0 4px; border-radius: 4px; background: var(--brand-soft); color: var(--brand-strong); font-size: 9px; font-weight: 600; line-height: 14px; vertical-align: 1px; }
        .step.done .step-kind { background: #e8f8ef; color: var(--ok); }
        .step.skip .step-kind { background: #f1f5f9; color: #64748b; }
        .step-state { flex: none; font-size: 9px; color: #9aa8bb; }
        .step-detail {
          margin-top: 3px;
          max-height: 64px;
          overflow: auto;
          color: #64748b;
          font-size: 11px;
          line-height: 15px;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .empty-trail {
          height: 100%;
          min-height: 70px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 8px;
          color: #a2aec0;
          font-size: 11.5px;
          line-height: 1.7;
          text-align: center;
        }
        .empty-icon { font-size: 19px; line-height: 1; opacity: 0.55; margin-bottom: 3px; }

        .runlog {
          flex: none;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: #fff;
          padding: 0 10px;
        }
        .runlog > summary {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          height: 28px;
          list-style: none;
          color: #7b8aa0;
          font-size: 10px;
          font-weight: 600;
          cursor: pointer;
          letter-spacing: 0.04em;
        }
        .runlog > summary::-webkit-details-marker { display: none; }
        .runlog > summary::before {
          content: "▸";
          margin-right: 2px;
          color: #b6c1d0;
          font-size: 9px;
          transition: transform 0.15s ease;
        }
        .runlog[open] > summary::before { transform: rotate(90deg); }
        .runlog > summary > span:first-child { flex: 1; }
        .log-count { color: #b6c1d0; font-weight: 500; }
        .info {
          margin: 0 0 6px;
          padding: 0;
          max-height: 112px;
          overflow-y: auto;
          list-style: none;
        }
        .info li { margin: 0 0 3px; color: #64748b; font-size: 10.5px; line-height: 15px; word-break: break-word; }
        .info li:last-child { margin-bottom: 0; }
        .info li.log-warn { color: var(--warn); }
        .info li.log-error { color: var(--danger); }

        /* 底部操作栏 */
        .footer {
          flex: none;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 10px;
          background: #fff;
          border-top: 1px solid var(--line);
        }
        .btn {
          height: 34px;
          padding: 0 12px;
          border-radius: 9px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          white-space: nowrap;
          transition: filter 0.15s ease, background 0.15s ease, color 0.15s ease;
        }
        .btn:disabled { opacity: 0.55; cursor: not-allowed; }
        .btn.primary {
          flex: 1;
          min-width: 0;
          color: #fff;
          background: linear-gradient(180deg, #3b7bf6, #2f6fed);
          box-shadow: 0 4px 10px rgba(47, 111, 237, 0.28);
        }
        .btn.primary:hover { filter: brightness(1.06); }
        .btn.primary.running {
          background: linear-gradient(180deg, #f59e0b, #d97706);
          box-shadow: 0 4px 10px rgba(217, 119, 6, 0.26);
        }
        .btn.ghost { background: #f2f6fc; color: #415a7a; }
        .btn.ghost:hover { background: #e8f0fb; color: var(--brand-strong); }
        .btn.text { background: transparent; color: #8b98ad; font-weight: 500; }
        .btn.text:hover { color: var(--ink-2); }
        .more { position: relative; }
        .more > summary { list-style: none; }
        .more > summary::-webkit-details-marker { display: none; }
        .menu {
          position: absolute;
          right: 0;
          bottom: calc(100% + 6px);
          z-index: 50;
          min-width: 150px;
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 4px;
          border: 1px solid var(--line);
          border-radius: 10px;
          background: #fff;
          box-shadow: 0 12px 30px rgba(15, 23, 42, 0.16);
        }
        .menu button {
          padding: 7px 9px;
          border-radius: 7px;
          background: transparent;
          color: var(--ink-2);
          font-size: 11.5px;
          text-align: left;
          cursor: pointer;
        }
        .menu button:hover { background: #f3f7fc; color: var(--brand-strong); }

        /* 缩放手柄 */
        .resize-handle {
          position: absolute;
          right: 2px;
          bottom: 2px;
          z-index: 25;
          width: 14px;
          height: 14px;
          border-radius: 4px;
          cursor: nwse-resize;
          background: linear-gradient(135deg, transparent 0 52%, #cbd5e1 52% 60%, transparent 60% 70%, #cbd5e1 70% 78%, transparent 78%);
          opacity: 0.9;
        }
        .resize-handle:hover { opacity: 1; background: linear-gradient(135deg, transparent 0 52%, #94a3b8 52% 60%, transparent 60% 70%, #94a3b8 70% 78%, transparent 78%); }

        /* 设置页 */
        #settings {
          position: absolute;
          inset: 0;
          z-index: 30;
          display: none;
          flex-direction: column;
          background: var(--bg);
        }
        .settings-head {
          flex: none;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          height: 50px;
          padding: 0 10px 0 14px;
          background: #fff;
          border-bottom: 1px solid var(--line);
        }
        .settings-title { font-size: 14px; font-weight: 650; color: var(--ink); line-height: 1.2; }
        .settings-desc { margin-top: 2px; font-size: 10px; color: #94a3b8; }
        .settings-tabs {
          flex: none;
          display: flex;
          gap: 4px;
          padding: 6px 12px 0;
          background: #fff;
          border-bottom: 1px solid var(--line);
        }
        .settings-tabs .tab {
          flex: 1;
          height: 28px;
          padding: 0 8px;
          border-radius: 8px 8px 0 0;
          border-bottom: 2px solid transparent;
          background: transparent;
          color: #7b8aa0;
          font-size: 11.5px;
          font-weight: 600;
          cursor: pointer;
        }
        .settings-tabs .tab:hover { background: #f7faff; color: var(--brand-strong); }
        .settings-tabs .tab.active {
          color: var(--brand-strong);
          border-bottom-color: var(--brand);
          background: #f7faff;
        }
        .settings-scroll {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          gap: 0;
          padding: 8px 12px 12px;
          overflow-y: auto;
        }
        .tab-pane { display: flex; flex-direction: column; gap: 9px; }
        .tab-pane[hidden] { display: none; }
        .card {
          flex: none;
          padding: 10px 12px;
          border: 1px solid var(--line);
          border-radius: var(--radius);
          background: #fff;
        }
        .card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .card-title { font-size: 12.5px; font-weight: 650; color: var(--ink); }
        .tag { flex: none; padding: 2px 6px; border-radius: 999px; background: #f1f5f9; color: #8b98ad; font-size: 9px; font-weight: 600; }
        .hint { margin: 4px 0 7px; color: #94a3b8; font-size: 10.5px; line-height: 15px; }
        .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; margin-bottom: 8px; }
        .field:last-child { margin-bottom: 0; }
        .field-label { color: #7b8aa0; font-size: 10.5px; font-weight: 500; }
        .field input, .field select {
          width: 100%;
          height: 32px;
          padding: 0 9px;
          border: 1px solid #dbe3ee;
          border-radius: 8px;
          background: #fff;
          color: var(--ink);
          font-size: 12px;
        }
        .field input:focus, .field select:focus {
          border-color: var(--brand);
          box-shadow: 0 0 0 3px rgba(47, 111, 237, 0.12);
          outline: none;
        }
        .field input::placeholder { color: #b6c1d0; }
        .grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; align-items: end; margin-bottom: 8px; }
        .grid2 .field { margin-bottom: 0; }
        .key-row { display: flex; align-items: center; gap: 6px; }
        .key-row input { flex: 1; min-width: 0; }
        .key-toggle {
          flex: none;
          height: 32px;
          padding: 0 9px;
          border: 1px solid #dbe3ee;
          border-radius: 8px;
          background: #f8fafd;
          color: #7b8aa0;
          font-size: 10.5px;
          cursor: pointer;
        }
        .key-toggle:hover { border-color: #bcd0f5; color: var(--brand-strong); }
        .switch-row {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 30px;
          margin-bottom: 1px;
          cursor: pointer;
          user-select: none;
        }
        .switch-row input { position: absolute; opacity: 0; pointer-events: none; }
        .switch {
          flex: none;
          position: relative;
          width: 34px;
          height: 20px;
          border-radius: 999px;
          background: #d9e1ec;
          transition: background 0.16s ease;
        }
        .switch::after {
          content: "";
          position: absolute;
          top: 2px;
          left: 2px;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 1px 3px rgba(15, 23, 42, 0.22);
          transition: transform 0.16s ease;
        }
        .switch-row input:checked + .switch { background: var(--brand); }
        .switch-row input:checked + .switch::after { transform: translateX(14px); }
        .switch-text { color: var(--ink-2); font-size: 11.5px; line-height: 1.35; }
        .choice-stack { display: flex; flex-direction: column; gap: 6px; }
        .choice {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 7px 9px;
          border: 1px solid var(--line);
          border-radius: 9px;
          background: #fbfcfe;
          cursor: pointer;
        }
        .choice:hover { border-color: #c6d6f0; }
        .choice input { flex: none; margin: 2px 0 0; accent-color: var(--brand); }
        .choice > span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .choice b { color: var(--ink-2); font-size: 11.5px; font-weight: 600; }
        .choice small { color: #94a3b8; font-size: 10px; line-height: 14px; }
        .choice:has(input:checked) {
          border-color: var(--brand);
          background: var(--brand-soft);
          box-shadow: 0 0 0 1px rgba(47, 111, 237, 0.14);
        }
        .test-result { min-height: 15px; margin-top: 7px; color: #94a3b8; font-size: 10.5px; line-height: 15px; word-break: break-all; }
        .test-result.ok { color: var(--ok); }
        .test-result.bad { color: var(--danger); }
        .about { padding: 2px 0 4px; color: #b6c1d0; font-size: 9.5px; text-align: center; }
        .note {
          margin: 1px 0 0;
          padding: 8px 10px;
          border: 1px dashed #cfe0fb;
          border-radius: 9px;
          background: #f7faff;
          color: #7b8aa0;
          font-size: 10.5px;
          line-height: 16px;
        }
        .settings-footer {
          flex: none;
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 7px 12px;
          background: #fff;
          border-top: 1px solid var(--line);
        }
        .settings-footer .btn.primary { flex: 1; }
        .settings-footer .btn { height: 33px; }

        /* 刷完：彩带 + 结论弹窗 */
        .celebrate {
          position: absolute;
          inset: 0;
          z-index: 60;
          display: none;
          align-items: center;
          justify-content: center;
          padding: 18px;
          pointer-events: none;
        }
        .celebrate.show { display: flex; }
        .celebrate-mask {
          position: absolute;
          inset: 0;
          background: rgba(15, 23, 42, 0.26);
          opacity: 0;
          transition: opacity 0.2s ease;
          pointer-events: auto;
        }
        .celebrate.show .celebrate-mask { opacity: 1; }
        .confetti { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
        .confetti-piece {
          position: absolute;
          top: -8%;
          display: block;
          width: 6px;
          height: 10px;
          border-radius: 2px;
          opacity: 0.95;
          animation-name: confetti-fall;
          animation-timing-function: cubic-bezier(0.25, 0.7, 0.4, 1);
          animation-iteration-count: 1;
          animation-fill-mode: both;
          will-change: top, transform, opacity;
        }
        /* 用 top 的百分比下落（相对面板高度），不要用 translateY(%)：
           百分比位移是相对**碎片自己的高度**算的，10px 高的碎片只会挪 12px，看上去像没撒下来 */
        @keyframes confetti-fall {
          0% { top: -8%; transform: translateX(0) rotate(0deg); opacity: 1; }
          100% { top: 104%; transform: translateX(16px) rotate(var(--spin, 240deg)); opacity: 0.85; }
        }
        .celebrate-card {
          position: relative;
          pointer-events: auto;
          width: 100%;
          max-width: 316px;
          padding: 16px 16px 13px;
          border-radius: 14px;
          background: #fff;
          box-shadow: 0 18px 44px rgba(15, 23, 42, 0.3);
          text-align: center;
          animation: celebrate-pop 0.3s cubic-bezier(0.2, 0.9, 0.3, 1.15) both;
        }
        @keyframes celebrate-pop {
          0% { transform: scale(0.86) translateY(10px); opacity: 0; }
          100% { transform: scale(1) translateY(0); opacity: 1; }
        }
        .celebrate-emoji { font-size: 30px; line-height: 1.1; }
        .celebrate-title { margin-top: 4px; font-size: 17px; font-weight: 700; line-height: 1.3; color: var(--ink); }
        .celebrate-desc { margin-top: 6px; font-size: 11.5px; line-height: 17px; color: var(--muted); }
        .celebrate-desc[hidden] { display: none; }
        .celebrate-list {
          margin-top: 9px;
          padding: 8px 9px;
          border: 1px dashed #cfe0fb;
          border-radius: 9px;
          background: #f7faff;
          text-align: left;
        }
        .celebrate-list[hidden] { display: none; }
        .celebrate-item { display: flex; align-items: flex-start; gap: 6px; color: #52627a; font-size: 11px; line-height: 16px; }
        .celebrate-item + .celebrate-item { margin-top: 4px; }
        .celebrate-item .dot { flex: none; width: 5px; height: 5px; margin-top: 6px; border-radius: 50%; background: var(--brand); }
        .celebrate-actions { margin-top: 13px; display: flex; justify-content: center; }
        .celebrate-actions .btn { min-width: 132px; }
        @media (prefers-reduced-motion: reduce) {
          .confetti { display: none; }
          .celebrate-card { animation: none; }
        }
      </style>

      <div class="mini-basic" id="mini-basic" title="展开刷课助手" role="button" aria-label="展开刷课助手">
        <span class="mini-logo">雨</span>
        <span class="mini-dot" id="mini-dot"></span>
      </div>

      <div class="panel" id="panel">
        <header class="header" id="header">
          <div class="brand">
            <span class="logo">雨</span>
            <div class="brand-text">
              <div class="title">刷课助手<span class="version">v${version}</span></div>
              <div class="brand-sub">雨课堂 · 自动播放</div>
            </div>
          </div>
          <div class="header-actions">
            <span class="badge" id="run-badge">待机</span>
            <button class="icon-btn" id="minimality" type="button" title="最小化" aria-label="最小化">−</button>
          </div>
        </header>

        <main class="body">
          <section class="status-card">
            <div class="status-top">
              <span class="status-label">当前进度</span>
              <span class="status-count" id="trail-count">0 项</span>
            </div>
            <div class="status-main" id="trail-current">等待开始</div>
            <div class="status-sub" id="trail-sub">点击「开始刷课」，脚本会自动接管播放器</div>
            <div class="quick-row">
              <button class="chip" id="quick-speed" type="button" title="点击切换播放倍速">2×</button>
              <button class="chip" id="quick-mute" type="button" title="点击切换静音">静音开</button>
              <button class="chip" id="quick-fast" type="button" title="点击切换快速模式">快速关</button>
            </div>
          </section>

          <section class="timeline-wrap">
            <div class="section-label"><span>刷课轨迹</span><span class="section-hint">最近 60 项</span></div>
            <div class="timeline" id="timeline"></div>
          </section>

          <details class="runlog" id="runlog">
            <summary><span>运行日志</span><span class="log-count" id="log-count">0</span></summary>
            <ul class="info" id="info"></ul>
          </details>
        </main>

        <footer class="footer">
          <button class="btn primary" id="btn-start" type="button">开始刷课</button>
          <button class="btn ghost" id="btn-stop" type="button" title="停止刷课并刷新">停止</button>
          <button class="btn ghost" id="btn-setting" type="button" title="打开设置">设置</button>
          <details class="more" id="more">
            <summary class="btn ghost" title="更多操作">更多</summary>
            <div class="menu">
              <button id="btn-clear" type="button">清除进度缓存</button>
              <button id="btn-reload" type="button">重新加载并继续</button>
            </div>
          </details>
        </footer>

        <div class="resize-handle" id="resize-handle" title="拖动调整窗口大小"></div>

        <div class="celebrate" id="celebrate" aria-hidden="true">
          <div class="celebrate-mask" id="celebrate-mask"></div>
          <div class="confetti" id="confetti" aria-hidden="true"></div>
          <div class="celebrate-card" role="dialog" aria-modal="true" aria-labelledby="celebrate-title">
            <div class="celebrate-emoji">🎉</div>
            <div class="celebrate-title" id="celebrate-title">本课程已刷完</div>
            <div class="celebrate-desc" id="celebrate-desc" hidden></div>
            <div class="celebrate-list" id="celebrate-list" hidden></div>
            <div class="celebrate-actions">
              <button class="btn primary" id="celebrate-ok" type="button">太棒了</button>
            </div>
          </div>
        </div>

        <div id="settings" aria-label="设置">
          <div class="settings-head">
            <div>
              <div class="settings-title">设置</div>
              <div class="settings-desc">AI 答题、播放与防验证策略</div>
            </div>
            <button class="icon-btn" id="close_settings_top" type="button" title="关闭设置" aria-label="关闭设置">×</button>
          </div>

          <div class="settings-tabs" id="settings-tabs">
            <button class="tab active" data-tab="ai" type="button">AI 接口</button>
            <button class="tab" data-tab="run" type="button">播放与行为</button>
          </div>

          <div class="settings-scroll">
            <div class="tab-pane" data-pane="ai">
            <section class="card">
              <div class="card-head">
                <div class="card-title">DeepSeek 接口</div>
                <span class="tag">答题 · 识题 · 讨论</span>
              </div>
              <p class="hint">答题、截图识题和讨论回复共用这一份配置。截图识题需要支持图片输入的模型。</p>
              <label class="field">
                <span class="field-label">API 地址</span>
                <input type="text" id="ai_url" placeholder="https://api.deepseek.com/chat/completions" spellcheck="false">
              </label>
              <label class="field">
                <span class="field-label">API Key</span>
                <span class="key-row">
                  <input type="password" id="ai_key" placeholder="sk-xxxxxxxx" spellcheck="false">
                  <button class="key-toggle" id="toggle_key" type="button">显示</button>
                </span>
              </label>
              <div class="grid2">
                <label class="field">
                  <span class="field-label">模型</span>
                  <input type="text" id="ai_model" placeholder="deepseek-flash" spellcheck="false">
                </label>
                <label class="field">
                  <span class="field-label">接口格式</span>
                  <select id="ai_format">
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </label>
              </div>
              <label class="field">
                <span class="field-label">认证方式</span>
                <select id="auth_method">
                  <option value="bearer">Bearer Token</option>
                  <option value="x-api-key">X-API-Key</option>
                </select>
              </label>
              <div class="grid2">
                <label class="field">
                  <span class="field-label">思考档位</span>
                  <select id="ai_thinking">
                    <option value="off">Off（不思考，最快）</option>
                    <option value="low">Low（推荐）</option>
                    <option value="high">High（更准，慢）</option>
                    <option value="max">Max（最慢）</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">自定义 UA</span>
                  <input type="text" id="ai_ua" placeholder="Yuketang Course Helper" spellcheck="false">
                </label>
              </div>
              <p class="hint">答题只需要一行答案：<b>Off / Low</b> 明显更快；档位越高模型想得越久。自定义 UA 只作用于模型请求，方便在网关侧区分请求来源。</p>
              <div id="ai_test_result" class="test-result" role="status"></div>
            </section>
            <p class="note">配置只保存在本机浏览器；答题前可以先点「测试连接」。切换分页不会丢失未保存的修改，记得点「保存并关闭」。</p>
            </div>

            <div class="tab-pane" data-pane="run" hidden>
            <section class="card">
              <div class="card-head"><div class="card-title">播放</div><span class="tag">立即生效</span></div>
              <div class="grid2">
                <label class="field">
                  <span class="field-label">倍速（0.25–4）</span>
                  <input type="number" id="playback_rate" min="0.25" max="4" step="0.25" placeholder="2">
                </label>
                <label class="switch-row">
                  <input type="checkbox" id="playback_muted">
                  <span class="switch"></span>
                  <span class="switch-text">自动静音</span>
                </label>
              </div>
            </section>

            <section class="card">
              <div class="card-title">人机验证</div>
              <p class="hint">检测到安全核验时怎么处理。默认跳过当前章节。</p>
              <div class="choice-stack">
                <label class="choice">
                  <input type="radio" name="human_check_mode" value="skip">
                  <span><b>跳过当前章节</b><small>直接进入下一节，不中断整门课</small></span>
                </label>
                <label class="choice">
                  <input type="radio" name="human_check_mode" value="wait">
                  <span><b>停下等待</b><small>手动完成验证后自动继续</small></span>
                </label>
                <label class="choice">
                  <input type="radio" name="human_check_mode" value="auto">
                  <span><b>自动过核验（实验）</b><small>脚本自己解轨迹核验；没解过会自动转人工等待</small></span>
                </label>
              </div>
            </section>

            <section class="card">
              <div class="card-title">功能开关</div>
              <label class="switch-row">
                <input type="checkbox" id="feature_auto_ai">
                <span class="switch"></span>
                <span class="switch-text">自动作答作业和题目</span>
              </label>
              <label class="switch-row">
                <input type="checkbox" id="feature_auto_comment">
                <span class="switch"></span>
                <span class="switch-text">图文 / 讨论自动回复</span>
              </label>
              <label class="switch-row">
                <input type="checkbox" id="feature_fast_mode">
                <span class="switch"></span>
                <span class="switch-text">快速模式（跳过读题和点击等待）</span>
              </label>
            </section>

            <div class="about">雨课堂刷课助手 v${version} · 重构版 · 作者 Mark</div>
            </div>
          </div>

          <div class="settings-footer">
            <button class="btn ghost" id="test_settings" type="button">测试连接</button>
            <button class="btn primary" id="save_settings" type="button">保存并关闭</button>
            <button class="btn text" id="close_settings" type="button">取消</button>
          </div>
        </div>
      </div>
    `;

  Y.PanelMarkup = PanelMarkup;
})(Y);
