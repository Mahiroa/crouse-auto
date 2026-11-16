((Y) => {
  // GitHub Release 更新检查
  //
  // 升级本身靠篡改猴：userscript.header.txt 里的 @updateURL / @downloadURL 指向
  // releases/latest/download/yuketang-helper.user.js 这个「固定资产名」，
  // 只要每个 Release 都挂一份同名的 .user.js，篡改猴就会自己提示升级。
  //
  // 这个模块解决的是另一半问题：脚本自己要知道「有没有新版」。
  // 启动后静默查一次 GitHub API，有新版就在面板上亮一个「更新 vX」按钮，
  // 点一下打开安装页；结果缓存 6 小时，避免反复打 GitHub 的 60 次/小时匿名配额。
  const REPO = 'Mahiroa/crouse-auto';
  const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
  const DOWNLOAD_URL = `https://github.com/${REPO}/releases/latest/download/yuketang-helper.user.js`;
  const RELEASE_URL = `https://github.com/${REPO}/releases/latest`;
  const CACHE_KEY = 'ykt_update_cache_v1';
  const SKIP_KEY = 'ykt_update_skip_v1';
  const CACHE_TTL = 6 * 60 * 60 * 1000;

  // 3.10.0 必须大于 3.9.9：按数字逐段比，不能按字符串比
  function parseVersion(value) {
    return String(value || '')
      .replace(/^v/i, '')
      .trim()
      .split(/[.+-]/)
      .slice(0, 3)
      .map(part => Number(part) || 0);
  }

  function compareVersion(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    for (let i = 0; i < 3; i++) {
      if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
    }
    return 0;
  }

  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function currentVersion() {
    return String(Y.Config?.version || '0.0.0');
  }

  function pickAsset(release) {
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const preferred = assets.find(item => /yuketang-helper.*\.user\.js$/i.test(item.name || ''));
    if (preferred) return preferred;
    return assets.find(item => /\.user\.js$/i.test(item.name || '')) || null;
  }

  function requestJSON(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('当前环境不支持跨域请求'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 15000,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Yuketang Course Helper updater'
        },
        onload: res => {
          if (res.status !== 200) {
            reject(new Error(`HTTP ${res.status}`));
            return;
          }
          try {
            resolve(JSON.parse(res.responseText));
          } catch (_) {
            reject(new Error('返回内容不是合法 JSON'));
          }
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('请求超时'))
      });
    });
  }

  const Updater = {
    REPO,
    API_URL,
    DOWNLOAD_URL,
    RELEASE_URL,
    CACHE_TTL,
    compareVersion,
    currentVersion,
    // 最近一次检查的结果，面板和「更多 → 检查更新」都读它
    lastResult: null,
    pendingVersion: '',
    skippedVersion() {
      return String(readJSON(SKIP_KEY) || '');
    },
    skip(version) {
      if (version) writeJSON(SKIP_KEY, String(version));
    },
    unskip() {
      try {
        localStorage.removeItem(SKIP_KEY);
      } catch (_) {}
    },
    readCache() {
      const cache = readJSON(CACHE_KEY);
      if (!cache || typeof cache !== 'object') return null;
      if (!cache.at || Date.now() - cache.at > CACHE_TTL) return null;
      return cache;
    },
    writeCache(payload) {
      writeJSON(CACHE_KEY, { at: Date.now(), ...payload });
    },
    // manual=true：用户主动点的「检查更新」，无论有没有新版都要给一句反馈；
    // 启动时的静默检查只在「有新版」时才说话。
    async checkForUpdate(options = {}) {
      const manual = options.manual === true;
      const current = currentVersion();
      const cached = !options.force && this.readCache();
      let release = null;
      if (cached) {
        release = cached;
      } else {
        try {
          const json = await requestJSON(API_URL);
          const asset = pickAsset(json);
          release = {
            tag: String(json.tag_name || json.name || ''),
            page: json.html_url || RELEASE_URL,
            assetUrl: asset?.browser_download_url || DOWNLOAD_URL,
            assetName: asset?.name || '',
            notes: String(json.body || '').slice(0, 500)
          };
          this.writeCache(release);
        } catch (err) {
          const message = String(err?.message || err);
          this.lastResult = { status: 'error', current, message };
          Y.panel?.log?.(`检查更新失败：${message}`);
          return this.lastResult;
        }
      }

      const remote = release.tag || release.version || '';
      const newer = compareVersion(remote, current) > 0;
      const skipped = this.skippedVersion() === remote && !options.force;
      if (!newer) {
        this.pendingVersion = '';
        this.lastResult = { status: 'latest', current, remote };
        if (manual) Y.panel?.log?.(`已是最新版本 v${current}`);
        return this.lastResult;
      }
      if (skipped) {
        this.lastResult = { status: 'skipped', current, remote };
        if (manual) Y.panel?.log?.(`已跳过 v${remote}，如需升级可点「忽略跳过」`);
        return this.lastResult;
      }

      this.pendingVersion = remote;
      this.lastResult = { status: 'newer', current, remote, page: release.page, assetUrl: release.assetUrl };
      Y.panel?.showUpdate?.(this.lastResult);
      if (manual) Y.panel?.log?.(`发现新版本 v${remote}（当前 v${current}），点面板上的「更新 v${remote.replace(/^v/i, '')}」安装`);
      return this.lastResult;
    },
    // 打开固定资产名的安装地址：篡改猴会接管成安装页；拿不到就退到 Release 页面
    openDownload() {
      const url = this.lastResult?.assetUrl || DOWNLOAD_URL;
      try {
        window.open(url, '_blank', 'noopener');
        Y.panel?.log?.(`已打开更新地址（如未跳转请手动访问）：${url}`);
        return true;
      } catch (_) {
        Y.panel?.log?.(`打开更新地址失败，请手动访问：${url}`);
        return false;
      }
    },
    openRelease() {
      try {
        window.open(this.lastResult?.page || RELEASE_URL, '_blank', 'noopener');
        return true;
      } catch (_) {
        return false;
      }
    }
  };

  Y.Updater = Updater;
})(Y);
