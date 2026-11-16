# src/ · 模块源码（雨课堂刷课助手 3.6.4）

`src/` 是**唯一的开发入口**：35 个模块按领域分目录存放，`manifest.json` 显式声明加载顺序与拓扑依赖（`loadAfter`），
`userscript.header.txt` 提供产物头部。产物 `dist/雨课堂刷课助手-3.6.4.user.js` 由 `tools/build-userscript.js` 拼装生成，**不要手改**——下一次构建直接覆盖。

```
src/
├── manifest.json               # 模块顺序（= 加载顺序）、loadAfter、版本、入口调用
├── userscript.header.txt       # // ==UserScript== 头，构建时原样放在产物最前面
├── core/
│   ├── constants.js            # DEFAULT_PLAYBACK / KIND_LABEL / DONE_RATE
│   └── config.js               # Config（版本、倍速、翻页间隔、存储键）
├── utils/
│   ├── timing.js  text.js  human-check.js  dom.js    # 四个工具分片
│   └── index.js                # 装配 Utils
├── storage/
│   └── store.js                # localStorage 封装 + Store
├── player/
│   ├── duration.js  controls.js  observe.js
│   └── index.js                # 装配 Player
├── progress/
│   ├── ledger.js               # 进度契约与观看区间算术
│   └── api.js                  # 平台接口层 YktApi
├── workspace/
│   ├── media.js  dom.js
│   └── index.js                # 装配 AiWorkspace
├── panel/
│   ├── visibility.js  markup.js  panel.js
├── platform/
│   └── screen-check.js         # 切屏拦截兼容层
├── solver/
│   ├── question.js  ai.js
│   └── index.js                # 装配 Solver
├── runners/
│   ├── legacy.js               # pro/lms 旧版与新版
│   ├── v2/  media.js  courseware.js  runner.js
│   └── workspace/  media.js  progress.js  credit.js  exercise.js  runner.js
└── app/
    ├── router.js               # start()
    └── bootstrap.js            # boot()
```

**分目录职责**

| 目录 | 放什么 | 命名约定 |
|---|---|---|
| `core/` | 全局常量（`constants`）、运行期配置（`config`） | 一个关注点一个文件 |
| `utils/` | 无业务状态的纯工具 | 分片按能力命名（`timing`/`text`/`human-check`/`dom`） |
| `storage/` | localStorage 与配置读写 | — |
| `player/` | 播放器控制与时长判定 | 分片按动作命名 |
| `progress/` | 平台进度契约与接口层 | `ledger`（纯算术）/`api`（网络） |
| `workspace/` | ai-workspace 学习空间的路由与 DOM | — |
| `panel/` | 面板模板、面板实例与运行期状态、全屏可见性兜底 | — |
| `platform/` | 站点级兼容层（切屏拦截、原生事件） | — |
| `solver/` | 答题：读题 + 模型调用 | — |
| `runners/` | 刷课流程：`v2/`、`workspace/`、`legacy.js` | 子目录内一律 `runner.js` 表示流程主体 |
| `app/` | 路由分发与引导启动 | — |

**命名规范**：文件名一律 kebab-case，**不加 `00-`/`01-` 之类编号前缀**；顺序只由 `manifest.json` 的数组顺序 + `loadAfter` 表达（见第 3 节）。每个领域的装配入口固定叫 `index.js`，只做 spread 合并。

---

## 1. 模块地图

「形态」列对应第 4 节的三种拆分模式：**整语句** = 一段完整语句原样搬运；**对象分片** = 从一个大对象里切出的属性组；**装配** = 只做 spread 合并（一律叫 `index.js`）；**类主体/mixin** = class 本体 + `Object.assign(X.prototype, …)`；**模板** = 返回模板字符串的箭头函数。

