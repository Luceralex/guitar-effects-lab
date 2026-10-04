# Plan: Mentor 品牌与工作区改版

| Field | Value |
|-------|-------|
| Status | complete |
| Created | 2026-10-04 |
| Ticket | N/A |
| Branch | main |

## Context

原界面把音源、试听键盘、五种图表和八个效果器同时摊开，练琴与调音色的主要路径不清晰。
用户希望以 Anthropic 的克制排版和 OpenAI 的白色空间感为参考，将产品命名为 Mentor，
使吉他效果器和曲谱弹奏助手成为主体。

## Architecture Decisions

- 保留现有控件 ID 和 Web Audio 链路；重新组合 HTML 与 CSS，避免音频行为回归。
- 默认打开弹奏助手；音色机架与分析图表成为独立工作区，实验视图继续可用。
- Logo 使用可缩放 SVG：M 采用音符笔画，后续字母置于五线谱上；提供 PNG 与 Windows 图标导出。
- 参考站点仅用于视觉方向，页面结构、字标和文案均独立设计。

## Milestones Overview

1. **清楚的品牌入口** — 打开页面即可辨认 Mentor，并直接找到练琴入口。
2. **专注的工作区** — 用户在弹奏、调音色、分析之间切换，音源与监听始终可见。
3. **可运行的发布版本** — 本地、在线和 Windows 启动入口均能加载新资源。

---

## Milestone 1: 清楚的品牌入口

**Why this matters:** 新用户需要第一眼理解产品用途，而不是先读实验图表。

**Success criteria:** Logo、产品名称、主标题和主要动作在首屏可见。

**Key decisions:** 白底、深色排版、节制的陶土色强调；字标由本项目自有 SVG 构成。

### Deliverable Spec

| UI | Action | Result |
|----|--------|--------|
| Mentor 字标 | 浏览页面或下载资源 | 清楚显示音乐化 M 和五线谱文字 |
| 首屏入口 | 载入乐谱 / 连接吉他 | 进入现有曲谱或输入流程 |

### 1.1 [x] 品牌资源与首屏布局 *(completed 2026-10-04)*
- **Files:** `assets/*`, `index.html`, `css/style.css`, `README.md`
- **What:** 建立字标、图标和以弹奏为默认的首屏。
- **Acceptance:** SVG 有效、桌面与窄屏均有可见主导航。
- **Dependencies:** None

## Milestone 2: 专注的工作区

**Why this matters:** 演奏者能专心看谱，调音色时能看清每个参数，分析图按需打开。

**Success criteria:** 三个工作区可切换，原有输入、监听、谱面和机架行为继续工作。

**Key decisions:** 共用音频卡片保留在所有工作区；内置键盘折叠；理论说明收进帮助弹窗。

### Deliverable Spec

| 工作区 | 主要内容 | 次要内容 |
|--------|----------|----------|
| 弹奏助手 | 曲谱与指板 | 练习读数 |
| 音色工作台 | 预设与效果器机架 | 输入与监听 |
| 音频分析 | 频谱、波形、频谱图 | 本地深度分析 |

### 2.1 [x] 分离工作区并保持控件联动 *(completed 2026-10-04)*
- **Files:** `index.html`, `css/style.css`, `js/ui.js`, `js/fretboard.js`
- **What:** 工作区导航、卡片布局、谱面阅读顺序与移动适配。
- **Acceptance:** 音频控件 ID 唯一，导航切换和试听/分析入口正确。
- **Dependencies:** 1.1

## Milestone 3: 可运行的发布版本

**Why this matters:** 用户和开源体验者需要能直接打开新版，而不是只看到设计文件。

**Success criteria:** 本地和 GitHub Pages 页面、Logo 与脚本均正常加载。

### Before/After

原启动与快捷方式使用旧实验室名称；改版后有 Mentor 启动入口与专用图标。

### 3.1 [x] 验证并发布 *(completed 2026-10-04)*
- **Files:** `server.py`, `make-shortcut.ps1`, `启动 Mentor.bat`, `tests/layout.test.cjs`
- **What:** 本地静态资源路由、测试、启动快捷方式与线上资源验证。
- **Acceptance:** 自动化测试通过，Git 工作区干净，公开页面载入新版资源。
- **Dependencies:** 2.1

**验收记录：** `npm test` 16 项通过，JS 语法、CSS 解析及 Python 编译通过；本地
8765 首页、字标、图标和脚本均返回 HTTP 200。桌面 `Mentor.lnk` 指向新启动脚本并使用
品牌图标。GitHub Pages 对提交 `f3e2c64` 的构建成功，在线首页、字标、样式和脚本均返回
HTTP 200。真实设备手感与各浏览器外观仍需用户在本机查看。
