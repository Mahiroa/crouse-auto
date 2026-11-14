((Y) => {
  // 检索、模型调用与选项提交

  const SolverAI = {
    requestChat(prompt, systemPrompt, confOverride = null, maxTokens = 1024, images = null) {
      const saved = this.normalizeConf(confOverride || Y.Store.getAIConf());
      const API_URL = saved.url;
      const API_KEY = saved.key;
      const MODEL_NAME = saved.model;
      const API_FORMAT = saved.apiFormat || 'openai';
      const AUTH_METHOD = saved.authMethod || 'bearer';
      return new Promise((resolve, reject) => {
        if (!API_URL) {
          reject('请填写 API URL');
          return;
        }
        if (!API_KEY || API_KEY.includes('sk-xxxx')) {
          const msg = '⚠️ 请在 [AI配置] 中填写有效的 API Key';
          Y.panel.log(msg);
          reject(msg);
          return;
        }
        const authHeader = AUTH_METHOD === 'x-api-key'
          ? { 'x-api-key': API_KEY }
          : { 'Authorization': `Bearer ${API_KEY}` };
        const headers = { 'Content-Type': 'application/json', ...authHeader };
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
        let body;
        if (API_FORMAT === 'anthropic') {
          if (isAnthropic) headers['anthropic-version'] = '2023-06-01';
          body = {
            model: MODEL_NAME,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [{ role: 'user', content: userContent }]
          };
          // 两套 Anthropic 兼容协议的关闭思考参数不同，不能互相套用。
          // 第三方兼容服务不擅自加参数，由下方“只采用正式正文”的逻辑兜底。
          if (isDeepSeek) body.reasoning = { effort: 'none' };
          else if (isAnthropic) body.thinking = { type: 'disabled' };
        } else {
          body = {
            model: MODEL_NAME,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent }
            ],
            temperature: 0.1,
            max_tokens: maxTokens
          };
          if (isDeepSeek) body.thinking = { type: 'disabled' };
        }
        GM_xmlhttpRequest({
          method: 'POST',
          url: API_URL,
          headers,
          data: JSON.stringify(body),
          timeout: 120000,
          onload: res => {
            if (res.status !== 200) {
              const bodyText = String(res.responseText || (typeof res.response === 'string' ? res.response : '') || '').trim();
              const err = (res.status === 404 && !bodyText)
                ? `请求被篡改猴拦截。请确认脚本头部允许访问该域名，并在篡改猴里放行。当前地址：${API_URL}`
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
              const reasoningText = String(message?.reasoning_content || '').trim();
              const answerText = String(API_FORMAT === 'anthropic' ? anthropicText : openAIText).trim();
              if (choice?.finish_reason === 'length' || json.stop_reason === 'max_tokens') {
                const truncated = answerText ? `，已丢弃截断正文：${answerText.slice(0, 160)}` : '';
                reject(`模型输出达到 token 上限，回复不完整，已停止处理${truncated}`);
                return;
              }
              if (!answerText) {
                if (reasoningText || anthropicReasoning) {
                  reject(`接口只返回了推理内容，未返回正式答案，已停止处理。推理摘录：${reasoningText.slice(0, 160) || '（接口未提供可显示文本）'}`);
                } else {
                  reject('接口已连通，但没有返回正式答案文本');
                }
                return;
              }
              resolve(answerText);
            } catch (_) {
              reject('JSON 解析失败');
            }
          },
          onerror: () => reject('网络错误'),
          ontimeout: () => reject('请求超时')
        });
      });
    },
    ping(conf) {
      return this.requestChat('只回复两个字：成功', '你是连接测试助手，只按用户要求回复。', conf, 64);
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
      return snippets.slice(0, 5);
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
    detectQuestionType(itemBodyElement) {
      const choices = this.questionChoices(itemBodyElement);
      const hasCheckbox = choices.some(choice => choice.matches('.el-checkbox, [role="checkbox"]') || choice.querySelector('.el-checkbox, input[type="checkbox"], [role="checkbox"]'));
      const labels = choices.map(choice => (choice.innerText || '').replace(/\s+/g, ''));
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
    questionTypeName(questionType) {
      if (questionType === 'multiple') return '多选题';
      if (questionType === 'judge') return '判断题';
      return '单选题';
    },
    questionTypeRule(questionType, optionCount) {
      const maxChar = String.fromCharCode(65 + Math.max(optionCount, 1) - 1);
      const rangeStr = optionCount ? `A-${maxChar}` : 'A-D';
      if (questionType === 'multiple') return `这是多选题，有 ${optionCount || '若干'} 个选项，范围 ${rangeStr}。少选不得分，每个正确选项都要选上，字母连写，例如 ABCD。`;
      if (questionType === 'judge') return '这是判断题。只能输出“对”或“错”，不要输出字母。';
      return `这是单选题，有 ${optionCount || '若干'} 个选项，范围 ${rangeStr}。只能选择一个选项，正确答案只能有一个字母。`;
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
        const prompt = `
你是专业做题助手。下面题目是模型从截图复述的，搜索结果只在明确对应这道题时采用。
强约束：
1) ${this.questionTypeRule(questionType, optionCount)}
2) 按复述中选项出现顺序映射 A/B/C/D...
3) 输出格式必须包含“正确答案：”前缀，例如 正确答案：A 或 正确答案：ABD 或 正确答案：对
题目内容：
${restated}
${evidence ? `搜索结果：\n${evidence}` : ''}
`;
        return this.requestChat(prompt, '你只输出答案。判断题输出对或错，选择题输出字母。搜索结果只在与本题一致时才采用。', answerConf);
      }
      Y.panel.showQuestion(questionText);
      await this.waitBeforeSearch('还原后的题目已写在上方卡片');
      const evidence = await this.searchQuestion(questionText);
      const prompt = `
你是专业做题助手。先看搜索结果是否就是这道题，再看页面上的选项。
强约束：
1) 搜索结果明确对应本题时，采用其中的答案；结果是别的题、互相矛盾或没有答案时，再根据题目判断
2) ${this.questionTypeRule(questionType, optionCount)}
3) 按选项出现顺序映射 A/B/C/D...
4) 输出格式必须包含“正确答案：”前缀，例如 正确答案：A 或 正确答案：ABD 或 正确答案：对
${evidence ? `搜索结果：\n${evidence}\n` : ''}题目内容：
${questionText}
`;
      return this.requestChat(prompt, "你是一个只输出答案的助手。判断题输出'对'或'错'，选择题输出字母。搜索结果只在与本题一致时才采用。", answerConf);
    },
    async autoSelectAndSubmit(aiResponse, itemBodyElement, questionType = 'single') {
      const match = String(aiResponse || '').match(/(?:正确)?答案[：:]?\s*([A-F]+(?:[,，][A-F]+)*|[对错]|正确|错误)/i);
      if (!match) {
        Y.panel.log('⚠️ 未提取到有效选项，请人工检查');
        return false;
      }
      let answerRaw = match[1].replace(/[,，]/g, '').trim();
      const map = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4, 'F': 5 };
      const choices = this.questionChoices(itemBodyElement);
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
      const submitBtn = (() => {
        const ownerDocument = itemBodyElement.ownerDocument || document;
        const roots = [itemBodyElement.parentElement, itemBodyElement, ownerDocument].filter(Boolean);
        const matchText = text => /提交|保存|确认|确定|提交答案/.test(text);
        for (const root of roots) {
          const local = root.querySelectorAll('button, .el-button, [role="button"]');
          for (const btn of local) {
            if (btn.offsetParent !== null && matchText(btn.innerText || '')) return btn;
          }
        }
        const global = ownerDocument.querySelectorAll('.el-button.el-button--primary.el-button--medium');
        for (const btn of global) {
          if (matchText(btn.innerText || '') && btn.offsetParent !== null) return btn;
        }
        return null;
      })();
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
      return true;
    }
  };

  Y.SolverAI = SolverAI;
})(Y);