| 路径 | 标题（= manifest 原文） | 形态 | 职责 | 导出到 `Y` |
|---|---|---|---|---|
| `core/constants.js` | 基础常量：默认播放设置、轨迹文案、完成阈值 | 整语句 | `DEFAULT_PLAYBACK`、`KIND_LABEL`、`DONE_RATE`（不导出到面板的运行期状态） | `DEFAULT_PLAYBACK`、`KIND_LABEL`、`DONE_RATE` |
| `core/config.js` | 运行期配置（Config） | 整语句 | 版本、倍速、ppt 翻页间隔、全部存储键；`playbackRate` 取自 `Y.DEFAULT_PLAYBACK` | `Config` |
| `utils/timing.js` | 计时、轮询与后台节流 | 对象分片 | `sleep`/`humanPause`/`randInt`/`isFastMode`/`isTabReallyHidden`/`poll` | `UtilsTiming` |
| `utils/text.js` | 文本解析与完成度文案判定 | 整语句 + 对象分片 | `pctText`；`safeJSONParse`/`isProgressDone`/`isMarkedDone` | `pctText`、`UtilsText` |
| `utils/human-check.js` | 安全核验检测与闸门（skip / wait / auto 三态） | 对象分片 | `isHumanCheckVisible`（文本扫描 + `RiskChallenge.isPresent()` 并集）/`gateHumanCheck`/`waitIfHumanCheck`/`humanClick` | `UtilsHumanCheck` |
| `utils/risk-challenge.js` | 安全核验求解：轨迹型 canvas 题（shadow DOM 里的 `#homework-automation-risk-challenge > canvas`） | 整语句 + 对象分片 | Tier A 钩 `CanvasRenderingContext2D`（arc/ellipse/fillText/clearRect + `getTransform`）拿圆心与数字；Tier B `getImageData` HSV 分割 + 12×16 模板匹配；1..N 排列校验；贝塞尔轨迹派发（派发到 canvas、`composed:true`）；`installHooks` 幂等、模块求值时自装 | `RiskChallenge`（`create/findCanvas/isPresent/isVisible/installHooks`） |
| `utils/dom.js` | 页面信息、挂载点与媒体时长 | 对象分片 | `inIframe`/课堂 ID/回跳地址/挂载点等待/`getDDL`/`dismissPopups` | `UtilsDom` |
| `utils/index.js` | 工具集装配（Utils） | 装配（spread） | 四片合成 `Y.Utils` | `Utils` |
| `storage/store.js` | localStorage 封装、配置读写与启动同步 | 整语句 | `storeSafe`（异常兜底）+ `Store`（进度、AI、倍速、功能开关、跨页恢复、轨迹、面板位置）；加载期回写 `Y.Config.playbackRate` | `storeSafe`、`Store` |
| `player/duration.js` | 播放器时长状态与就绪判定 | 整语句 + 对象分片 | `WeakMap` 记时长稳定 tick；`isDurationStable`/`isNearEnd`/`isDisplayFinished` | `mediaDurationState`、`PlayerDuration` |
| `player/controls.js` | 倍速与静音控制 | 对象分片 | 先点 `xt-speedbutton`/`xt-volumebutton`，再兜底改 media 属性并反复校正 | `PlayerControls` |
| `player/observe.js` | 播放过程中的倍速/静音校正 | 对象分片 | `observePause`：暂停就拉回、倍速被改就重设，返回解绑函数 | `PlayerObserve` |
| `player/index.js` | 播放器装配（Player） | 装配（spread） | 三片合成 `Y.Player` | `Player` |
| `progress/ledger.js` | 平台进度契约与观看区间算术 | 整语句 | 叶子类型文案；`VideoLedger`：`rate` = 已观看区间并集、缺口并集、`MIN_GAP` | `LEAF_KIND`、`VideoLedger` |
| `progress/api.js` | 平台进度接口层（YktApi） | 整语句 | 目录/单节进度/视频 rate/观看日志；TTL 缓存、失败计数、自建请求头（`university-id`/`uv-id`/`x-csrftoken`） | `YktApi` |
| `workspace/media.js` | 学习空间路由与媒体元素定位 | 对象分片 | 路由解析（classroomId/leafId/type）、可见性判定、媒体定位、`normalizeText` | `WorkspaceMedia` |
| `workspace/dom.js` | 学习空间侧栏、练习与讨论 DOM | 对象分片 | 侧栏叶子/活跃标题/练习文档（含 iframe 内文档）/讨论区选择器 | `WorkspaceDom` |
| `workspace/index.js` | 学习空间装配（AiWorkspace） | 装配（spread） | 两片合成 `Y.AiWorkspace` | `AiWorkspace` |
| `panel/visibility.js` | 面板全屏可见性兜底 | 整语句 | `moveBefore` 保状态搬运、全屏内挂载、初始化失败页面提示 | `REPLACED_TAGS`、`moveKeepingState`、`panelHome`、`installPanelVisibility`、`showPanelFailureNotice` |
| `platform/screen-check.js` | 原生事件注册与切屏拦截兼容层 | 整语句 | 保存原始 `addEventListener`；`patchScreenCheck`/`preventScreenCheck` | `nativeAddMap`、`addNativeListener`、`patchScreenCheck`、`preventScreenCheck` |
| `panel/markup.js` | 面板静态模板（HTML/CSS） | 模板 | `PanelMarkup(version)` 返回整段 HTML/CSS 字符串；构建时该模板内的 CSS 注释会被剥掉 | `PanelMarkup` |
| `panel/panel.js` | 面板实例状态与交互（createPanel） | 整语句 | **声明运行期状态 `Y.panel`**；`createPanel()`：iframe + `document.write` + `log/warn/error/track/resetStartButton/celebrate/dismissCelebrate` + `frame` 引用 | `panel`、`createPanel` |
| `solver/question.js` | 题目读取、字体还原与截图 | 对象分片 | 题干清洗、自定义字体还原、`html2canvas` 截图 | `SolverQuestion` |
| `solver/ai.js` | 检索、模型调用与选项提交 | 对象分片 | 检索 + `requestChat`（openai/anthropic 两种格式）+ 点选项 | `SolverAI` |
| `solver/index.js` | 答题装配（Solver） | 装配（spread） | 两片合成 `Y.Solver` | `Solver` |
| `runners/v2/media.js` | v2 视频、音频与批量区处理 | 类 mixin（11 方法） | `handleVideo`/`playAudioItem`/`handleBatch`/`autoCommentItem` 等 | `V2RunnerMediaMixin` |
| `runners/v2/courseware.js` | v2 作业、课堂与课件处理 | 类 mixin（4 方法） | `handleHomework`/`handleClassroom`/`waitCoursewareVideo`/`handleCourseware` | `V2RunnerCoursewareMixin` |
| `runners/v2/runner.js` | v2 刷课主流程（V2Runner） | 类主体 + assign | `class V2Runner`（constructor + 7 方法）：进度归一、500 轮硬上限、目录推进；末尾装配 2 个 mixin | `V2Runner` |
| `runners/legacy.js` | pro/lms 旧版与新版流程 | 整语句（2 个类） | `ProOldRunner` 转发新标签页；`ProNewRunner` 按 `.btn-next` 逐节 | `ProOldRunner`、`ProNewRunner` |
| `runners/workspace/media.js` | 学习空间媒体接管与返回 | 类 mixin（7 方法） | 换源识别（`emptied`/`loadstart`）、父窗口交接、`handleMedia` | `WorkspaceMediaMixin` |
| `runners/workspace/progress.js` | 目录审计与平台记账查询 | 类 mixin（14 方法） | 目录审计、单节进度/观看日志、优先补刷定位、记账判满 | `WorkspaceProgressMixin` |
| `runners/workspace/credit.js` | 观看缺口补刷与记满 | 类 mixin（7 方法） | 缺口播放补齐、整段补看、等「已完成」标记 | `WorkspaceCreditMixin` |
| `runners/workspace/exercise.js` | 练习与讨论处理 | 类 mixin（5 方法） | `solveExerciseQuestion`/`openNextExerciseQuestion`/`advanceExerciseQuestion`/`handleExercise`/`handleForum` | `WorkspaceExerciseMixin` |
| `runners/workspace/runner.js` | 学习空间刷课主流程（AiWorkspaceRunner） | 类主体 + assign | `class AiWorkspaceRunner`（constructor + 35 方法）：侧栏逐节推进、收尾三分支（刷完 / 只剩考试 / 真没刷完）、刷完弹窗；末尾装配 4 个 mixin | `AiWorkspaceRunner` |
| `app/router.js` | 页面路由分发（start） | 整语句 | `start()`：ai-workspace / v2/web / pro/lms 三分支，异常兜底写面板 | `start` |
| `app/bootstrap.js` | 引导启动与面板挂载（boot） | 整语句 | `boot()`：等挂载点、写 `data-ykt-helper`、建面板（`Y.panel = Y.createPanel()`）、跨页自动续跑 | `boot` |

