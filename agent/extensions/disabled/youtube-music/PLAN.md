# pi 扩展：youtube-music（以 involvex/youtube-music-cli 为后端引擎）

> ✅ 已实现（M0–M5 全部完成）。使用见 README.md。下面是原始设计计划，保留备查。
> 实测关键修复：① 引擎 WS 必须连 `--web-host 127.0.0.1`（默认绑 IPv6 ::1 连不上）；
> ② 认证只能用 `.youtube.com` cookie（混入 google.com 会被判未登录）；
> ③ 自动挑选含 `LOGIN_INFO` 的浏览器 profile；④ 退出时按 mpv socket 名杀掉 mpv（daemon 用 detached spawn，杀进程组杀不掉）。


> 目标：在 pi agent 的 TUI 中**展示登录用户的私人歌单并播放**，播放/控制交给
> `@involvex/youtube-music-cli` 后端引擎；支持**点赞**；顶部**常驻一块"正在播放"区域**，
> 并可用**快捷键切换全屏 TUI**。**本期不做搜索。**

## 已锁定的需求决策
- 歌单范围：**私人歌单**（Liked Music / 自建 / 收藏）→ 需 cookie 认证。
- 数据层：**混合**（youtubei.js 取数据 + involvex WS 控播放）。
- 功能范围：展示 + 基本播放控制 + **点赞**；**不做搜索**。
- UI：顶部**置顶 now-playing 区**（常驻）+ **快捷键唤出全屏 TUI**。

---

## 0. 后端引擎 involvex/youtube-music-cli 内部如何工作（调研结论）

技术栈：TS + React + Ink（Bun，兼容 Node ≥16）。入口 `source/cli.tsx`(meow) → `source/app.tsx`(Ink)。

- **数据层** `source/services/youtube-music/api.ts`：基于 **youtubei.js** `Innertube`，
  `getMusicService()` 暴露 `getPlaylist(id)→{name,tracks[]}`、`search()`、`getTrack()`、
  `getStreamUrl()` 等。**注意：初始化是匿名 `Innertube.create()`，拿不到私人库** → 我们自己另起认证客户端。
- **播放层** `source/services/player/player.service.ts`：spawn `mpv --idle=yes
  --input-ipc-server=/tmp/mpvsocket-<pid>-..`，URL 走 IPC `["loadfile",url]`，控制用
  `["set_property","pause"/"volume"/"speed",..]`，`observe_property` 推 time-pos/duration/eof，yt-dlp 出声。
  socket 绑定 PID → **单进程内部状态，不能跨进程当远程控制**。
- **三种入口**：交互 TUI（默认）/ CLI 子命令（非远程控制，`playlist <id>` 是"播第一首"而非列歌单）/
  **`--web-only` WebSocket 服务（唯一可控 daemon）**。

### ⭐ 集成接口：WebSocket 控制服务
- 启动：`youtube-music-cli --web-only --web-port <p> [--web-auth <token>]`
- 端点：`ws://<host>:<port>/ws`；认证：`Authorization: Bearer <token>` 头或 `?token=`；连后服务端先回 `{type:'auth',success:true}`
- **Client→Server**：`{type:'command', action:{type:'PLAY'|'PAUSE'|'RESUME'|'STOP'|'NEXT'|'PREVIOUS'|'SEEK'|'SET_VOLUME'|'TOGGLE_SHUFFLE'|'TOGGLE_REPEAT'|'SET_QUEUE'|'ADD_TO_QUEUE'|'SET_QUEUE_POSITION'|'SET_SPEED'|...}}`
- **Server→Client**：`{type:'state-update', state}`（currentTrack/queue/queuePosition/progress/volume/shuffle/repeat）、`{type:'error'}` 等

---

## 1. 认证与私人数据（youtubei.js，自管认证客户端）

