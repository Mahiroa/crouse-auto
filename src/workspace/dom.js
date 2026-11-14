((Y) => {
  // 学习空间侧栏、练习与讨论 DOM

  const WorkspaceDom = {
    getActiveLeafTitle() {
      return document.querySelector('.leaf-item.is-active')?.innerText?.replace(/\s+/g, ' ').trim() || '';
    },
    getExerciseDocument() {
      const localHasExercise = document.querySelector('#app .container-body .container-problem')
        || document.querySelector('#app .container-problem')
        || document.querySelector('.container-problem');
      if (localHasExercise) return document;

      const frames = [...document.querySelectorAll('iframe')];
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument;
          if (!doc?.body) continue;
          if (
            doc.querySelector('.container-problem')
            || doc.querySelector('.subject-item')
            || doc.querySelector('.item-body')
          ) {
            return doc;
          }
        } catch (_) {
          // ignore cross-document access failures
        }
      }
      return null;
    },
    getExerciseContainer() {
      const exerciseDoc = this.getExerciseDocument();
      return exerciseDoc?.querySelector('#app .container-body .container-problem')
        || exerciseDoc?.querySelector('#app .container-problem')
        || exerciseDoc?.querySelector('.container-problem')
        || null;
    },
    getExerciseQuestionTabs(root = this.getExerciseContainer()) {
      if (!root) return [];
      const selectors = [
        '.subject-item.J_order',
        '.subject-item',
        '.problem-index-item',
        '.question-index-item',
        '[class*="subject-item"]',
        '[class*="problem-index"]',
        '[class*="question-index"]'
      ].join(',');
      const all = [...root.querySelectorAll(selectors)];
      return all.filter((el, index, arr) => {
        if (!this.isVisibleElement(el)) return false;
        if (arr.indexOf(el) !== index) return false;
        const text = this.normalizeText(el.innerText);
        return text && text.length <= 20;
      });
    },
    getExerciseQuestionBody(root = this.getExerciseContainer()) {
      if (!root) return null;
      const itemType = root.querySelector('.item-type');
      if (itemType?.parentElement && this.isVisibleElement(itemType.parentElement)) return itemType.parentElement;
      const selectors = [
        '.item-body',
        '.problem-content',
        '.question-content',
        '.problem-main',
        '.problem-body',
        '.question-body',
        '[class*="problem-content"]',
        '[class*="question-content"]',
        '[class*="problem-body"]',
        '[class*="question-body"]'
      ];
      for (const selector of selectors) {
        const match = [...root.querySelectorAll(selector)].find(el => this.isVisibleElement(el));
        if (match) return match;
      }
      return root;
    },
    forumStatus() {
      // 只认讨论区里的状态徽标。此前全页扫描会把侧栏「已完成」当成「已发言」，
      // 导致讨论直接跳过（或发送后立刻误判成功）。
      const inOutline = el => Boolean(el.closest('.nav-item-leaf-box, .leaf-item, [class*="sidebar"], [class*="catalog"], [class*="nav-list"], [class*="outline"]'));
      const read = (scope, allowDone) => {
        for (const el of scope.querySelectorAll('span, div, em, strong, p')) {
          if (!this.isVisibleElement(el) || inOutline(el)) continue;
          const text = (el.innerText || '').replace(/\s+/g, '');
          if (text === '未发言' || text === '已发言') return text;
          if (!allowDone || text !== '已完成') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.width <= 140 && rect.height > 0 && rect.height <= 48) return text;
        }
        return '';
      };
      const forum = document.querySelector('#new_discuss, .new_discuss_list, .discuss-wrap, .discuss__wrap, [class*="discuss"]');
      if (forum) {
        const local = read(forum, true);
        if (local) return local;
      }
      return read(document.body || document, true);
    },
    forumTopic() {
      const composer = this.findForumComposer();
      const composerTop = composer ? composer.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
      const inOutline = el => Boolean(el.closest('.nav-item-leaf-box, .leaf-item, [class*="leaf"], [class*="nav-item"], [class*="catalog"], [class*="catalogue"], [class*="sidebar"], [class*="outline"]'));
      const isOutlineTitle = text => /^(视频|音频|课件|图文|作业|考试|讨论)\s*[\d.]/.test(text) || (/^(视频|音频|课件)/.test(text) && text.length < 40);
      const hits = [];
      for (const el of document.querySelectorAll('p, div, section, h1, h2, h3, span')) {
        if (!this.isVisibleElement(el) || inOutline(el)) continue;
        if (el.querySelector('textarea, [contenteditable="true"]')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 280 || rect.bottom > composerTop - 4) continue;
        const text = this.normalizeText(el.innerText);
        if (text.length < 20 || text.length > 500) continue;
        if (/发表你的观点|Enter发送|未发言|已发言|讨论区|考核截止/.test(text)) continue;
        if (/\d{4}-\d{2}-\d{2}/.test(text) || isOutlineTitle(text) || !/[。！？]/.test(text)) continue;
        const sameChild = [...el.children].some(child => this.normalizeText(child.innerText) === text);
        if (sameChild) continue;
        hits.push({ text, top: rect.top });
      }
      hits.sort((a, b) => b.top - a.top);
      return hits[0]?.text || '';
    },
    findForumComposer() {
      const fields = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(el => this.isVisibleElement(el));
      const hinted = fields.find(el => /发表你的观点|观点|评论|讨论/.test(`${el.getAttribute('placeholder') || ''} ${el.getAttribute('data-placeholder') || ''} ${el.getAttribute('aria-placeholder') || ''}`));
      return hinted || fields[0] || null;
    },
    findForumSendButton(composer) {
      const hint = [...document.querySelectorAll('span, div, p')].find(el => this.isVisibleElement(el) && (el.innerText || '').includes('Enter发送'));
      const row = hint?.parentElement;
      const rowButtons = row ? [...row.querySelectorAll('button, [role="button"]')].filter(el => this.isVisibleElement(el)) : [];
      if (rowButtons.length) return rowButtons[rowButtons.length - 1];
      const scope = composer?.closest('form, section, article') || document;
      const labeled = [...scope.querySelectorAll('button, [role="button"]')].find(el => this.isVisibleElement(el) && /发送|发布/.test(el.innerText || ''));
      return labeled || null;
    },
    setFieldValue(el, text) {
      if (!el) return;
      el.focus();
      if (el.isContentEditable) {
        el.innerText = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        return;
      }
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    // 当前题的“作答状态”扫描范围：只允许题干容器，绝不回退到整份 .container-problem。
    // getExerciseQuestionBody 在找不到题干子容器时会 return root，而 root 往往是整个作业容器，
    // 里面有题号导航和其它题的状态（实测会命中别的题「已完成」→ 整份作业被跳过）。
    getAnswerStatusScope(root) {
      if (!root) return null;
      const body = this.getExerciseQuestionBody(root);
      if (!body) return null;
      if (body !== root) return body;
      const looksLikeWholeExercise = Boolean(root.matches?.('.container-problem, .container-body, #app'))
        || root.querySelectorAll('.subject-item, .problem-index-item, .question-index-item').length > 1;
      return looksLikeWholeExercise ? null : root;
    },
    isExerciseAnswered(root = this.getExerciseContainer()) {
      if (!root) return false;
      // 只认显式结果/状态文本，不再用「提交按钮 disabled」反推已作答：
      // 很多站点在**未作答**时提交按钮本来就是 disabled，原来的判定会把整道题/整份作业当成已完成。
      const scope = this.getAnswerStatusScope(root);
      if (!scope) return false;
      const statusPattern = /已完成|已作答|已提交|回答正确|回答错误|本题得分|正确答案/;
      const statusSelectors = [
        '.result',
        '.status',
        '.answer-status',
        '[class*="result"]',
        '[class*="status"]'
      ];
      for (const selector of statusSelectors) {
        const statusNode = [...scope.querySelectorAll(selector)]
          .find(el => this.isVisibleElement(el) && statusPattern.test(this.normalizeText(el.innerText)));
        if (statusNode) return true;
      }
      return false;
    },
    getExerciseActionButton(root = this.getExerciseContainer(), pattern = /提交|保存|确认|确定|下一题|下一道|下一步|完成本题/) {
      if (!root) return null;
      const selectors = 'button, .el-button, [role="button"], [class*="button"]';
      const nodes = [
        ...root.querySelectorAll(selectors),
        ...document.querySelectorAll(selectors)
      ];
      return nodes.find(el => this.isVisibleElement(el) && pattern.test(this.normalizeText(el.innerText)));
    },
    // 侧栏 / 目录 / 大纲里的元素：那里的「已完成」是目录徽标，不代表当前这一节
    inOutlineArea(element) {
      return Boolean(element?.closest?.('.nav-item-leaf-box, .leaf-item, [class*="catalog"], [class*="catalogue"], [class*="sidebar"], [class*="outline"], [class*="nav-list"]'));
    },
    isActiveLessonMarked() {
      const activeBox = [...document.querySelectorAll('.nav-item-leaf-box')]
        .find(box => box.querySelector('.is-active') || box.classList.contains('is-active'));
      const texts = [
        activeBox?.innerText || '',
        document.querySelector('.leaf-item.is-active')?.innerText || '',
        document.querySelector('.progress-wrap .text')?.innerText || ''
      ];
      if (texts.some(text => Y.Utils.isMarkedDone(text))) return true;
      const classText = [
        activeBox?.className || '',
        ...[...(activeBox?.querySelectorAll('[class]') || [])].slice(0, 40).map(el => el.className)
      ].join(' ');
      return /yiwancheng|is-finish|learned|icon-finish|status-finish/i.test(classText);
    },
    // 播放器左上角的「已完成」徽标：真机上视频播完后，平台先把这个标挂在播放器上，
    // 侧栏目录项常常要等接口同步（甚至要回目录页刷新）才变成已完成。
    // 只盯侧栏的 isActiveLessonMarked() 在这种页面上永远判不到 → 每集白等一个固定超时。
    // 判据：可见、文本就是「已完成」、像小徽标（高 ≤40 / 宽 ≤260）、不在侧栏，
    // 且要么紧贴播放器，要么在页面顶部（有的布局把徽标放在标题行）。
    isLessonDoneBadge() {
      const badgeRe = /^已完成(\s*详情)?$/;
      const video = this.getMedia();
      const videoRect = video ? video.getBoundingClientRect() : null;
      const hasVideoBox = Boolean(videoRect && videoRect.width > 0 && videoRect.height > 0);
      // 徽标就贴在播放器左上角：用相对播放器的位移判断，别用页面绝对坐标
      // （窗口尺寸/侧栏折叠都会让播放器 top 在 ~120-400px 之间浮动）
      const nearVideo = rect => {
        if (!hasVideoBox) return false;
        const dx = rect.left - videoRect.left;
        const dy = rect.top - videoRect.top;
        return dx >= -80 && dx <= 360 && dy >= -120 && dy <= 160;
      };
      // 先只在播放器/标题这类容器里找（量小、不抖页面），没有再退回全页
      const scopes = [...document.querySelectorAll('header, [class*="player"], [class*="video"], [class*="media"], [class*="lesson"], [class*="courseware"], [class*="title"], [class*="header"]')]
        .filter(el => !this.inOutlineArea(el))
        .slice(0, 60);
      const scopeList = scopes.length ? [...scopes, document] : [document];
      for (const scope of scopeList) {
        for (const el of scope.querySelectorAll('span, div, p, label, i, em, strong, b')) {
          // textContent 不触发布局，先用它筛文本；容器节点（子元素多）直接跳过，避免长文本拼接
          if (el.children.length > 3) continue;
          const text = this.normalizeText(el.textContent);
          if (!text || text.length > 6 || !badgeRe.test(text)) continue;
          // 只有“文本像徽标”的节点才做选择器检查（含播放器的容器一定不是徽标）
          if (el.children.length > 0 && el.querySelector('video, audio')) continue;
          if (this.inOutlineArea(el)) continue;
          if (!this.isVisibleElement(el)) continue;
          const rect = el.getBoundingClientRect();
          // 徽标是 20-32px 的小标签：高度上限取 40，目录行（更高）自然被排掉
          if (rect.height <= 0 || rect.height > 40 || rect.width <= 0 || rect.width > 260) continue;
          // 有播放器矩形时只认“贴在播放器左上角”的位置，避免课程级/页面头部的「已完成」抢命中；
          // 拿不到播放器矩形（音频节、播放器还没挂上）时才退回“页面顶部”这条老判据
          if (hasVideoBox ? !nearVideo(rect) : rect.top > 320) continue;
          return true;
        }
      }
      // 兜底：有的版本把角标做成图标（文字由 icon 字体/图片承担），文本判据抓不到，
      // 这时只认播放器附近带完成语义类名的小元素。仅在「已播完」之后被调用，误判风险很低。
      for (const el of document.querySelectorAll('[class*="yiwancheng"], [class*="finish"], [class*="complete"], [class*="learned"]')) {
        if (this.inOutlineArea(el)) continue;
        if (el.querySelector?.('video, audio')) continue;
        if (!this.isVisibleElement(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0 || rect.height > 40 || rect.width <= 0 || rect.width > 260) continue;
        if (!nearVideo(rect)) continue;
        return true;
      }
      return false;
    },
    // ---- 侧栏每一项的类型/标题/完成标记（对齐真实站点 DOM）----
    // 真实结构：.nav-item-leaf-box > .leaf-item > .leaf-item-left(.leaf-item-tag + .leaf-item-title)
    //                                      + .leaf-item-right > .leaf-item-status > i.icon-yuanquangou-mianzhuang
    // 未完成时 .leaf-item-status 里是空的：没有文字、没有图标。
    leafTag(box) {
      if (!box) return '';
      const tag = box.querySelector('.leaf-item-tag');
      return this.normalizeText(tag?.textContent || '');
    },
    leafLabel(box) {
      if (!box) return '';
      const node = box.querySelector('.leaf-item-title') || box.querySelector('.leaf-name');
      if (node) return this.normalizeText(node.textContent || '');
      const item = box.querySelector('.leaf-item') || box;
      return this.normalizeText(item.textContent || '');
    },
    // 真实站点侧栏是**三态**，不是二态（抓包页面 131 个 status 的 textContent 全是空串）：
    //   100%   → <i class="icon iconfont icon-yuanquangou-mianzhuang">
    //   部分   → <div class="status-pie" style="--p: 79">（纯 CSS 圆环，没有文字）
    //   0/未开 → .leaf-item-status 里是空注释
    // 返回 0-100；判断不了返回 null。
    leafDomPercent(box) {
      if (!box) return null;
      const pickPercent = text => {
        const hit = String(text || '').match(/(\d+(?:\.\d+)?)\s*%?/);
        if (!hit) return null;
        const value = Number(hit[1]);
        return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
      };
      const status = box.querySelector('.leaf-item-status');
      if (status) {
        const pie = status.querySelector('.status-pie');
        if (pie) {
          // --p 是自定义属性，getPropertyValue('--p') 在部分实现里读不到，退回读 style 属性
          const custom = pie.style?.getPropertyValue?.('--p') || '';
          return pickPercent(custom || pie.getAttribute?.('style') || '');
        }
        const icons = [...status.querySelectorAll('i, svg, use')];
        if (icons.length) {
          const cls = icons.map(el => {
            const name = typeof el.className === 'string'
              ? el.className
              : (el.className?.baseVal || '');
            return `${name} ${el.getAttribute?.('xlink:href') || el.getAttribute?.('href') || ''}`;
          }).join(' ');
          if (/yuanquangou|yiwancheng|check|finish|complete|success/i.test(cls)) return 100;
          return null;
        }
        const text = this.normalizeText(status.textContent || '');
        if (!text) return 0;
        if (/已完成/.test(text)) return 100;
        if (/未完成|未开始/.test(text)) return 0;
        return pickPercent(text);
      }
      const legacy = box.querySelector('.leaf-status');
      if (legacy) {
        const text = this.normalizeText(legacy.textContent || '');
        if (/已完成/.test(text)) return 100;
        if (/未完成|未开始/.test(text)) return 0;
        return pickPercent(text);
      }
      return null;
    },
    // 'done' | 'undone' | ''（判断不了就返回空串，交给老的文本/类名兜底）
    leafStatusMark(box) {
      const percent = this.leafDomPercent(box);
      if (percent == null) return '';
      return percent >= 99.5 ? 'done' : 'undone';
    },
    isLeafMarkedDone(box) {
      if (!box) return false;
      // 3.4.0：真实站点只有图标没有文字，旧实现（扫「已完成」文字 / icon-finish 类名）在真机上
      // 恒为 false，等于「从来认不出已完成」，会反复重刷已经刷过的节。
      const mark = this.leafStatusMark(box);
      if (mark === 'done') return true;
      if (mark === 'undone') return false;
      const text = (box.innerText || '').replace(/\s+/g, '');
      if (/未完成|未开始/.test(text)) return false;
      if (Y.Utils.isMarkedDone(text)) return true;
      const classText = [
        box.className || '',
        ...[...box.querySelectorAll('[class]')].slice(0, 40).map(el => el.className)
      ].join(' ');
      return /yiwancheng|is-finish|learned|icon-finish|status-finish/i.test(classText);
    },
    // 路由 type（URL 里的 /lms-graph/<classroom>/<type>/<leaf>）→ 内容类型
    routeKind(type) {
      const key = String(type || '').toLowerCase();
      const map = {
        video: 'video',
        audio: 'audio',
        graph: 'graph',
        pdf: 'pdf',
        quiz: 'quiz',
        forum: 'forum',
        discussion: 'forum',
        exercise: 'exercise',
        homework: 'exercise'
      };
      return map[key] || 'other';
    },
    // 侧栏标签文字 → 内容类型（接口不可用时用来给面板选 kind）
    kindFromTag(tag) {
      const map = {
        视频: 'video',
        音频: 'audio',
        图文: 'graph',
        课件: 'ppt',
        讨论: 'forum',
        作业: 'exercise',
        习题: 'exercise',
        测验: 'quiz',
        考试: 'quiz'
      };
      return map[String(tag || '').trim()] || '';
    },
    kindLabel(kind) {
      return Y.KIND_LABEL[kind] || '内容';
    },
    isCurrentLessonDone() {
      if (this.isActiveLessonMarked()) return true;
      return [...document.querySelectorAll('span, div, button, a, p, label')].some(el => {
        if (!this.isVisibleElement(el) || this.inOutlineArea(el)) return false;
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!/^已完成(\s*详情)?$/.test(text)) return false;
        const rect = el.getBoundingClientRect();
        return rect.top < 280 && rect.height > 0 && rect.height < 56;
      });
    },
    getAllScourse() { // 获得ai-workspace的课程列表
      const list = document?.querySelectorAll(".nav-item-leaf-box")
      if (!list) Y.panel?.warn("没有发现课程资源")
      return list
    }
  };

  Y.WorkspaceDom = WorkspaceDom;
})(Y);