**对外件 vs 内部件**：业务代码只用装配后的 `Y.Utils` / `Y.Player` / `Y.AiWorkspace` / `Y.Solver`；`Y.UtilsTiming`、`Y.UtilsText`、`Y.PlayerDuration`、`*Mixin` 是内部件，只允许 `index.js` 与类主体消费。

---

## 2. 加载顺序规则

构建把 `manifest.modules` **按数组顺序**拼进同一个 `(() => { 'use strict'; const Y = {}; … Y.boot(); })();`，所有模块共享同一个 `Y`。

1. **顺序 = `manifest.modules` 的数组顺序**，与目录名、文件名无关（文件名不带编号前缀）。
2. **拓扑依赖写进 `loadAfter`**，构建会校验「依赖存在，且索引更小」，否则报 `X 必须晚于 Y 加载` / `X 依赖不存在的模块 Y`。当前 8 个模块带 `loadAfter`：
   - `core/config.js` ← `core/constants.js`（`playbackRate` 取 `Y.DEFAULT_PLAYBACK.rate`）
   - `utils/index.js` ← `utils/{timing,text,human-check,dom}.js`
   - `storage/store.js` ← `core/constants.js`、`core/config.js`、`utils/index.js`
   - `player/index.js` ← `player/{duration,controls,observe}.js`
   - `workspace/index.js` ← `workspace/{media,dom}.js`
   - `solver/index.js` ← `solver/{question,ai}.js`
   - `runners/v2/runner.js` ← `runners/v2/{media,courseware}.js`
   - `runners/workspace/runner.js` ← `runners/workspace/{media,progress,credit,exercise}.js`
