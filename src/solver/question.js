((Y) => {
  // 题目读取、字体还原与截图

  // ---- OCR & AI ----

  const SolverQuestion = {
    readQuestion(element) {
      if (!element) return '';
      return String(element.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    },
    stripReviewNoise(text) {
      return String(text || '')
        .replace(/本题得分[：:][^\n]*/g, '')
        .replace(/正确答案[：:][^\n]*/g, '')
        .replace(/查看解析/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    },
    // 截图识题走同一份 DeepSeek 配置；如果接口/模型不接受图片，会自动退回本地 OCR
    modelCanSee() {
      if (this._imageUnsupported) return false;
      const conf = this.normalizeConf(this.answerConf());
      const keyOk = Boolean(conf.key) && !String(conf.key).includes('xxxx');
      return keyOk && Boolean(conf.url) && Boolean(conf.model);
    },
    answerConf() {
      return Y.Store.getAIConf();
    },
    examFontUrl(doc) {
      const root = doc || document;
      for (const style of root.querySelectorAll('style')) {
        const html = style.textContent || '';
        if (!/exam-data-decrypt-font|exam_font/.test(html)) continue;
        const matched = html.match(/url\((['"]?)([^"')]+)\1\)/);
        if (matched) return new URL(matched[2], root.baseURI || location.href).href;
      }
      for (const sheet of root.styleSheets || []) {
        let rules;
        try { rules = sheet.cssRules; } catch (_) { continue; }
        for (const rule of rules) {
          if (!(rule instanceof CSSFontFaceRule)) continue;
          const src = rule.style.getPropertyValue('src') || '';
          const family = rule.style.getPropertyValue('font-family') || '';
          if (!/exam_font|exam-data-decrypt-font/.test(`${src} ${family}`)) continue;
          const matched = src.match(/url\((['"]?)([^"')]+)\1\)/);
          if (matched) return new URL(matched[2], root.baseURI || location.href).href;
        }
      }
      return '';
    },
    async loadArrayBuffer(url) {
      if (url.startsWith('blob:') || url.startsWith(location.origin)) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`字体下载失败 HTTP ${response.status}`);
        return response.arrayBuffer();
      }
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'arraybuffer',
          timeout: 30000,
          onload: res => res.status === 200 ? resolve(res.response) : reject(new Error(`字体下载失败 HTTP ${res.status}`)),
          onerror: () => reject(new Error('字体下载失败')),
          ontimeout: () => reject(new Error('字体下载超时'))
        });
      });
    },
    async hashGlyph(commands) {
      let source = '';
      for (const command of commands || []) {
        const pairs = Object.entries(command).sort((a, b) => a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1));
        for (const [key, value] of pairs) source += `${key}${value}`;
      }
      const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(source));
      return [...new Uint8Array(digest).slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    },
    async loadGlyphHashMap() {
      if (this._glyphHashMap) return this._glyphHashMap;
      Y.panel.log('正在加载字体对照表...');
      const source = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: 'https://cdn.jsdelivr.net/gh/novob/yuketang-deobfuscator@main/yuketang-deobfuscator.user.js',
          timeout: 30000,
          onload: res => res.status === 200 ? resolve(res.responseText) : reject(new Error(`对照表下载失败 HTTP ${res.status}`)),
          onerror: () => reject(new Error('对照表下载失败')),
          ontimeout: () => reject(new Error('对照表下载超时'))
        });
      });
      const matched = String(source || '').match(/const MAP_DATA = "([^"]+)"/);
      if (!matched) throw new Error('字体对照表格式已变化');
      const raw = atob(matched[1]);
      const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      const packed = new Uint8Array(await new Response(stream).arrayBuffer());
      const map = {};
      for (let i = 0; i + 10 < packed.length; i += 11) {
        let hash = '';
        for (let j = 0; j < 8; j++) hash += packed[i + j].toString(16).padStart(2, '0');
        map[hash] = (packed[i + 8] << 16) | (packed[i + 9] << 8) | packed[i + 10];
      }
      this._glyphHashMap = map;
      return map;
    },
    async decodeQuestion(element) {
      const raw = this.stripReviewNoise(this.readQuestion(element));
      const chars = [...new Set(raw.match(/[\u4e00-\u9fff]/g) || [])];
      if (!chars.length) return raw;
      const parser = window.opentype || (typeof opentype !== 'undefined' ? opentype : null);
      if (!parser) throw new Error('字体解析库未加载');
      const fontUrl = this.examFontUrl(element.ownerDocument || document);
      if (!fontUrl) throw new Error('没有找到加密字体');
      if (!this._fontCache) this._fontCache = {};
      if (!this._fontCache[fontUrl]) {
        const buffer = await this.loadArrayBuffer(fontUrl);
        this._fontCache[fontUrl] = parser.parse(buffer);
      }
      const font = this._fontCache[fontUrl];
      const hashMap = await this.loadGlyphHashMap();
      const mapping = {};
      for (const char of chars) {
        const glyph = font.charToGlyph(char);
        if (!glyph?.path?.commands?.length) continue;
        const hash = await this.hashGlyph(glyph.path.commands);
        const delta = hashMap[hash];
        if (delta !== undefined) mapping[char] = String.fromCodePoint(delta + 0x3400);
      }
      const mapped = Object.keys(mapping).length;
      Y.panel.log(`字体还原 ${mapped}/${chars.length} 个字`);
      if (mapped < Math.max(3, Math.ceil(chars.length * 0.5))) return '';
      return raw.replace(/[\u4e00-\u9fff]/g, char => mapping[char] || char);
    },
    async shootQuestion(element) {
      Y.panel.log('正在截图...');
      const canvas = await html2canvas(element, {
        useCORS: true,
        logging: false,
        scale: 2,
        backgroundColor: '#ffffff'
      });
      return canvas.toDataURL('image/png');
    },
    async captureQuestion(element) {
      if (!element) return null;
      try {
        const decoded = await this.decodeQuestion(element);
        if (decoded && decoded.replace(/\s/g, '').length > 8) {
          Y.panel.log('已按加密字体还原题目');
          return { image: '', text: decoded, element };
        }
      } catch (err) {
        Y.panel.log(`字体还原失败：${err.message || err}`);
      }
      try {
        const image = await this.shootQuestion(element);
        if (image && this.modelCanSee()) {
          Y.panel.log('字体还原失败，改用截图');
          return { image, text: '题目截图', element };
        }
        const text = await this.recognize(element);
        const clean = this.stripReviewNoise(text);
        // recognize() 失败时会返回哨兵字符串；不能把它当成题目继续问 AI，
        // 否则模型会被强制按“选择题”作答，脚本会随机选中并提交。
        if (!clean || /^OCR识别出错$|^无元素$/.test(clean) || clean.replace(/\s/g, '').length < 6) {
          Y.panel.log('OCR 没有识别出题目内容，本题跳过');
          return null;
        }
        return { image: '', text: clean, element };
      } catch (err) {
        Y.panel.log(`截图失败：${err.message || err}`);
        return null;
      }
    },
    normalizeConf(conf) {
      const next = { ...conf };
      let url = String(next.url || '').trim();
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      const retiredModels = {
        'deepseek-chat': 'deepseek-flash',
        'deepseek-reasoner': 'deepseek-flash',
        'deepseek-v4-flash': 'deepseek-flash'
      };
      if (url.includes('deepseek.com') && retiredModels[next.model]) next.model = retiredModels[next.model];
      if (url.includes('deepseek.com') && (next.apiFormat || 'openai') !== 'anthropic') {
        try {
          const parsed = new URL(url);
          const path = parsed.pathname.replace(/\/+$/, '');
          if (parsed.hostname === 'api.deepseek.com' && (path === '' || path === '/v1')) {
            parsed.pathname = '/chat/completions';
            parsed.search = '';
            parsed.hash = '';
            url = parsed.toString();
          }
        } catch (_) {}
      }
      next.url = url;
      return next;
    },
    cleanForumReply(value) {
      return String(value || '')
        .replace(/```(?:[\w-]+)?[ \t]*\r?\n?/g, '')
        .replace(/```/g, '')
        .replace(/^(?:回复|讨论回复)[：:]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
    },
    forumReplyProblem(value) {
      const text = this.cleanForumReply(value);
      if (text.length < 8) return '回复过短或为空';
      if (/<\/?(?:think|thinking|reasoning)(?:\s[^>]*)?>/i.test(text) || /reasoning_content/i.test(text)) {
        return '回复包含思考标签或推理字段';
      }
      const leading = text.slice(0, 160).replace(/^[\s"'“”‘’]+/, '');
      const metaPatterns = [
        /^我(?:要|将|会|需要|准备|打算|来|先来)(?:用[^，。！？\n]{0,12})?(?:先|来)?(?:回答|作答|分析|讨论|回复)/,
        /^(?:下面|以下)(?:是|为)(?:我的)?(?:回复|回答|答案|观点)/,
        /^让我(?:先)?(?:思考|想一想|分析)/,
        /^首先.{0,16}(?:分析|思考|回答)(?:这道|这个|讨论)?题/,
        /^作为(?:一名)?\s*AI\b/i,
        /^(?:好的?|当然|没问题|可以)[，,。！!\s]*(?:我(?:来|将|会)|下面)/,
        /^(?:okay|sure|let me|i will|i need to|here(?:'s| is) my)\b/i
      ];
      if (metaPatterns.some(pattern => pattern.test(leading)) || /(?:^|[\n。！？])\s*(?:思考过程|推理过程|答题过程|答题思路)\s*[：:]/i.test(String(value || ''))) {
        return '回复包含答题前导语或思考过程';
      }
      return '';
    }
  };

  Y.SolverQuestion = SolverQuestion;
})(Y);
