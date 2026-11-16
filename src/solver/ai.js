((Y) => {
  // 检索、模型调用与选项提交

  const SolverAI = {
    // 答案请求的默认输出预算。真机日志里填空题用 1024 跑出了 finish_reason=length，
    // 同一道题连试 3 次都撞同一面墙，题目就卡在那里不动（v3.6.5 实测）。
    // 答案本身很短，给 2048 足够；不够还会自动升档，见 chatBudgets。
    ANSWER_MAX_TOKENS: 2048,
    // 被截断时按预算升档重试（1024 → 2048 → 4096），最多 3 档。
    // 已经是长文生成的预算（讨论回复 32768）就原样用，不放大费用。
    chatBudgets(maxTokens) {
      const base = Math.max(64, Number(maxTokens) || 1024);
      if (base > 4096) return [base];
      const budgets = [base];
      let next = base;
      while (next < 4096 && budgets.length < 3) {
        next = Math.min(next * 2, 4096);
        budgets.push(next);
      }
      return [...new Set(budgets)];
    },
    // 升档重试时追加到用户消息末尾的约束：模型上一轮就是写太多才被截断的
    answerRetryHint: '\n（上次输出被截断。这次只输出一行「答案：xxx」，不要推导和解释。）',
    appendHint(userContent, hint) {
      if (!hint) return userContent;
      if (Array.isArray(userContent)) {
        return userContent.map(block => (block?.type === 'text' ? { ...block, text: `${block.text}${hint}` } : block));
      }
      return `${userContent}${hint}`;
    },
    // 截断的正文里如果已经有结构完整的答案行，就捞出来用，别把整题判成失败。
    // 只认「字母串 / 对错 / 不超过 30 字的填空答案」，半截解释、半句话一律不收。
    salvageTruncated(text) {
      const hit = String(text || '').match(/(?:正确)?答案\s*[：:]\s*([^\n]{1,80})/);
      if (!hit) return '';
      const value = hit[1].trim()
        .replace(/^["'“”‘’【\[（(]+/, '')
        .replace(/["'“”‘’】\]）)]+$/, '')
        .trim();
      if (!value) return '';
      if (/^[A-F]{1,6}$/i.test(value)) return `答案：${value.toUpperCase()}`;
      if (/^(正确|错误|对|错)$/.test(value)) return `答案：${value}`;
      if (value.length > 30 || /[。；;：:]$/.test(value)) return '';
      return `答案：${value}`;
    },
    // 思考档位 → 请求参数。各家网关认的字段名不一样（OpenAI 的 reasoning_effort、
    // Anthropic/DeepSeek 的 thinking、Qwen 系的 enable_thinking），所以一次给全；
    // 网关认哪个用哪个，遇到「参数不认识」的 400 会自动降级成不带这些参数（见 requestChat）。
    thinkingEffortOf(conf) {
      const saved = String(conf?.thinkingEffort || '').toLowerCase();
      return ['off', 'low', 'high', 'max'].includes(saved) ? saved : 'high';
    },
    thinkingParams(effort, apiFormat, isAnthropic) {
      const level = ['off', 'low', 'high', 'max'].includes(effort) ? effort : 'high';
      const budget = level === 'low' ? 512 : level === 'high' ? 2048 : 8192;
      const params = {};
      if (level === 'off') {
        // Off：三套字段都压掉。reasoning_effort:'none' 是新版 OpenAI 兼容网关的写法，
        // enable_thinking:false 是 Qwen/GLM 系的写法，thinking.disabled 是 Anthropic/DeepSeek 的写法。
        if (isAnthropic) params.thinking = { type: 'disabled' };
        else {
          params.reasoning_effort = 'none';
          params.thinking = { type: 'disabled' };
          params.enable_thinking = false;
        }
        return params;
      }
      if (isAnthropic) {
        params.thinking = { type: 'enabled', budget_tokens: budget };
        return params;
      }
      // max 在多数网关上没有独立取值，用 high + 更大的 budget_tokens 表达
      params.reasoning_effort = level === 'max' ? 'high' : level;
      params.thinking = { type: 'enabled', budget_tokens: budget };
      if (apiFormat !== 'anthropic') params.enable_thinking = true;
      return params;
    },
    // 自定义 UA：多台设备/多个脚本共用一个网关时靠它区分请求来源。
    // 只作用于模型请求，且必须是 latin1 可见字符，否则篡改猴会拒发。
    requestUserAgent(conf) {
      const raw = String(conf?.userAgent || '').replace(/[\r\n]+/g, ' ').trim();
      if (!raw) return '';
      return raw.replace(/[^\x20-\x7E]/g, '').slice(0, 200);
    },
    // 单次请求：只负责发一次 HTTP，把正文 / 推理内容 / 是否被截断原样交回 requestChat。
    // 拆出来是为了「截断就升预算再来一次」不必把这段 HTTP 逻辑复制两遍。
    postChat(url, headers, body, apiFormat = 'openai') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url,
          headers,
          data: JSON.stringify(body),
          timeout: 120000,
          onload: res => {
            if (res.status !== 200) {
              const bodyText = String(res.responseText || (typeof res.response === 'string' ? res.response : '') || '').trim();
              // 「接口不认这几个参数」单独识别：requestChat 会去掉思考档位参数重试一次，
              // 而不是把整道题判失败（不同网关支持的字段名不一样）。
              if (res.status === 400 && /reasoning_effort|thinking|enable_thinking|budget_tokens|unknown|unsupported|invalid[\s_-]*(param|field|argument)/i.test(bodyText)) {
                const paramErr = new Error(`接口不接受思考档位参数：${bodyText.slice(0, 160)}`);
                paramErr.unsupportedParam = true;
                reject(paramErr);
                return;
              }
              const err = (res.status === 404 && !bodyText)
                ? `请求被篡改猴拦截。请确认脚本头部允许访问该域名，并在篡改猴里放行。当前地址：${url}`
                : `请求失败: HTTP ${res.status} - ${bodyText.slice(0, 180)}`;
              Y.panel.log(err);
              reject(err);
              return;
            }
            try {
              const json = JSON.parse(res.responseText);
              const choice = json.choices?.[0];
              const message = choice?.message;
              const anthropicBlocks = Array.isArray(json.content) ? json.content : [];
              const anthropicReasoning = anthropicBlocks.some(block => block?.type === 'thinking' || block?.type === 'redacted_thinking');
              const anthropicText = anthropicBlocks
                .filter(block => typeof block?.text === 'string' && (!block.type || block.type === 'text'))
                .map(block => block.text)
                .join('\n');
              const content = message?.content;
              const contentBlocks = Array.isArray(content) ? content : [];
              const openAIText = typeof content === 'string'
                ? content
                : contentBlocks
                  .filter(block => typeof block?.text === 'string' && (!block.type || block.type === 'text' || block.type === 'output_text'))
                  .map(block => block.text)
                  .join('\n');
              // reasoning_content / thinking 只能用于诊断，永远不能回退成可提交答案。
              const thinkingText = anthropicBlocks
                .filter(block => block?.type === 'thinking' && typeof block.thinking === 'string')
                .map(block => block.thinking)
                .join('\n');
              const reasoningText = String(message?.reasoning_content || thinkingText || '').trim();
              resolve({
                text: String(apiFormat === 'anthropic' ? anthropicText : openAIText).trim(),
                reasoningText,
                reasoningOnly: anthropicReasoning,
                finishReason: choice?.finish_reason || json.stop_reason || '',
                truncated: choice?.finish_reason === 'length' || json.stop_reason === 'max_tokens'
              });
            } catch (_) {
              reject('JSON 解析失败');
            }
          },
          onerror: () => reject('网络错误'),
          ontimeout: () => reject('请求超时')
        });
      });
    },
    async requestChat(prompt, systemPrompt, confOverride = null, maxTokens = 1024, images = null) {
      const saved = this.normalizeConf(confOverride || Y.Store.getAIConf());
      const API_URL = saved.url;
      const API_KEY = saved.key;
      const API_FORMAT = saved.apiFormat || 'openai';
      const AUTH_METHOD = saved.authMethod || 'bearer';
      if (!API_URL) {
        throw '请填写 API URL';
      }
      if (!API_KEY || API_KEY.includes('sk-xxxx')) {
        const msg = '⚠️ 请在 [AI配置] 中填写有效的 API Key';
        Y.panel.log(msg);
        throw msg;
      }
      const authHeader = AUTH_METHOD === 'x-api-key'
        ? { 'x-api-key': API_KEY }
        : { 'Authorization': `Bearer ${API_KEY}` };
      const headers = { 'Content-Type': 'application/json', ...authHeader };
      // 自定义 UA 只加在模型请求上（想区分请求来源时用），空串则沿用篡改猴默认 UA
      const customUA = this.requestUserAgent(saved);
      if (customUA) headers['User-Agent'] = customUA;
      const imageList = Array.isArray(images) ? images.filter(Boolean) : [];
      // 截图识题也走 DeepSeek：OpenAI 格式用 image_url，Anthropic 格式用 base64 image block
      const parseDataUrl = value => {
        const match = String(value || '').match(/^data:([^;,]+);base64,(.+)$/);
        return match ? { mediaType: match[1], data: match[2] } : null;
      };
      const userContent = !imageList.length
        ? prompt
        : API_FORMAT === 'anthropic'
          ? [
            ...imageList.map(parseDataUrl).filter(Boolean).map(image => ({
              type: 'image',
              source: { type: 'base64', media_type: image.mediaType, data: image.data }
            })),
            { type: 'text', text: prompt }
          ]
          : [
            { type: 'text', text: prompt },
            ...imageList.map(url => ({ type: 'image_url', image_url: { url, detail: 'high' } }))
          ];
      let apiHostname = '';
      try {
        apiHostname = new URL(API_URL).hostname.toLowerCase();
      } catch (_) {}
      const isDeepSeek = apiHostname === 'api.deepseek.com';
      const isAnthropic = apiHostname === 'api.anthropic.com';
      const budgets = this.chatBudgets(maxTokens);
      const tried = [];
      let salvaged = '';
      let lastReason = '';
      for (let i = 0; i < budgets.length; i++) {
        const budget = budgets[i];
        const content = this.appendHint(userContent, i ? this.answerRetryHint : '');
        const body = API_FORMAT === 'anthropic'
          ? {
            model: saved.model,
            max_tokens: budget,
            system: systemPrompt,
            messages: [{ role: 'user', content }]
          }
          : {
            model: saved.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content }
            ],
            temperature: 0.1,
            max_tokens: budget
          };
        // 思考档位：面板里选的 Off / Low / High / Max 直接写进请求。
        // 关掉思考（或调低档位）是填空题提速的关键：不控档位时模型会自己想到 6k~9k token，
        // 一题等好几分钟。网关不认这些字段时，下面 catch 到 400 会置 _thinkingParamMode='plain'
        // 并自动重试一次，不会把整道题判失败。
        if (this._thinkingParamMode !== 'plain') {
          const effort = this.thinkingEffortOf(saved);
          const extra = this.thinkingParams(effort, API_FORMAT, isAnthropic);
          Object.assign(body, extra);
        }
        if (i > 0) Y.panel.log(`模型上一轮输出被截断，改用 max_tokens=${budget} 重试`);
        let reply;
        try {
          reply = await this.postChat(API_URL, headers, body, API_FORMAT);
        } catch (err) {
          if (err?.unsupportedParam && this._thinkingParamMode !== 'plain') {
            this._thinkingParamMode = 'plain';
            Y.panel.log('接口不认思考档位参数，已改为不带该参数重试（本次会话生效）');
            // 用同一个预算重来一次，不要白白升一档（升档是给「输出被截断」用的）
            i -= 1;
            continue;
          }
          throw err;
        }
        tried.push(budget);
        if (reply.text && !reply.truncated) return reply.text;
        if (!reply.truncated) {
          if (!reply.reasoningText) throw '接口已连通，但没有返回正式答案文本';
          lastReason = `接口只返回了推理内容，未返回正式答案，已停止处理。推理摘录：${reply.reasoningText.slice(0, 160) || '（接口未提供可显示文本）'}`;
          continue;
        }
        // 被截断：先记住已能捞到的答案，还没到最后一档就继续升预算重试
        const sal = this.salvageTruncated(reply.text);
        if (sal) salvaged = sal;
        lastReason = `模型输出达到 token 上限（model=${saved.model || '未设置'}，已试 max_tokens=${tried.join('/')}，finish_reason=${reply.finishReason || 'length'}）`;
      }
      if (salvaged) {
        Y.panel.log(`⚠️ 模型输出被截断，从已返回正文里取到答案：${salvaged.replace(/^答案：/, '')}`);
        return salvaged;
      }
      throw lastReason || '模型没有返回可用答案';
    },
    ping(conf) {
      // 连接测试只验证「能不能通」：强制 off 档 + 32 token，避免点一下测试要等半分钟，
      // 也避免模型在测试请求里顺手想几百个 token。
      const base = this.normalizeConf(conf || Y.Store.getAIConf());
      return this.requestChat('回复：成功', '只回复用户要求的字，不要解释。', { ...base, thinkingEffort: 'off' }, 32);
    },
    httpGet(url) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: 20000,
          headers: {
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
          },
          onload: res => {
            if (res.status !== 200 || !res.responseText) {
              reject(new Error(`HTTP ${res.status}`));
              return;
            }
            resolve(res.responseText);
          },
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('超时'))
        });
      });
    },
    searchQuery(questionText) {
      let text = String(questionText || '').replace(/\s+/g, ' ').trim();
      text = text.replace(/^(单选题|多选题|判断题|填空题|选择题)\s*/, '');
      const optionAt = text.search(/\s[A-F][\.、．]/);
      if (optionAt > 8) text = text.slice(0, optionAt);
      return text.slice(0, 80).trim();
    },
    extractSearchSnippets(html) {
      const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      const nodes = doc.querySelectorAll('li.b_algo h2, li.b_algo p, .b_caption p');
      const snippets = [];
      nodes.forEach(node => {
        const text = String(node.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length < 12 || snippets.includes(text)) return;
        snippets.push(text.slice(0, 240));
      });
      snippets.sort((a, b) => Number(/答案|正确/.test(b)) - Number(/答案|正确/.test(a)));
      // 检索结果整段都会进提示词：3 条 × 160 字足够模型对照，再多只是多花 token
      return snippets.slice(0, 3).map(text => text.slice(0, 160));
    },
    async searchQuestion(questionText) {
      const query = this.searchQuery(questionText);
      if (query.length < 6) return '';
      Y.panel.log('正在搜题...');
      try {
        const html = await this.httpGet(`https://cn.bing.com/search?q=${encodeURIComponent(query + ' 答案')}&setlang=zh-Hans`);
        const snippets = this.extractSearchSnippets(html);
        if (!snippets.length) {
          Y.panel.log('没有搜到可用结果，改由 AI 直接作答');
          return '';
        }
        Y.panel.log(`搜到 ${snippets.length} 条结果，交给 AI 对照`);
        return snippets.join('\n');
      } catch (err) {
        Y.panel.log(`搜题失败，改由 AI 直接作答：${err.message || err}`);
        return '';
      }
    },
    async recognize(element) {
      if (!element) return '无元素';
      try {
        Y.panel.log('正在截图...');
        const canvas = await html2canvas(element, {
          useCORS: true,
          logging: false,
          scale: 2,
          backgroundColor: '#ffffff'
        });
        Y.panel.log('正在 OCR 识别 (首轮较慢)...');
        const { data: { text } } = await Tesseract.recognize(canvas, 'chi_sim', {
          logger: m => {
            if (m.status === 'downloading tesseract lang') {
              console.log(`正在下载语言包 ${(m.progress * 100).toFixed(0)}%`);
            }
          }
        });
        return text.replace(/\s+/g, ' ').trim();
      } catch (err) {
        console.error('OCR error:', err);
        Y.panel.log(`OCR 失败: ${err.message || '网络错误'}`);
        return 'OCR识别出错';
      }
    },
    questionChoices(itemBodyElement) {
      if (!itemBodyElement) return [];
      const listContainer = itemBodyElement.querySelector('.list-inline.list-unstyled-radio') ||
        itemBodyElement.querySelector('.list-unstyled.list-unstyled-radio') ||
        itemBodyElement.querySelector('.list-unstyled') ||
        itemBodyElement.querySelector('ul.list') ||
        itemBodyElement.querySelector('[class*="option-list"]') ||
        itemBodyElement.querySelector('[class*="answer-list"]') ||
        itemBodyElement.querySelector('ul') ||
        itemBodyElement.querySelector('[role="radiogroup"]');
      const listed = (() => {
        if (!listContainer) return [];
        const rows = [...listContainer.querySelectorAll('li')].filter(node => node.querySelector('.el-radio, .el-checkbox, input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'));
        if (rows.length >= 2) return rows;
        return [...listContainer.querySelectorAll('.el-radio, .el-checkbox, [role="radio"], [role="checkbox"]')];
      })();
      if (listed.length >= 2) return listed;
      return this.judgeIconChoices(itemBodyElement);
    },
    judgeIconChoices(itemBodyElement) {
      if (!itemBodyElement) return [];
      const nodes = [...itemBodyElement.querySelectorAll('button, [role="button"], div, span')].filter(el => {
        if (!Y.AiWorkspace.isVisibleElement(el)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 24 || rect.width > 72 || rect.height < 24 || rect.height > 72) return false;
        if (Math.abs(rect.width - rect.height) > 14) return false;
        const text = (el.innerText || '').replace(/\s+/g, '');
        if (text.length > 1) return false;
        const mark = `${el.className || ''} ${el.innerHTML || ''}`;
        return /check|close|right|wrong|correct|error|tick|cross|judge|icon|svg/i.test(mark) || el.querySelector('svg, i');
      });
      nodes.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      for (let i = 0; i < nodes.length - 1; i++) {
        const left = nodes[i].getBoundingClientRect();
        const right = nodes[i + 1].getBoundingClientRect();
        const sameRow = Math.abs(left.top - right.top) < 16;
        const near = right.left > left.left && right.left - left.right < 120;
        if (sameRow && near) return [nodes[i], nodes[i + 1]];
      }
      return [];
    },
    // 题目节点可能在两次读取之间被平台重渲染换掉（Vue 复用 DOM 时会 detach 旧节点）：
    // 旧引用上的 querySelectorAll 一律返回空，于是「选项明明在页面上」却被判成未找到容器。
    // 真机日志里同一题连续 3 次「⚠️ 未找到选项容器」就是这么来的，所以每次读写前都重新解析一次。
    liveQuestionRoot(element) {
      if (element && element.isConnected) return element;
      try {
        const container = Y.AiWorkspace.getExerciseContainer();
        return Y.AiWorkspace.getExerciseQuestionBody(container) || element || null;
      } catch (_) {
        return element || null;
      }
    },
    // 填空题的输入框：真机上是 <input class="blank-item-dynamic" placeholder="输入答案">。
    // 先按这几个标记找；找不到再退回题干容器里的普通文本框（排除搜索/昵称这类干扰项）。
    fillInputs(itemBodyElement) {
      if (!itemBodyElement) return [];
      const scope = itemBodyElement.closest?.('.container-problem') || itemBodyElement;
      const markedSel = 'input.blank-item-dynamic, input[placeholder*="输入答案"], input[placeholder*="填空"]';
      const looseSel = 'input[type="text"], input:not([type])';
      const usable = el => Boolean(el) && !el.disabled && !el.readOnly;
      const looksNoise = el => /search|搜索|昵称|手机号|密码/.test(String(el.getAttribute('placeholder') || ''));
      // 先在题干容器内部找：有的卷面会把整份题都渲染出来，一路 widening 到 .container-problem
      // 会把别的题的填空框一起收集，答案就填到别的题上去了。
      const collect = root => {
        const marked = [...root.querySelectorAll(markedSel)];
        const loose = [...root.querySelectorAll(looseSel)].filter(el => !looksNoise(el));
        return (marked.length ? marked : loose).filter(usable);
      };
      let candidates = collect(itemBodyElement);
      if (!candidates.length && scope !== itemBodyElement) candidates = collect(scope);
      if (!candidates.length) return [];
      let visible = [];
      try {
        visible = candidates.filter(el => Y.AiWorkspace.isVisibleElement(el));
      } catch (_) {}
      // jsdom / 无布局环境里 getBoundingClientRect 恒为 0，全被判不可见时退回「未禁用即算可用」，
      // 否则填空题在回归台里永远识别不到（真机上这一步仍然按可见性过滤）
      return visible.length ? visible : candidates;
    },
    // 填空题答案：模型被要求输出「答案：市场|社会」。这里按 |、｜、；、换行切分，
    // 不按逗号切（「市场，社会」这种答案本身可能就带逗号）。
    extractFillAnswer(aiResponse, blankCount = 1) {
      const raw = String(aiResponse || '').replace(/\r\n?/g, '\n').replace(/```[\w-]*\s*/g, '').replace(/```/g, '').trim();
      const hit = raw.match(/(?:正确)?答案\s*[：:]\s*([\s\S]*)/);
      let body = String(hit ? hit[1] : raw).split('\n')[0].trim();
      body = body.replace(/^[\s"'“”‘’【\[（(]+/, '').replace(/[\s"'“”‘’】\]）)]+$/, '').trim();
      if (!body) return [];
      const parts = body.split(/\s*[|｜]\s*|；|;/).map(item => item.trim()).filter(Boolean);
      if (blankCount <= 1) return [body.replace(/\s*[|｜].*$/, '').trim() || body];
      return parts.slice(0, blankCount);
    },
    // 提交按钮：选择题和填空题共用。先在自己的容器里找，再退到作业容器/整页，
    // 判据是「可见 + 文本像提交」，不用「按钮消失」这种易误判的信号。
    findSubmitButton(scope) {
      const element = this.liveQuestionRoot(scope);
      const ownerDocument = element?.ownerDocument || document;
      let container = null;
      try {
        container = Y.AiWorkspace.getExerciseContainer();
      } catch (_) {}
      const roots = [element?.parentElement, element, container, ownerDocument].filter(Boolean);
      const matchText = text => /提交|保存|确认|确定|提交答案/.test(text);
      // innerText 在无布局环境（jsdom）里是 undefined，用 textContent 兜底；真机上 innerText 有值，
      // 隐藏元素仍会拿到空串，不会被这里误认成可点按钮（后面还有 offsetParent 判据）。
      const labelOf = btn => btn.innerText ?? btn.textContent ?? '';
      for (const root of roots) {
        const local = root.querySelectorAll('button, .el-button, [role="button"]');
        for (const btn of local) {
          if (btn.offsetParent !== null && matchText(labelOf(btn))) return btn;
        }
      }
      const global = ownerDocument.querySelectorAll('.el-button.el-button--primary.el-button--medium');
      for (const btn of global) {
        if (matchText(labelOf(btn)) && btn.offsetParent !== null) return btn;
      }
      return null;
    },
    // 填空题：把答案按空逐个填进 input，再点提交。
    // 填值用 Y.AiWorkspace.setFieldValue（走原生 setter + input/change 事件，Vue 才认）。
    async fillAndSubmit(aiResponse, itemBodyElement) {
      const scope = this.liveQuestionRoot(itemBodyElement);
      const inputs = this.fillInputs(scope);
      if (!inputs.length) {
        Y.panel.log('⚠️ 未找到填空输入框');
        return false;
      }
      const answers = this.extractFillAnswer(aiResponse, inputs.length);
      if (!answers.length) {
        Y.panel.log('⚠️ 未提取到填空答案，请人工检查');
        return false;
      }
      Y.panel.log(`✅ 填空题（${inputs.length} 个空），填入：${answers.join(' / ')}`);
      if (answers.length < inputs.length) {
        Y.panel.log(`提示：模型只给出 ${answers.length} 个答案，其余 ${inputs.length - answers.length} 个空留空`);
      }
      for (let i = 0; i < inputs.length; i++) {
        const value = answers[i] || '';
        if (!value) continue;
        try {
          Y.AiWorkspace.setFieldValue(inputs[i], value);
        } catch (err) {
          Y.panel.log(`⚠️ 第 ${i + 1} 个空填值失败：${err?.message || err}`);
          return false;
        }
        // 有的填空框绑了逐字校验，一次性塞值会被组件回滚成空串：
        // 读回一次，值没进去就改成逐字输入，别让「已经填过」变成空提交。
        let current = String(inputs[i].value ?? '');
        if (current !== value) {
          await this.typeIntoInput(inputs[i], value);
          current = String(inputs[i].value ?? '');
          if (current !== value) Y.panel.log(`⚠️ 第 ${i + 1} 个空的输入值没写进去（页面读回「${current}」）`);
        }
        Y.panel.log(`第 ${i + 1} 个空 ← ${current || value}`);
        await Y.Utils.humanPause(200, 600);
      }
      Y.panel.noteAnswer(answers.join(' / ').slice(0, 40));
      // 「提交」在没填完时是禁用态，禁用的按钮点下去等于没点：先等它变成可点。
      const clickable = btn => Boolean(btn) && btn.disabled !== true
        && btn.getAttribute('aria-disabled') !== 'true'
        && !btn.classList.contains('is-disabled');
      const ready = await Y.Utils.poll(() => clickable(this.findSubmitButton(scope)), { interval: 200, timeout: 3000 });
      if (!ready) Y.panel.log('提示：提交按钮仍是禁用态，仍然尝试点击一次');
      const submitBtn = this.findSubmitButton(scope);
      if (!submitBtn) {
        Y.panel.log('⚠️ 未找到提交按钮，本题按未提交处理');
        return false;
      }
      Y.panel.log('正在提交...');
      await Y.Utils.humanPause(800, 2800);
      const submitted = await Y.Utils.humanClick(submitBtn, 1800, 5600);
      if (!submitted) {
        Y.panel.log('⚠️ 提交按钮的点击被安全核验拦截，本题未提交');
        return false;
      }
      // 点完「提交」平台会先弹确认框（「刚刚答完的习题还没有提交」「n 道已作答习题未提交」），
      // 弹窗带遮罩，不点掉的话按钮一直是禁用态、答案一直没交上去
      await Y.Utils.handleSubmitDialog?.();
      // 点完立刻看一次页面变化（按钮变灰 / 出现结果 / 题目被换掉），
      // 免得把「点了但平台没接收」的填空题当成已提交。
      const accepted = await Y.Utils.poll(() => {
        const latestRoot = this.liveQuestionRoot(itemBodyElement);
        const latestBtn = this.findSubmitButton(latestRoot);
        return !latestBtn || !clickable(latestBtn) || Boolean(this.revealedResult(latestRoot));
      }, { interval: 300, timeout: 2500 });
      if (!accepted) Y.panel.log('提示：提交后页面没有给出任何变化，若平台未记分可稍后重试本题');
      return true;
    },
    // 逐字输入：每个字符单独派发 input 事件，模拟真人打字。
    // 只在 setFieldValue 之后读回值不对时才用，正常输入框不会走到这里。
    async typeIntoInput(el, text) {
      if (!el) return;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      let typed = '';
      for (const char of String(text)) {
        typed += char;
        if (setter) setter.call(el, typed);
        else el.value = typed;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }));
        await Y.Utils.sleep(30);
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    detectQuestionType(itemBodyElement) {
      const choices = this.questionChoices(itemBodyElement);
      // 没有选项、但有填空输入框：这是填空题，不是「还没渲染出来的选择题」
      if (!choices.length && this.fillInputs(itemBodyElement).length) return 'fill';
      const hasCheckbox = choices.some(choice => choice.matches('.el-checkbox, [role="checkbox"]') || choice.querySelector('.el-checkbox, input[type="checkbox"], [role="checkbox"]'));
      const labels = choices.map(choice => String(choice.innerText ?? choice.textContent ?? '').replace(/\s+/g, ''));
      const polarity = text => {
        if (/不正确|不对|错误|错|否|False/i.test(text)) return 'false';
        if (/正确|对|是|True/i.test(text)) return 'true';
        return '';
      };
      const pageText = `${itemBodyElement?.innerText || ''} ${itemBodyElement?.parentElement?.innerText || ''}`;
      if (/判断题/.test(pageText.slice(0, 80))) return 'judge';
      const judgeLabels = labels.map(polarity).filter(Boolean);
      if (!hasCheckbox && labels.length === 2 && judgeLabels.length === 2 && judgeLabels[0] !== judgeLabels[1]) return 'judge';
      if (!hasCheckbox && choices.length === 2 && labels.every(text => text.length <= 1)) return 'judge';
      if (hasCheckbox) return 'multiple';
      return 'single';
    },
    revealedResult(element) {
      const text = String(element?.innerText || '');
      if (!/本题得分|正确答案/.test(text)) return null;
      const score = text.match(/本题得分[：:]\s*([0-9.]+)/);
      const answer = text.match(/正确答案[：:]\s*([^\n]+)/);
      return {
        score: score ? score[1] : '',
        answer: answer ? answer[1].replace(/\s+/g, ' ').trim() : ''
      };
    },
    questionStem(element) {
      return this.stripReviewNoise(element?.innerText || '').replace(/\s+/g, '').slice(0, 120);
    },
    // 题干 + 选项文本一起做指纹。只拿题干当 key 时，同一道题只要选项顺序变了
    // （平台抽题、同题干不同卷面）就会命中上一次的缓存答案，把 A 的答案点到别的选项上；
    // 选项文本 join('|') 参与哈希后，顺序一变 key 就变，宁可退回问 AI 也不错选。
    // FNV-1a 32bit：Math.imul 保住 32 位乘法精度，不引入依赖，输出 8 位小写 hex。
    questionFingerprint(itemBodyElement) {
      if (!itemBodyElement) return '';
      const stem = this.questionStem(itemBodyElement);
      const options = this.questionChoices(itemBodyElement)
        .map(choice => String(choice.innerText || '').replace(/\s+/g, ''))
        .join('|');
      if (!stem && !options) return '';
      const raw = `${stem}#${options}`;
      let hash = 0x811c9dc5;
      for (let i = 0; i < raw.length; i++) {
        hash ^= raw.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    },
    questionTypeName(questionType) {
      if (questionType === 'multiple') return '多选题';
      if (questionType === 'judge') return '判断题';
      if (questionType === 'fill') return '填空题';
      return '单选题';
    },
    // 这段约束每道题都会随请求发一次，多一行字就是每道题多付一次输入 token；
    // 只保留「题型 + 输出格式」，其余交给系统提示兜底。
    questionTypeRule(questionType, optionCount) {
      if (questionType === 'fill') {
        const blanks = Number(optionCount) > 0 ? Number(optionCount) : 1;
        return blanks > 1
          ? `填空题（${blanks} 个空）：只输出答案，多空按顺序用 | 分隔，如「答案：市场|社会」。`
          : '填空题：只输出答案，如「答案：市场」，字数按括号提示。';
      }
      const maxChar = String.fromCharCode(65 + Math.max(optionCount, 1) - 1);
      const rangeStr = optionCount ? `A-${maxChar}` : 'A-D';
      if (questionType === 'multiple') return `多选题（${optionCount || '若干'} 项，A-${maxChar}）：少选不得分，字母连写，如「答案：ABCD」。`;
      if (questionType === 'judge') return '判断题：只输出「对」或「错」，如「答案：对」。';
      return `单选题（${optionCount || '若干'} 项，${rangeStr}）：只输出一个字母，如「答案：A」。`;
    },
    async waitBeforeSearch(prefix) {
      if (Y.Utils.isFastMode()) {
        Y.panel.log('快速模式已开启，跳过读题等待');
        return;
      }
      const waitMs = Y.Utils.randInt(5000, 16000);
      Y.panel.log(`${prefix}，${Math.round(waitMs / 1000)} 秒后开始搜索并提交`);
      await Y.Utils.sleep(waitMs);
    },
    // 系统提示按题型切换：填空题要的是「答案文本」，不是字母
    answerSystemPrompt(questionType) {
      if (questionType === 'fill') return '只输出填空答案；多空用 | 分隔。不要解释、不要引号、不要解析。';
      return '只输出答案：选择题写字母（多选连写），判断题写对/错。不要解释。';
    },
    async askAI(questionText, optionCount = 0, image = '', questionType = 'single', element = null) {
      const answerConf = this.answerConf();
      const modelName = answerConf.model || 'DeepSeek';
      if (image) {
        Y.panel.log(`正在让${modelName}复述截图中的题目...`);
        let restated = '';
        try {
          restated = this.stripReviewNoise(await this.requestChat(
            '请逐字复述图片中的完整题目和所有选项。保留题干、选项字母和选项内容，按原来的换行。不要作答，不要解释。',
            '你只负责把图片里的题目原样复述出来。',
            answerConf,
            1024,
            [image]
          ));
        } catch (err) {
          // DeepSeek 接口/模型不接受图片时，退回本地 OCR，并让后续题目直接走 OCR
          this._imageUnsupported = true;
          Y.panel.log(`截图识题失败（${err}），后续题目改用本地 OCR`);
          let ocrText = '';
          try {
            ocrText = element ? this.stripReviewNoise(await this.recognize(element)) : '';
          } catch (_) {}
          if (ocrText && !/^OCR识别出错$|^无元素$/.test(ocrText) && ocrText.replace(/\s/g, '').length > 5) {
            return this.askAI(ocrText, optionCount, '', questionType);
          }
          throw err;
        }
        if (restated.replace(/\s/g, '').length < 8) throw new Error('模型没有复述出题目');
        Y.panel.showQuestion(restated);
        await this.waitBeforeSearch('复述已写在上方题目卡片');
        const evidence = await this.searchQuestion(restated);
        Y.panel.log(evidence ? '正在根据复述和搜索结果作答...' : '没有搜到结果，改由模型根据复述作答...');
        const prompt = `题目：\n${restated}
${evidence ? `搜索参考：\n${evidence}\n` : ''}${this.questionTypeRule(questionType, optionCount)}
搜索能对上就用它，对不上按题目判断。只输出「答案：…」，不要解释。`;
        return this.requestChat(prompt, this.answerSystemPrompt(questionType), answerConf, this.ANSWER_MAX_TOKENS);
      }
      Y.panel.showQuestion(questionText);
      await this.waitBeforeSearch('还原后的题目已写在上方卡片');
      const evidence = await this.searchQuestion(questionText);
      const prompt = `题目：\n${questionText}
${evidence ? `搜索参考：\n${evidence}\n` : ''}${this.questionTypeRule(questionType, optionCount)}
搜索能对上就用它，对不上按题目判断。只输出「答案：…」，不要解释。`;
      return this.requestChat(prompt, this.answerSystemPrompt(questionType), answerConf, this.ANSWER_MAX_TOKENS);
    },
    // 从模型正文里提取答案 token（字母串 / 对 / 错）。autoSelectAndSubmit 与答案缓存共用它：
    // 两处各写一份正则时一旦分叉，就会出现「缓存里存的 A、实际点的是 AB」这种脏缓存。
    extractAnswerToken(aiResponse) {
      const match = String(aiResponse || '').match(/(?:正确)?答案[：:]?\s*([A-F]+(?:[,，][A-F]+)*|[对错]|正确|错误)/i);
      if (!match) return '';
      const raw = match[1].replace(/[,，]/g, '').trim();
      if (!raw) return '';
      // 判断题统一成单字「对 / 错」，选择题统一成大写字串，缓存里只存这个标准形态。
      if (/^(正确|对|错误|错)$/.test(raw)) return /^(正确|对)$/.test(raw) ? '对' : '错';
      return raw.toUpperCase();
    },
    async autoSelectAndSubmit(aiResponse, itemBodyElement, questionType = 'single') {
      // 每次提交前重新解析一次题目节点：重试之间平台可能已经把旧节点换掉，
      // 旧引用上的查询会全部落空（真机「未找到选项容器」连续 3 次的根因）。
      const scope = this.liveQuestionRoot(itemBodyElement);
      if (questionType === 'fill') return this.fillAndSubmit(aiResponse, scope);
      const answerToken = this.extractAnswerToken(aiResponse);
      if (!answerToken) {
        Y.panel.log('⚠️ 未提取到有效选项，请人工检查');
        return false;
      }
      let answerRaw = answerToken;
      const map = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4, 'F': 5 };
      const choices = this.questionChoices(scope);
      if (choices.length < 2) {
        Y.panel.log('⚠️ 未找到选项容器');
        return false;
      }
      const polarity = text => {
        const compact = String(text || '').replace(/\s+/g, '');
        if (/不正确|不对|错误|错|否|False/i.test(compact)) return 'false';
        if (/正确|对|是|True/i.test(compact)) return 'true';
        return '';
      };
      let targetIndices = [];
      if (questionType === 'judge') {
        const upper = answerRaw.toUpperCase();
        const want = (answerRaw === '错' || answerRaw === '错误' || upper === 'B') ? 'false'
          : (answerRaw === '对' || answerRaw === '正确' || upper === 'A') ? 'true' : '';
        if (!want) {
          Y.panel.log(`⚠️ 判断题答案无法识别：${answerRaw}`);
          return false;
        }
        const found = choices.findIndex(choice => polarity(choice.innerText) === want);
        targetIndices = [found >= 0 ? found : (want === 'false' ? 1 : 0)];
        answerRaw = want === 'false' ? '错' : '对';
      } else {
        for (const char of answerRaw.toUpperCase()) {
          if (map[char] !== undefined) targetIndices.push(map[char]);
        }
        if (questionType === 'single') targetIndices = targetIndices.slice(0, 1);
      }
      targetIndices = [...new Set(targetIndices)].filter(idx => idx < choices.length);
      if (!targetIndices.length) {
        Y.panel.log(`⚠️ AI 答案 ${answerRaw} 不在选项范围内，未选择`);
        return false;
      }
      Y.panel.log(`✅ ${this.questionTypeName(questionType)}，选择：${answerRaw}`);

      const isChosen = choice => Boolean(
        choice.classList.contains('is-checked')
        || choice.getAttribute('aria-checked') === 'true'
        || choice.querySelector('.is-checked, input:checked, [aria-checked="true"]')
      );
      for (const idx of targetIndices) {
        const choice = choices[idx];
        if (!choice) continue;
        if (isChosen(choice)) continue;
        const clickable = choice.querySelector('label.el-radio') ||
          choice.querySelector('label.el-checkbox') ||
          choice.querySelector('.el-radio__label') ||
          choice.querySelector('.el-checkbox__label') ||
          choice.querySelector('[role="radio"]') ||
          choice.querySelector('[role="checkbox"]') ||
          choice.querySelector('input') ||
          choice;
        const clicked = await Y.Utils.humanClick(clickable, 1400, 4200);
        if (!clicked) {
          Y.panel.log(`⚠️ 选项 ${String.fromCharCode(65 + idx)} 的点击被安全核验拦截，放弃本题`);
          return false;
        }
        if (!isChosen(choice)) Y.panel.log(`提示：选项 ${String.fromCharCode(65 + idx)} 的选中状态未在 DOM 上体现，继续提交`);
        if (targetIndices.length > 1) await Y.Utils.humanPause(500, 2200);
      }
      // 选项都点到了才把 trail 标成 done：以前在任何点击之前就 noteAnswer，
      // 一旦选项/提交被安全核验拦下，面板仍显示“已作答”，实际什么都没交。
      Y.panel.noteAnswer(answerRaw);
      const submitBtn = this.findSubmitButton(scope);
      if (!submitBtn) {
        // 找不到提交按钮就不能假定已提交：上层 `if (!submitted) throw` 必须生效，
        // 否则面板会记成功但实际没交卷（审查报告口径：未点到提交返回 false）。
        Y.panel.log('⚠️ 未找到提交按钮，本题按未提交处理');
        return false;
      }
      Y.panel.log('正在提交...');
      await Y.Utils.humanPause(800, 2800);
      const submitted = await Y.Utils.humanClick(submitBtn, 1800, 5600);
      if (!submitted) {
        // 提交按钮的 humanClick 可能被安全核验拦下，而以前返回值被直接丢弃（函数仍 return true）：
        // 现在把失败传回调用方，让 handleHomework / solveExerciseQuestion 的 `if (!submitted) throw` 真正生效。
        Y.panel.log('⚠️ 提交按钮的点击被安全核验拦截，本题未提交');
        return false;
      }
      // 提交后的平台确认弹窗必须点掉，否则答案根本没交上去（详见 human-check.js 的 submitDialogRules）
      await Y.Utils.handleSubmitDialog?.();
      return true;
    }
  };

  Y.SolverAI = SolverAI;
})(Y);