3. **`core/constants.js` 恒为第一个模块、`core/config.js` 紧随其后**：配置对象要在常量之后构造，其余模块都默认 `Y.Config` 存在。
4. **`storage/store.js` 必须晚于 `core/config.js` 与 `utils/index.js`**：它在加载期执行 `Y.Config.playbackRate = Store.getPlaybackConf().playbackRate;`。
5. **类主体排在它的 mixin 之后**（`Object.assign` 在模块顶层执行，早一行就会拿到 `undefined`）。
6. **`panel/panel.js` 负责声明 `Y.panel`**（`Y.panel = undefined;`），`app/bootstrap.js` 里的 `boot()` 才赋值；两者顺序即 manifest 顺序。
7. **`app/bootstrap.js` 恒为最后一个模块**，`manifest.entry`（`Y.boot();`）由构建外壳追加在所有模块之后；构建另外断言「入口恰好出现 1 次」且「产物里没有顶层 `boot();`」（防重复启动）。
8. **顶层不许读 DOM、不许调用别的模块**：`@run-at document-start`，模块执行时 `documentElement` 可能还不存在；跨模块调用一律放进函数体，等 `Y.boot()` 时才解析（`app/bootstrap.js` 里 `waitForMountTarget()` 的注释就是这条的实测记录）。
9. 模块之间**只经 `Y` 通信**，不要用 `window.xxx`、全局变量或事件总线旁路。

---

## 3. 三种拆分模式

### 3.1 对象分片 + `index.js` 装配

大对象按属性组切成若干分片，`index.js` 只做 spread 合并。四套：`Utils`（4 片）、`Player`（3 片）、`AiWorkspace`（2 片）、`Solver`（2 片）。