```ts
import {Innertube} from 'youtubei.js';
// cookie 复用 pi-web-access/chrome-cookies.ts 从本地 Chrome 抓 music.youtube.com
const yt = await Innertube.create({ cookie });   // 需含 SAPISID/__Secure-3PAPISID/SID/HSID/SSID/LOGIN_INFO

await yt.getLibrary();                  // 用户库总览
await yt.music.getPlaylist('FEmusic_liked_playlists'); // 自建/收藏歌单列表
await yt.music.getPlaylist('VLLM');     // Liked Songs
await yt.music.getPlaylist('VL'+id);    // 某歌单全部曲目（展示主数据）
// 点赞：like/like 端点，target.video_id，需 SAPISIDHASH（同一认证客户端即可）
await yt.session.actions.execute('/like/like', {target:{videoId}}); // removelike/dislike 同理
```
> cookie 抓取走 incognito 登录更稳（避免轮换）；失效时 UI 给出"重新登录"提示。

---

## 2. 推荐架构（混合）

```
┌──────────────── pi agent TUI ────────────────┐
│  扩展 youtube-music/                          │
│   顶部常驻条 setWidget ──► ♪ 正在播放 + 进度    │   ← 始终可见
│        ▲ state-update                         │
│   快捷键(Ctrl+Y) ──► ctx.ui.custom() 全屏 TUI  │   ← 唤出/收起
│        │  顶部: now-playing header            │
│        │  中部: 歌单曲目列表(↑↓/Enter/L 点赞)  │
│   ┌─ data.ts (认证 youtubei.js) ─┐  ┌─ engine.ts (WS) ─┐
│   │ 私人歌单/曲目 + 点赞           │  │ 控播放+实时状态    │
│   └───────────────┬──────────────┘  └────────┬─────────┘
└───────────────────┼──────────────────────────┼──────────┘
                    ▼ (展示+点赞)                ▼ (播放/控制)
              youtubei.js(带cookie)      youtube-music-cli --web-only ← 后端引擎
                                              └─ mpv + yt-dlp 出声
```
- 播放/控制/实时状态全复用 involvex 引擎（自己不碰 mpv）= "involvex 当后端"。
- 私人歌单展示 + 点赞走自管认证 youtubei.js（WS 无列歌单/点赞接口）。

---

## 3. 文件结构（对标已有 twitter-statusline 扩展）

```
~/.pi/agent/extensions/youtube-music/
├── package.json        # 依赖 youtubei.js、ws
├── PLAN.md / README.md
├── index.ts            # 接线：快捷键、常驻条、daemon 生命周期、命令
├── auth.ts             # 抓 Chrome cookie → 创建认证 Innertube（含失效处理）
├── data.ts             # 私人歌单列表 / 歌单曲目 / 点赞(like-remove)
├── engine.ts           # 拉起 --web-only daemon + WS 客户端 + 自动重连
├── fullscreen-view.ts  # ctx.ui.custom() 全屏：顶部 now-playing + 曲目列表
├── nowplaying.ts       # setWidget()：顶部常驻"正在播放"条
├── render.ts           # 宽度自适应：曲目行/进度条/点赞图标
└── config.ts           # 端口/token/默认歌单/收藏 等
```
对应关系：`fullscreen-view.ts`↔browser.ts、`nowplaying.ts`↔preview.ts、`engine.ts+data.ts`↔twitter-cli.ts。

---

## 4. UI 设计（满足"顶部置顶 + 快捷键全屏"）

