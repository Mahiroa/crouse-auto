((Y) => {
  // 面板实例状态与交互（createPanel）

  // UI 面板实例后置初始化
  Y.panel = undefined;

  // ---- UI 面板 ----
  function createPanel() {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.top = '20px';
    iframe.style.left = '20px';
    iframe.style.width = '400px';
    iframe.style.height = '560px';
    iframe.style.zIndex = '2147483647';
    iframe.style.border = '0';
    iframe.style.borderRadius = '16px';
    iframe.style.background = '#fff';
    iframe.style.overflow = 'hidden';
    iframe.style.boxShadow = '0 18px 46px rgba(15, 23, 42, 0.26)';
    iframe.style.colorScheme = 'light';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('id', 'ykt-helper-iframe');
    iframe.setAttribute('allowtransparency', 'true');
    const mountTarget = document.body || document.documentElement;
    if (!mountTarget) {
      throw new Error('面板挂载点不存在');
    }
    mountTarget.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(Y.PanelMarkup(Y.Config.version));
    doc.close();

    const ui = {
      iframe,
      doc,
      panel: doc.getElementById('panel'),
      header: doc.getElementById('header'),
      info: doc.getElementById('info'),
      timeline: doc.getElementById('timeline'),
      trailCurrent: doc.getElementById('trail-current'),
      trailSub: doc.getElementById('trail-sub'),
      trailCount: doc.getElementById('trail-count'),
      btnStart: doc.getElementById('btn-start'),
      btnClear: doc.getElementById('btn-clear'),
      btnSetting: doc.getElementById('btn-setting'),
      btnStop: doc.getElementById('btn-stop'),
      btnReload: doc.getElementById('btn-reload'),
      settings: doc.getElementById('settings'),
      saveSettings: doc.getElementById('save_settings'),
      testSettings: doc.getElementById('test_settings'),
      aiTestResult: doc.getElementById('ai_test_result'),
      closeSettings: doc.getElementById('close_settings'),
      closeSettingsTop: doc.getElementById('close_settings_top'),
      aiUrlInput: doc.getElementById('ai_url'),
      aiKeyInput: doc.getElementById('ai_key'),
      aiModelInput: doc.getElementById('ai_model'),
      aiFormatSelect: doc.getElementById('ai_format'),
      authMethodSelect: doc.getElementById('auth_method'),
      toggleKey: doc.getElementById('toggle_key'),
      featureAutoAI: doc.getElementById('feature_auto_ai'),
      featureAutoComment: doc.getElementById('feature_auto_comment'),
      featureFastMode: doc.getElementById('feature_fast_mode'),
      playbackRateInput: doc.getElementById('playback_rate'),
      playbackMutedInput: doc.getElementById('playback_muted'),
      minimality: doc.getElementById('minimality'),
      miniBasic: doc.getElementById('mini-basic'),
      miniDot: doc.getElementById('mini-dot'),
      runBadge: doc.getElementById('run-badge'),
      quickSpeed: doc.getElementById('quick-speed'),
      quickMute: doc.getElementById('quick-mute'),
      quickFast: doc.getElementById('quick-fast'),
      logCount: doc.getElementById('log-count'),
      runlog: doc.getElementById('runlog'),
      more: doc.getElementById('more'),
      resizeHandle: doc.getElementById('resize-handle'),
      celebrateBox: doc.getElementById('celebrate'),
      celebrateMask: doc.getElementById('celebrate-mask'),
      celebrateTitle: doc.getElementById('celebrate-title'),
      celebrateDesc: doc.getElementById('celebrate-desc'),
      celebrateList: doc.getElementById('celebrate-list'),
      celebrateOk: doc.getElementById('celebrate-ok'),
      confetti: doc.getElementById('confetti')
    };

    // ---- 窗口位置 / 尺寸 / 最小化 ----
    const hostWindow = window.parent || window;
    const hostDocument = hostWindow.document;
    const MIN_SIZE = { width: 340, height: 430 };
    const MAX_SIZE = { width: 720, height: 900 };
    const viewport = () => ({
      width: Math.max(296, hostWindow.innerWidth || hostDocument.documentElement?.clientWidth || 1024),
      height: Math.max(360, hostWindow.innerHeight || hostDocument.documentElement?.clientHeight || 720)
    });
    const clampRect = raw => {
      const vp = viewport();
      const width = Math.min(Math.max(Number(raw?.width) || 400, MIN_SIZE.width), Math.max(MIN_SIZE.width, Math.min(MAX_SIZE.width, vp.width - 8)));
      const height = Math.min(Math.max(Number(raw?.height) || 560, MIN_SIZE.height), Math.max(MIN_SIZE.height, Math.min(MAX_SIZE.height, vp.height - 8)));
      const left = Math.min(Math.max(Number(raw?.left) || 0, 8), Math.max(8, vp.width - width - 8));
      const top = Math.min(Math.max(Number(raw?.top) || 0, 8), Math.max(8, vp.height - height - 8));
      return { left, top, width, height };
    };
    const readRect = () => Y.Utils.safeJSONParse(Y.storeSafe.get(Y.Config.storageKeys.panelRect), null);
    const saveRect = rect => {
      try {
        localStorage.setItem(Y.Config.storageKeys.panelRect, JSON.stringify(rect));
      } catch (_) {}
    };
    let rect = { left: 20, top: 20, width: 400, height: 560 };
    const applyRect = (next, persist = true) => {
      rect = clampRect(next);
      iframe.style.left = rect.left + 'px';
      iframe.style.top = rect.top + 'px';
      iframe.style.width = rect.width + 'px';
      iframe.style.height = rect.height + 'px';
      if (persist) saveRect(rect);
    };
    const defaultRect = () => {
      const vp = viewport();
      return { left: Math.max(8, vp.width - 420), top: 20, width: 400, height: 560 };
    };
    applyRect(readRect() || defaultRect(), false);

    let isMinimized = false;
    const enterMini = () => {
      if (isMinimized) return;
      isMinimized = true;
      saveRect(rect);
      ui.panel.style.display = 'none';
      ui.miniBasic.classList.add('show');
      iframe.style.width = '58px';
      iframe.style.height = '58px';
      iframe.style.left = Math.min(rect.left, viewport().width - 66) + 'px';
      iframe.style.top = Math.min(rect.top, viewport().height - 66) + 'px';
    };
    const exitMini = () => {
      if (!isMinimized) return;
      isMinimized = false;
      ui.miniBasic.classList.remove('show');
      ui.panel.style.display = '';
      applyRect(rect, false);
    };
    ui.minimality.addEventListener('click', event => {
      event.stopPropagation();
      enterMini();
    });
    ui.miniBasic.addEventListener('click', exitMini);

    let dragging = false;
    let resizing = false;
    let dragStart = null;
    let dragOrigin = null;
    let resizeStart = null;
    let resizeOrigin = null;
    const beginDrag = event => {
      if (event.button !== 0) return;
      if (event.target.closest('button, summary, a, input, select, label')) return;
      dragging = true;
      dragStart = { x: event.screenX, y: event.screenY };
      dragOrigin = { left: rect.left, top: rect.top };
      doc.body.style.userSelect = 'none';
      event.preventDefault();
    };
    const beginResize = event => {
      if (event.button !== 0) return;
      resizing = true;
      resizeStart = { x: event.screenX, y: event.screenY };
      resizeOrigin = { width: rect.width, height: rect.height };
      doc.body.style.userSelect = 'none';
      event.preventDefault();
      event.stopPropagation();
    };
    const onMove = event => {
      if (dragging) {
        applyRect({
          ...rect,
          left: dragOrigin.left + (event.screenX - dragStart.x),
          top: dragOrigin.top + (event.screenY - dragStart.y)
        }, false);
      } else if (resizing) {
        applyRect({
          ...rect,
          width: resizeOrigin.width + (event.screenX - resizeStart.x),
          height: resizeOrigin.height + (event.screenY - resizeStart.y)
        }, false);
      }
    };
    const stopInteractions = () => {
      if (!dragging && !resizing) return;
      dragging = false;
      resizing = false;
      doc.body.style.userSelect = '';
      saveRect(rect);
    };
    ui.header.addEventListener('mousedown', beginDrag);
    ui.resizeHandle.addEventListener('mousedown', beginResize);
    doc.addEventListener('mousemove', onMove);
    hostWindow.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', stopInteractions);
    hostWindow.addEventListener('mouseup', stopInteractions);
    hostWindow.addEventListener('blur', stopInteractions);
    hostWindow.addEventListener('resize', () => {
      if (!isMinimized) applyRect(rect, true);
    });

    // ---- 状态徽标 ----
    const setBadge = (text, state = 'idle') => {
      ui.runBadge.textContent = text;
      ui.runBadge.className = 'badge ' + state;
      ui.miniDot.className = 'mini-dot ' + state;
    };

    const escapeHtml = value => String(value || '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
    const kindText = Y.KIND_LABEL;
    const stateText = { doing: '进行中', done: '已结束', skip: '已跳过' };
    const renderTrail = trail => {
      // 再防一层：getTrail 已归一，但 track/noteAnswer 里也可能拿着旧对象直接调 renderTrail。
      // 脏 ykt_trail 不能把面板初始化/刷新整个抛崩（panel 未赋值时后续所有 log/track 都会失效）。
      const safeTrail = trail && typeof trail === 'object' ? trail : {};
      const current = typeof safeTrail.currentTitle === 'string' && safeTrail.currentTitle
        ? safeTrail.currentTitle
        : '等待开始';
      ui.trailCurrent.textContent = current;
      ui.trailSub.textContent = typeof safeTrail.currentDetail === 'string' && safeTrail.currentDetail
        ? safeTrail.currentDetail
        : '点击「开始刷课」，脚本会自动接管播放器';
      const steps = Array.isArray(safeTrail.steps) ? safeTrail.steps : [];
      const doneCount = steps.filter(step => step && step.status === 'done').length;
      ui.trailCount.textContent = steps.length ? `${doneCount}/${steps.length} 项` : '0 项';
      if (!steps.length) {
        ui.timeline.innerHTML = '<div class="empty-trail"><div class="empty-icon">◷</div>还没有记录。开始刷课后，<br>课程、视频和题目会依次出现在这里。</div>';
        return;
      }
      ui.timeline.innerHTML = steps.map(rawStep => {
        const step = rawStep && typeof rawStep === 'object' ? rawStep : {};
        const state = typeof step.status === 'string' ? step.status : 'doing';
        const detail = step.detail ? `<div class="step-detail">${escapeHtml(step.detail)}</div>` : '';
        return `<div class="step ${state}">
          <div class="step-rail"><div class="step-dot"></div></div>
          <div class="step-card">
            <div class="step-head">
              <div class="step-title"><span class="step-kind">${kindText[step.kind] || '记录'}</span><span class="step-name">${escapeHtml(step.title)}</span></div>
              <div class="step-state">${stateText[state] || ''}</div>
            </div>
            ${detail}
          </div>
        </div>`;
      }).join('');
      ui.timeline.scrollTop = ui.timeline.scrollHeight;
    };
    const track = step => {
      const trail = Y.Store.getTrail();
      const steps = trail.steps || [];
      const next = {
        id: step.id,
        kind: step.kind || 'course',
        title: String(step.title || '未命名').slice(0, 80),
        detail: step.detail == null ? (steps.find(item => item.id === step.id)?.detail || '') : String(step.detail).slice(0, 500),
        status: step.status || 'doing'
      };
      const index = steps.findIndex(item => item.id === next.id);
      if (index >= 0) steps[index] = { ...steps[index], ...next };
      else steps.push(next);
      if (steps.length > 60) steps.splice(0, steps.length - 60);
      trail.steps = steps;
      if (next.status === 'doing') {
        trail.currentStepId = next.id;
        trail.currentTitle = next.title;
        trail.currentDetail = next.kind === 'question' ? '正在做题' : `${kindText[next.kind] || '内容'}进行中`;
      } else if (trail.currentStepId === next.id || (!trail.currentStepId && trail.currentTitle === next.title)) {
        trail.currentTitle = next.status === 'done' ? `${next.title} 已结束` : next.title;
        trail.currentDetail = next.detail || trail.currentDetail;
      }
      Y.Store.saveTrail(trail);
      renderTrail(trail);
    };
    const showQuestion = text => {
      const body = String(text || '').trim().slice(0, 800);
      const trail = Y.Store.getTrail();
      const steps = trail.steps || [];
      const current = [...steps].reverse().find(item => item.kind === 'question' && item.status === 'doing')
        || [...steps].reverse().find(item => item.kind === 'question');
      if (current) {
        current.detail = body;
        trail.currentTitle = current.title;
        trail.currentDetail = '请核对下面复述的题目';
      }
      Y.Store.saveTrail(trail);
      renderTrail(trail);
      ui.runlog.open = true;
      log('模型复述的题目：');
      log(body);
    };
    const noteAnswer = answer => {
      const trail = Y.Store.getTrail();
      const steps = trail.steps || [];
      const current = [...steps].reverse().find(item => item.kind === 'question' && item.status === 'doing')
        || [...steps].reverse().find(item => item.kind === 'question');
      if (!current) return;
      const choice = `选择：${answer}`;
      current.detail = current.detail && !current.detail.includes(choice) ? `${current.detail}\n${choice}` : (current.detail || choice);
      current.status = 'done';
      trail.currentDetail = choice;
      Y.Store.saveTrail(trail);
      renderTrail(trail);
    };
    renderTrail(Y.Store.getTrail());

    // ---- 日志（DOM 上限 200 条，长时间刷课不会越积越卡） ----
    const appendLog = (message, kind) => {
      const li = doc.createElement('li');
      li.innerText = String(message ?? '');
      if (kind === 'warn') li.className = 'log-warn';
      if (kind === 'error') li.className = 'log-error';
      ui.info.appendChild(li);
      while (ui.info.children.length > 200) ui.info.firstElementChild.remove();
      ui.logCount.textContent = String(ui.info.children.length);
      ui.info.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
    };
    const log = message => appendLog(message, 'log');
    const warn = message => appendLog('⚠️ ' + message, 'warn');
    const error = message => {
      appendLog('🚨 ' + message, 'error');
      setBadge('异常', 'error');
    };

    // ---- 设置读取 / 快捷条 ----
    const defaultAI = { url: 'https://api.deepseek.com/chat/completions', key: 'sk-xxxxxxx', model: 'deepseek-flash', apiFormat: 'openai', authMethod: 'bearer' };
    const SPEED_STEPS = [1, 1.25, 1.5, 2, 2.5, 3];
    const formatRate = rate => {
      const value = Number(rate);
      return (Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, '')) + '×';
    };
    const renderQuickChips = () => {
      const playback = Y.Store.getPlaybackConf();
      const feature = Y.Store.getFeatureConf();
      ui.quickSpeed.textContent = formatRate(playback.playbackRate);
      ui.quickMute.textContent = playback.muted ? '静音开' : '静音关';
      ui.quickMute.classList.toggle('on', playback.muted);
      ui.quickFast.textContent = feature.fastMode ? '快速开' : '快速关';
      ui.quickFast.classList.toggle('on', feature.fastMode);
      if (ui.playbackRateInput) ui.playbackRateInput.value = playback.playbackRate;
      if (ui.playbackMutedInput) ui.playbackMutedInput.checked = playback.muted;
      if (ui.featureFastMode) ui.featureFastMode.checked = feature.fastMode;
    };
    const loadAIConf = () => {
      const saved = Y.Store.getAIConf();
      ui.aiUrlInput.value = saved.url || defaultAI.url;
      ui.aiKeyInput.value = saved.key || defaultAI.key;
      ui.aiModelInput.value = saved.model || defaultAI.model;
      ui.aiFormatSelect.value = saved.apiFormat || defaultAI.apiFormat;
      ui.authMethodSelect.value = saved.authMethod || defaultAI.authMethod;
    };
    const loadFeatureConf = () => {
      const saved = Y.Store.getFeatureConf();
      ui.featureAutoAI.checked = saved.autoAI;
      ui.featureAutoComment.checked = saved.autoComment;
      // 三态回填：skip / wait / auto，脏值一律落到 skip（与 Store.getFeatureConf 的归一化一致）
      const savedHumanMode = saved.humanCheckMode;
      const humanMode = savedHumanMode === 'wait' || savedHumanMode === 'auto' ? savedHumanMode : 'skip';
      const humanPicked = doc.querySelector(`input[name="human_check_mode"][value="${humanMode}"]`);
      if (humanPicked) humanPicked.checked = true;
      renderQuickChips();
    };
    const loadPlaybackConf = () => {
      const saved = Y.Store.getPlaybackConf();
      Y.Config.playbackRate = saved.playbackRate;
      if (ui.playbackRateInput) ui.playbackRateInput.value = saved.playbackRate;
      if (ui.playbackMutedInput) ui.playbackMutedInput.checked = saved.muted;
      renderQuickChips();
    };
    loadAIConf();
    loadFeatureConf();
    loadPlaybackConf();

    const settingsScroll = doc.querySelector('.settings-scroll');
    const settingsTabButtons = [...doc.querySelectorAll('#settings-tabs .tab')];
    const settingsTabPanes = [...doc.querySelectorAll('#settings .tab-pane')];
    const selectSettingsTab = name => {
      for (const button of settingsTabButtons) {
        const active = button.dataset.tab === name;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      for (const pane of settingsTabPanes) pane.hidden = pane.dataset.pane !== name;
      // 「测试连接」只属于 AI 接口页，切到播放/行为页时收起来
      ui.testSettings.style.display = name === 'ai' ? '' : 'none';
      if (settingsScroll) settingsScroll.scrollTop = 0;
    };
    for (const button of settingsTabButtons) {
      button.addEventListener('click', () => selectSettingsTab(button.dataset.tab));
    }
    selectSettingsTab('ai');
    const openSettings = () => {
      loadAIConf();
      loadFeatureConf();
      loadPlaybackConf();
      ui.settings.style.display = 'flex';
      if (settingsScroll) settingsScroll.scrollTop = 0;
      ui.aiTestResult.textContent = '';
      ui.aiTestResult.className = 'test-result';
    };
    const closeSettings = () => {
      ui.settings.style.display = 'none';
    };
    ui.btnSetting.onclick = openSettings;
    ui.closeSettings.onclick = closeSettings;
    ui.closeSettingsTop.onclick = closeSettings;
    doc.addEventListener('keydown', event => {
      if (event.key === 'Escape' && ui.settings.style.display !== 'none') closeSettings();
    });

    ui.quickSpeed.addEventListener('click', () => {
      const current = Y.Store.getPlaybackConf();
      const index = SPEED_STEPS.findIndex(value => Math.abs(value - current.playbackRate) < 0.01);
      const next = SPEED_STEPS[(index + 1 + SPEED_STEPS.length) % SPEED_STEPS.length];
      try {
        Y.Store.setPlaybackConf({ playbackRate: next, muted: current.muted });
        Y.Player.applyToAll();
        renderQuickChips();
        log(`播放倍速已切换为 ${formatRate(next)}`);
      } catch (err) {
        warn(`倍速切换失败：${err.message || err}`);
      }
    });
    ui.quickMute.addEventListener('click', () => {
      const current = Y.Store.getPlaybackConf();
      try {
        Y.Store.setPlaybackConf({ playbackRate: current.playbackRate, muted: !current.muted });
        Y.Player.applyToAll();
        renderQuickChips();
        log(`自动静音已${current.muted ? '关闭' : '开启'}`);
      } catch (err) {
        warn(`静音切换失败：${err.message || err}`);
      }
    });
    ui.quickFast.addEventListener('click', () => {
      const feature = Y.Store.getFeatureConf();
      Y.Store.setFeatureConf({ ...feature, fastMode: !feature.fastMode });
      renderQuickChips();
      log(`快速模式已${feature.fastMode ? '关闭' : '开启'}`);
    });

    const readFormAIConf = () => ({
      url: ui.aiUrlInput.value.trim(),
      key: ui.aiKeyInput.value.trim(),
      model: ui.aiModelInput.value.trim(),
      apiFormat: ui.aiFormatSelect.value,
      authMethod: ui.authMethodSelect.value
    });
    ui.toggleKey.addEventListener('click', () => {
      const visible = ui.aiKeyInput.type === 'text';
      ui.aiKeyInput.type = visible ? 'password' : 'text';
      ui.toggleKey.textContent = visible ? '显示' : '隐藏';
    });
    ui.testSettings.onclick = async () => {
      const conf = readFormAIConf();
      ui.aiTestResult.textContent = '正在测试...';
      ui.aiTestResult.className = 'test-result';
      ui.testSettings.disabled = true;
      try {
        const reply = await Y.Solver.ping(conf);
        const short = String(reply || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        ui.aiTestResult.textContent = `连接成功：${short}`;
        ui.aiTestResult.className = 'test-result ok';
        log('✅ AI 连接测试成功');
      } catch (err) {
        ui.aiTestResult.textContent = String(err);
        ui.aiTestResult.className = 'test-result bad';
        log(`AI 连接测试失败：${err}`);
      } finally {
        ui.testSettings.disabled = false;
      }
    };
    ui.saveSettings.onclick = () => {
      const conf = readFormAIConf();
      Y.Store.setAIConf(conf);
      // 三态取值：只认 auto / wait，其它（含未勾选）一律存 skip
      const pickedHumanMode = doc.querySelector('input[name="human_check_mode"]:checked')?.value;
      const featureConf = {
        autoAI: ui.featureAutoAI.checked,
        autoComment: ui.featureAutoComment.checked,
        humanCheckMode: pickedHumanMode === 'wait' || pickedHumanMode === 'auto' ? pickedHumanMode : 'skip',
        fastMode: ui.featureFastMode.checked
      };
      Y.Store.setFeatureConf(featureConf);
      let playbackText = '';
      try {
        const playbackConf = Y.Store.setPlaybackConf({
          playbackRate: ui.playbackRateInput?.value,
          muted: Boolean(ui.playbackMutedInput?.checked)
        });
        Y.Player.applyToAll();
        playbackText = `，倍速 ${formatRate(playbackConf.playbackRate)}${playbackConf.muted ? '、静音' : ''}`;
      } catch (err) {
        warn(`播放设置未保存：${err.message || err}`);
      }
      renderQuickChips();
      closeSettings();
      // 三态提示文案：与 markup 里的选项一一对应
      const humanTextMap = {
        wait: '人机验证改为停住等待',
        auto: '人机验证改为自动过核验（实验，未通过会转人工等待）'
      };
      const humanText = humanTextMap[featureConf.humanCheckMode] || '人机验证改为跳过当前章节';
      const speedText = featureConf.fastMode ? '，已开启快速模式' : '';
      log(`✅ 设置已保存，${humanText}${speedText}${playbackText}`);
    };

    ui.btnClear.onclick = () => {
      ui.more.open = false;
      const confirmed = typeof hostWindow.confirm === 'function'
        ? hostWindow.confirm('清除当前课程的刷课进度？已完成的记录也会清空。')
        : true;
      if (!confirmed) return;
      try {
        Y.Store.removeProgress(window.parent.location.href);
      } catch (_) {}
      if (location.href !== window.parent.location.href) Y.Store.removeProgress(location.href);
      Y.Store.removeProgressByClassroom(Y.Utils.getCurrentClassroomId());
      localStorage.removeItem(Y.Config.storageKeys.proClassCount);
      Y.Store.clearPendingAutoStart();
      Y.Store.clearTrail();
      renderTrail(Y.Store.getTrail());
      setBadge('待机', 'idle');
      log('已清除当前课程的刷课进度缓存');
    };

    // 停止刷课：清除自动恢复标记后刷新页面，刷新后脚本回到空闲状态（进度缓存保留）
    ui.btnStop.onclick = () => {
      Y.Store.clearPendingAutoStart();
      log('已停止刷课，页面即将刷新');
      setTimeout(() => hostWindow.location.reload(), 300);
    };

    // 重新加载：重建自动恢复标记后刷新页面，刷新后自动恢复刷课（停止后点击同样生效）
    ui.btnReload.onclick = () => {
      ui.more.open = false;
      Y.Store.setPendingAutoStart(Y.Utils.getCurrentClassroomId());
      log('正在重新加载脚本...');
      setTimeout(() => hostWindow.location.reload(), 300);
    };

    // ---- 刷完撒花 + 结论弹窗 ----
    // 用 DOM 碎片而不是 canvas：面板 iframe 的尺寸会随拖动变化，DOM 版按百分比定位天生自适应；
    // jsdom 里 canvas.getContext 会抛 “Not implemented”，撒花这种彩头不该给主链路添噪声。
    const CONFETTI_COLORS = ['#f97316', '#f43f5e', '#a855f7', '#3b82f6', '#22c55e', '#eab308', '#ec4899', '#14b8a6'];
    let confettiTimer = null;
    const clearConfetti = () => {
      if (confettiTimer) {
        clearTimeout(confettiTimer);
        confettiTimer = null;
      }
      if (ui.confetti) ui.confetti.textContent = '';
    };
    const dropConfetti = count => {
      try {
        clearConfetti();
        const layer = ui.confetti;
        if (!layer) return;
        const pieces = Number(count) > 0 ? Number(count) : 72;
        for (let i = 0; i < pieces; i++) {
          const piece = doc.createElement('span');
          piece.className = 'confetti-piece';
          piece.style.left = (Math.random() * 100).toFixed(2) + '%';
          piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
          piece.style.width = (5 + Math.random() * 5).toFixed(1) + 'px';
          piece.style.height = (8 + Math.random() * 7).toFixed(1) + 'px';
          piece.style.animationDelay = (Math.random() * 1.3).toFixed(2) + 's';
          piece.style.animationDuration = (2.1 + Math.random() * 1.9).toFixed(2) + 's';
          piece.style.setProperty('--spin', Math.round(Math.random() * 720 - 360) + 'deg');
          layer.appendChild(piece);
        }
        confettiTimer = setTimeout(clearConfetti, 6500);
      } catch (err) {
        // 撒花只是彩头，绝不能因为它让「刷完」的结论丢失
        log(`撒花动画出错（不影响结论）：${err && err.message ? err.message : err}`);
      }
    };
    const dismissCelebrate = () => {
      if (!ui.celebrateBox) return;
      ui.celebrateBox.classList.remove('show');
      ui.celebrateBox.setAttribute('aria-hidden', 'true');
      clearConfetti();
    };
    // 刷完时给用户的结论：标题 + 一句核对结果 + 需要手动完成的小节清单
    const celebrate = options => {
      try {
        const conf = options && typeof options === 'object' ? options : {};
        exitMini();
        if (!ui.celebrateBox) return;
        if (ui.celebrateTitle) ui.celebrateTitle.textContent = String(conf.title || '本课程已刷完');
        const desc = String(conf.desc || '');
        if (ui.celebrateDesc) {
          ui.celebrateDesc.textContent = desc;
          ui.celebrateDesc.hidden = !desc;
        }
        const manual = Array.isArray(conf.manual) ? conf.manual.filter(Boolean) : [];
        if (ui.celebrateList) {
          ui.celebrateList.hidden = !manual.length;
          ui.celebrateList.innerHTML = manual
            .map(item => `<div class="celebrate-item"><span class="dot"></span>${escapeHtml(item)}</div>`)
            .join('');
        }
        ui.celebrateBox.classList.add('show');
        ui.celebrateBox.setAttribute('aria-hidden', 'false');
        dropConfetti();
      } catch (err) {
        log(`刷完提示渲染失败（不影响结论）：${err && err.message ? err.message : err}`);
      }
    };
    if (ui.celebrateOk) ui.celebrateOk.addEventListener('click', dismissCelebrate);
    if (ui.celebrateMask) ui.celebrateMask.addEventListener('click', dismissCelebrate);
    doc.addEventListener('keydown', event => {
      if (event.key === 'Escape' && ui.celebrateBox.classList.contains('show')) dismissCelebrate();
    });

    let startHandler = null;
    let running = false;
    const invokeStart = () => {
      if (running) {
        log('已在刷课中，忽略重复启动');
        return;
      }
      running = true;
      setBadge('运行中', 'running');
      log('启动中...');
      ui.btnStart.innerText = '刷课中...';
      ui.btnStart.classList.add('running');
      try {
        startHandler && startHandler();
      } catch (err) {
        // start() 里有同步逻辑（读进度、构造 Runner），抛异常时不能让按钮永久卡在“刷课中...”
        running = false;
        ui.btnStart.innerText = '开始刷课';
        ui.btnStart.classList.remove('running');
        setBadge('异常', 'error');
        warn(`启动失败：${err.message || err}`);
      }
    };

    // 后面赋值给 panel
    return {
      ...ui,
      frame: iframe,   // 面板 iframe 本体：全屏跟随要直接操作它，别再按 id 去查（id 查询会抓到页面里同 id 的其它元素）
      log,
      warn,
      error,
      track,
      showQuestion,
      noteAnswer,
      celebrate,
      dismissCelebrate,
      setStartHandler(fn) {
        startHandler = fn;
        ui.btnStart.onclick = invokeStart;
      },
      start() {
        invokeStart();
      },
      resetStartButton(text = '开始刷课') {
        ui.btnStart.innerText = text;
        ui.btnStart.classList.toggle('running', text === '刷课中...');
        if (text !== '刷课中...') running = false;
        setBadge(text.includes('刷完') ? '已完成' : '待机', text.includes('刷完') ? 'done' : 'idle');
      }
    };
  }

  Y.createPanel = createPanel;
})(Y);