```js
// utils/timing.js
((Y) => {
  // 计时、轮询与后台节流
  const UtilsTiming = {
    sleep: (ms = 1000) => new Promise(resolve => setTimeout(resolve, ms)), // 不用 this，可以箭头
    humanPause(min = 900, max = 2400) {                                   // 用 this，必须方法简写
      if (this.isFastMode()) return this.sleep(0);
      …
    }
  };
  Y.UtilsTiming = UtilsTiming;
})(Y);

// utils/index.js
((Y) => {
  // 工具集装配（Utils）
  const Utils = { ...Y.UtilsTiming, ...Y.UtilsText, ...Y.UtilsHumanCheck, ...Y.UtilsDom };
  Y.Utils = Utils;
})(Y);
```

约束：

- **需要 `this` 的成员必须用方法简写**（`foo() {}`）。`this` 在调用时绑定到合并后的对象，所以 `Y.Utils.humanPause()` 里的 `this.sleep` 才拿得到另一个分片里的 `sleep`。
- **不要用箭头函数改 `this`**：`foo: () => this.bar()` 里的 `this` 是模块 IIFE 的词法 `this`，构建加了 `'use strict'`，那里是 `undefined`，一调就 `TypeError`。只有**完全不用 `this`** 的纯函数才可以用箭头（`sleep`、`pctText` 就是）。
- **`index.js` 必须在所有分片之后**（spread 在加载期求值），并在 manifest 里用 `loadAfter` 把这条依赖写成可校验的声明。
- **不同分片不要出现同名键**：后面覆盖前面是静默的。`tools/verify-migration.js` 按属性逐个比对签名，能抓到「少了一个属性」，抓不到「语义被覆盖」。
- **spread 是浅拷贝**：分片里的可变容器（如 `player/controls.js` 的 `speedRequests: new WeakMap()`）合并后与分片引用同一份；不要在 `index.js` 里再 new 一份。

### 3.2 class prototype mixin

class 主体留在 `runner.js`（constructor + 主流程方法），其余方法按功能组切到 mixin 对象，主体文件末尾 `Object.assign(Class.prototype, …)` 装配。

```js
// runners/v2/media.js
((Y) => {
  const V2RunnerMediaMixin = {
    async handleVideo(course) { … this.panel.warn(…) … }   // this = 实例
  };
  Y.V2RunnerMediaMixin = V2RunnerMediaMixin;
})(Y);

// runners/v2/runner.js
((Y) => {
  class V2Runner {
    constructor(panel) { this.panel = panel; … }
    async run() { … }
  }
  Object.assign(V2Runner.prototype, Y.V2RunnerMediaMixin, Y.V2RunnerCoursewareMixin);
  Y.V2Runner = V2Runner;
})(Y);
```

约束：

- **mixin 里只用方法简写**，箭头函数拿不到实例的 `this`。
- **mixin 里不得出现 constructor、`super` 与字段初始化器**：`Object.assign` 只拷自有可枚举属性，class fields 是实例属性，拷不过去。实例状态一律在**主体 constructor** 里初始化（`runners/workspace/runner.js` 的 constructor 把字段与含义逐行注了）。
- **mixin 不要假设别的 mixin 的字段存在**：能通过 `this.xxx` 访问的，只能是主体 constructor 已赋过的字段；可选依赖一律「取不到当没有」（`runners/workspace/progress.js` 顶部注释写了原因：专项测试会把整个类切出来只注入 4 个桩）。
- **顺序**：mixin 文件排在 `runner.js` 之前（manifest 顺序 + `loadAfter`）；`Object.assign` 放类的 `})` 之后、`Y.X = X` 之前。
- 同名方法会被后一个 mixin 覆盖且静默——切分位置只能按方法组边界，不要靠覆盖补丁。

### 3.3 整语句模块

一个文件 = 原文件里的一段完整语句（`const` 对象、若干 `function`、class、模板箭头函数），原样搬运，末尾导出。

```js
// panel/visibility.js
((Y) => {
  const REPLACED_TAGS = new Set([…]);
  function moveKeepingState(node, parent) { … }
  …
  Y.REPLACED_TAGS = REPLACED_TAGS;
  Y.moveKeepingState = moveKeepingState;
})(Y);
```

约束：