**(a) 常驻 now-playing 条**（`ctx.ui.setWidget('ytm', ...)`，editor 上方常驻）：
```
  ♪ Midnight City — M83   ▶ 1:23 / 4:03  ▮▮▮▯▯  🔊70  ♥   (⌘⇧Y 全屏)
```
**(b) 快捷键全屏**（`pi.registerShortcut('cmd+shift+y', …)` → `ctx.ui.custom()`）：
```
┌─ YouTube Music ─────────────────────────────────────────┐
│ ♪ Midnight City — M83      ▶ 1:23/4:03  ▮▮▮▯▯  🔊70  ♥   │ ← 顶部置顶 header
├─────────────────────────────────────────────────────────┤
│ Liked Songs  (128)                                       │
│  ▸ 01  Midnight City        M83            4:03   ♥      │ ← ↑↓ 选择
│    02  Instant Crush        Daft Punk      5:37         │
│    03  …                                                 │
├─────────────────────────────────────────────────────────┤
│ ↑↓ 选择  Enter 播放  Space 暂停  n/p 切歌  L 点赞  Esc 退出 │
└─────────────────────────────────────────────────────────┘
```
全屏内快捷键：`↑↓/jk` 导航 · `Enter` 播放选中 · `Space` 播放/暂停 · `n/p` 下/上一首 · `L` 点赞当前选中 · `Esc` 收起。

---

## 5. 分阶段实施计划（里程碑）

- **M0 · 环境 & 认证打通**
  - 装 `mpv`、`yt-dlp`、`npm i -g @involvex/youtube-music-cli`；扩展目录 `npm i youtubei.js ws`。
  - `auth.ts`：抓 Chrome cookie → `Innertube.create({cookie})`，验证 `yt.getLibrary()` 能返回私人数据。
- **M1 · 私人歌单展示**（最小可用）
  - `data.ts`：列出 `FEmusic_liked_playlists` + `VLLM`；选中后 `getPlaylist(VL+id)` 拿曲目。
  - `fullscreen-view.ts`：全屏列表 + ↑↓ 导航 + Esc。验收：能看到自己的私人歌单与曲目。
- **M2 · 接引擎播放**
  - `engine.ts`：拉起 `--web-only` daemon + WS + 自动重连；Enter → `SET_QUEUE`/`SET_QUEUE_POSITION`/`PLAY`。
  - 验收：选曲出声，`Space`/`n`/`p` 可控。
- **M3 · 顶部常驻条 + 快捷键全屏**
  - 订阅 `state-update` → `setWidget` 常驻条；`registerShortcut('cmd+shift+y')` 唤出/收起全屏；全屏顶部渲染 now-playing header。
- **M4 · 点赞**
  - `L` 键 → `data.ts` 调 `like/like`（或 removelike 取消）；UI 即时回显 ♥；失败兜底提示。
- **M5 · 打磨**
  - daemon 生命周期（`session_shutdown` 关进程、崩溃重启、端口回退）；cookie 失效提示；错误不抛进会话（best-effort）。

---

## 6. 风险与对策
| # | 风险 | 对策 |
|---|------|------|
| R1 | cookie 失效/轮换导致私人数据 401 | incognito 抓 cookie；缓存并探测，失效时 UI 提示重抓；只读降级 |
| R2 | youtubei.js 私有 API 变动 | 锁版本；`data.ts` 收口解析；解析失败容错 |
| R3 | involvex WS schema 变动 | `engine.ts` 单一适配层；锁 involvex 版本 |
| R4 | daemon 生命周期/端口占用 | 启动幂等 + 随机端口 + 健康检查 + 退出清理 |
| R5 | 缺 mpv/yt-dlp/CLI | 启动探测，缺失给安装提示，降级"只展示不播放" |
| R6 | 点赞写操作风险（误点/限频） | 操作前确认可选；失败回滚 UI 状态 |

## 7. 验收标准（DoD）
1. 全屏 TUI 能列出**我的私人歌单**及其曲目，↑↓ 可导航。
2. Enter 选中经 involvex 引擎**实际出声**，Space/n/p 可控。
3. 顶部**常驻条实时**显示正在播放 + 进度；⌘⇧Y 可切全屏。
4. `L` 能对曲目**点赞/取消**并即时回显。
5. cookie 失效或引擎异常不致 pi 会话崩溃；退出 pi 时 daemon 被清理。

> 本期范围不含：搜索、导入、歌词、Discord RPC（均为后续可选）。