- **顶层不许调用别的模块**：`Y.Utils.sleep(0)` 写在顶层会在加载期就执行，此时 `Y.Utils` 可能还不存在。跨模块调用放进函数体。
- **导出写在文件末尾**，与声明顺序一致，便于逐行对照。
- **模板类模块（`panel/markup.js`）改不得格式**：有根目录旧单文件时，`verify-migration` 会把产物里的 `PanelMarkup` 模板与它比对，**按 CSS 注释剥离后逐字相同**（只允许 `${Config.version}` → `${version}`）；多一个空格、少一个换行都算不一致。旧文件已不在仓库里时该工具如实跳过（`dist/migration-parity.json` 里 `skipped: legacy-source-missing`）。
- **整语句模块可以带加载期副作用**，但只允许「自己就能闭环」的那种：`storage/store.js` 用 `storeSafe` 读一次 localStorage 并回写 `Y.Config.playbackRate`；`panel/panel.js` 在顶层声明 `Y.panel = undefined`。

### 3.4 选型速查

| 要搬的东西 | 用哪种 | 判据 |
|---|---|---|
| 一个几百行的大对象（`Utils`/`Player`/`AiWorkspace`/`Solver`） | 对象分片 + `index.js` | 方法互相 `this` 调用，天然共享 `this` |
| 一个几百行的 class | class 主体 + prototype mixin | 有实例状态，mixin 只加方法 |
| 独立函数、常量表、单例对象、模板字符串 | 整语句 | 不参与别的模块的顶层求值 |
| 只做合并的三五行 | `index.js` | 除 spread 外不写逻辑 |

---

## 4. 如何新增 / 修改模块

**修改已有模块**

1. 只改 `src/`，不要碰 `dist/`（构建会覆盖），也不要碰根目录 `雨课堂刷课助手-3.1.32.js`（它是等价校验的基准，见 `docs/模块化-构建说明.md`）。
2. 改动落在既有形态内：分片里加方法用简写；类的新方法放回它所属的 mixin，别塞进 `runner.js` 主体；新工具方法归到 `timing`/`text`/`human-check`/`dom` 对应分片，不要随手新开文件。
3. 跑 `cd tools; npm run build`，再 `npm run verify`（见第 5 节）。

**新增模块**

1. 放到对应领域目录，文件名 kebab-case、不加编号前缀（例：`utils/text.js`、`runners/workspace/credit.js`）。
2. 外壳两行固定：首行 `((Y) => {`，末行 `})(Y);`（构建 trim 后逐字检查）。
3. 导出需要的成员：`Y.X = X;`。
4. 在 `src/manifest.json` 的 `modules` 里插入 `{ "file": "目录/名字.js", "title": "…" }`，**位置就是加载位置**；若它依赖别的模块（装配、类主体、或加载期读 `Y.X`），补 `"loadAfter": ["…"]`。
5. **不得引入新的未解析全局名**：`verify-migration` 会把产物的全局 `through` 引用与旧单文件比对，多出一个裸标识符（直接写 `VideoLedger` 而不是 `Y.VideoLedger`）就报「产物出现新的未解析标识符」。
6. 新功能（非搬运）不需要改 `tools/module-plan.json`（只有 `npm run migrate` 读它）；但要在 `docs/` 留一份改动说明。

---

## 5. 构建与校验命令

都在 `tools/` 目录执行（脚本内部用 `__dirname` 推路径，与 cwd 无关）：

```powershell
cd tools        # 在仓库根目录执行

npm run build     # = node build-userscript.js → dist/雨课堂刷课助手-3.6.4.user.js + dist/build-report.json
npm run verify    # = node verify-migration.js  → dist/migration-parity.json（与根旧单文件做等价校验）
npm run migrate   # = node migrate-to-modules.js → 仅溯源/灾后重建，日常不要跑（会覆盖 src/）
```

- 缺依赖时才需要装：`cd tools; npm install`（`acorn`、`eslint-scope`；`tools/node_modules/` 被 `.gitignore` 忽略）。
- 两个脚本任一失败都以退出码 `1` 结束，原因打到 stderr；构建失败时**不要**继续发布产物。
- 行为回归在 `verify/`，跑法见 `verify/README.md` 的「跑法」一节。

**构建断言清单**（`npm run build` 不通过就是这些之一）

| 断言 | 失败文案 | 含义 / 修法 |
|---|---|---|
| 模块外壳 | `X 缺少模块外壳开头/收尾` | 首行不是 `((Y) => {` 或末行不是 `})(Y);`；补外壳，别在模块里再套一层 IIFE |
| 语法 | `语法检查失败` | `node --check` 没过，按 stderr 行号修 |
| 注释清零 | `产物里仍残留注释 token` | 剥注释没生效（多出现在 token 化误判） |
| 头部 | `产物头部与 userscript.header.txt 不一致` | 头部文件被改，或产物不是从 header 起 |
| 外壳完整性 | `产物缺少命名空间初始化` / `产物缺少 IIFE 收尾` | 外层包裹被动过 |
| 入口 | `产物缺少入口调用` / `入口 Y.boot(); 出现 N 次` / `产物里仍有顶层 boot() 直接调用` | 入口只在 manifest 里声明一次，模块里不要自己调 `boot()` |
| 命名空间 | `引用了没有导出到 Y 的成员` | 用了 `Y.X` 但没人写过 `Y.X =`；补导出或改回已有成员 |
| 剥注释无损 | `剥注释/清理改动了代码 token` | JS 注释剥离与行尾空白/空行归一化不得改动任何代码 token；说明某段代码被剥离逻辑误伤 |
| 加载顺序 | `模块加载顺序不满足依赖` / `依赖不存在的模块` | 调 manifest 顺序，或修 `loadAfter` |
| 版本一致 | `Config.version（x）与 manifest.version（y）不一致` | 面板标题显示的是 `Config.version`；升版本时两处要一起改（3.6.1 漏改过，面板显示旧版本） |

`npm run verify` 的失败文案：`产物出现新的未解析标识符`、`产物丢失了原本的未解析标识符`、`产物中找不到这些原始单元`、`产物里找不到 PanelMarkup 模板`、`面板模板内容与源码不一致`、`UserScript 头与源文件不一致`。

---

## 6. 注释策略

- **源码保留注释，而且是资产**：`src/` 里的中文注释（含 `panel/markup.js` 模板里的 CSS 注释）记的是「为什么这么写、踩过什么坑、抓包/实测证据」，改动时顺手维护，不要删。
- **产物删注释，两层都删**：
  1. **JS 注释**：拼装后用 acorn 的 `onComment` 回调拿到所有注释区间再剔除（`tools/build-userscript.js` 的 `stripComments`），不是正则替换——字符串、模板字符串、正则字面量里的 `//`、`/*` 不会被误删；
  2. **模板里的 CSS 注释**：拼装前对 `panel/markup.js` 单独处理（`stripTemplateCssComments`）：用 acorn 定位模板字面量节点，只在它的区间内、且不在 CSS 引号字符串中的 `/* … */` 才剥掉，按注释里的换行数补空行。所以产物里 `/* 面板骨架 */`、`/* 最小化气泡 */` 这类 CSS 注释不会出现。
- **产物里还能 grep 到 `/*` 的只剩字符串内容**（实测 4 行）：头部两条 `@match *://*.yuketang.cn/*` / `@match *://*.gdufemooc.cn/*`、`Accept: 'application/json, text/plain, */*'`、日志文案 `应匹配 */v2/web/*、*/pro/lms/*`。
- **无损性有断言兜底**：JS 注释剥离 + 行尾空白/连续空行清理完之后，产物与拼装草稿的非注释 token 序列必须逐字一致（`checks.tokenDrift` 为 `null`），否则构建失败——保证「删的只有注释和空白」；CSS 注释剥离发生在拼装前、只作用于模板串内部，不参与这条 token 比对。
- **产物只保留 UserScript 头**：`src/userscript.header.txt` 原样放最前面（23 行 `//`），其后的 body 注释 token 数必须为 `0`（`dist/build-report.json` 的 `checks.commentsLeft`）。
- 想给产物留说明，就写进 `@description` 或面板文案，不要指望源码注释出现在产物里。
