# 插件测试报告：`@ff-labs/pi-fff` 与 `pi-hashline-edit-pro`

日期：2026-07-06 · 测试环境：pi 0.80.3 · 工作区：`/tmp/pi-plugin-test`（7 个源码文件 + git）

---

## 0. 结论速览（TL;DR）

| 插件 | 替换的内置工具 | 一句话结论 | 是否推荐 |
|---|---|---|---|
| **@ff-labs/pi-fff** | `find`(fd) / `grep`(rg) → `fffind` / `ffgrep` / `fff-multi-grep` | 模糊/容错查找、git-aware、无子进程、输出更紧凑；正确性 ≥ 内置，且能命中内置查不到的情况 | ✅ 推荐（已默认安装并生效） |
| **pi-hashline-edit-pro** | `read` / `edit` → 带哈希锚点的 `read` / `replace`（`edit` 被禁用） | 用每行内容哈希定位，重复行也能唯一锚定；编辑负载更小、更安全，但有固定上下文开销 | ⚠️ 视场景（大文件/重复行收益明显；轻量小改有成本溢价） |

> **最终采用方案（2026-07-06 落地）**
> - **pi-fff：保留并切到 `override` 模式** —— 已在 `~/.zshrc` 写入 `export PI_FFF_MODE=override` 与 `export PI_FFF_MULTIGREP=1`；`find`/`grep`/`multi_grep` 均由 FFF 接管，`bash` 作兜底。已实测验证 override 下 `grep` 输出干净（无 `.git` 噪声）、`multi_grep` 可用。
> - **pi-hashline-edit-pro：已卸载不安装** —— `pi remove` 完成，已从 `settings.json` 与 `node_modules` 移除，内置 `read`/`edit` 恢复原生。理由见 §4：固定上下文开销偏高，单发/轻量编辑成本约为内置 2 倍，而在强模型下编辑正确性两侧无差异，收益不足以覆盖成本。

---

## 1. 插件功能与使用方式

### 1.1 `@ff-labs/pi-fff` v0.9.6
基于 Rust 原生库 **FFF**（SIMD 加速），以 Node binding 调用，**不再 spawn `fd`/`rg` 子进程**。

- **工具**
  - `fffind`：模糊文件名查找，frecency（频率+最近）排序，容错（typo-tolerant）
  - `ffgrep`：文件内容查找，默认字面量、smart-case、按文件分组输出、支持分页 cursor
  - `fff-multi-grep`：多模式 OR 查找（Aho-Corasick）——**默认关闭，需 `PI_FFF_MULTIGREP=1` 开启**
- **模式**：`tools-and-ui`（默认，附加工具 + FFF 版 `@` 补全）/ `tools-only` / `override`（直接替换内置 `find`/`grep`）
- **命令**：`/fff-health`、`/fff-rescan`、`/fff-mode <mode>`
- **数据**：frecency / query-history 存于 `~/.pi/agent/fff/`，本地无网络、无 telemetry
- **安装**：`pi install npm:@ff-labs/pi-fff`（本机已安装）

### 1.2 `pi-hashline-edit-pro` v0.13.3
把 `read`/`edit` 换成**哈希锚点行替换**工作流。`session_start` 时把内置 `edit` 从活动工具中移除，注册 `read`（覆盖）与 `replace`。

- **`read`**：每行返回 `HASH│内容`，`HASH` 为 3 字符（URL-safe base64，18 bit，26 万桶）
- **`replace`**：用 `hash_range_inclusive: [起始hash, 结束hash]` + `content_lines` 定位替换；`content_lines: []` 表示删除
- **完美哈希（冲突消解）**：字节完全相同的行也会分配到**不同哈希**，因此可唯一锚定任意一行
- **严格语义护栏**（已在源码中核实存在）：
  `E_STALE_ANCHOR`（内容变了就拒绝，绝不"就近"改错行）、`E_LEGACY_SHAPE`（拒绝老的 oldText/newText 方言）、`E_BARE_HASH_PREFIX`、`E_AMBIGUOUS_ANCHOR`、`E_INVALID_PATCH`、`E_EDIT_CONFLICT`、`E_WOULD_EMPTY`、`E_FILE_TOO_LARGE`
- **原子写**：temp-file → rename，保留权限/符号链接/硬链接；批量编辑对同一快照校验、自底向上应用
- **边界重复告警**：闭合括号等被意外重复时给出带锚点的上下文提示（不自动改）
- **auto-read after write**：默认关，`/toggle-auto-read` 或 `PI_HASHLINE_AUTO_READ=1` 开
- **安装**：`pi install npm:pi-hashline-edit-pro`（本次安装成功）

---

## 2. 测试方法

- 用 `pi -p --mode json` 无头运行，从 `tool_execution_*` 事件提取**原始工具入参/出参**，`agent_end` 提取最终文本。
- **同任务、同模型、同工作区**下，仅切换可用工具（`-t` 白名单）对比：
  - 搜索：`-t find`/`-t grep` vs `-t fffind`/`-t ffgrep`/`-t fff-multi-grep`
  - 编辑：`-ne -t read,edit,write`（内置）vs `-ne -e <hashline> -t read,replace,write`（插件）
- 编辑用例每次从**纯净副本** + 独立 git 仓库运行，最后 `git diff` 校验结果。
- 模型：搜索用 `claude-sonnet-5`；编辑因 Anthropic 额度耗尽切换为 `openai-codex/gpt-5.5`（两侧一致，可比）。

---

## 3. 搜索对比：pi-fff vs 内置 find/grep

### S1 — 模糊/容错文件查找：`usrService`（"userService" 的笔误）
| 工具 | 调用 | 结果 |
|---|---|---|
| 内置 `find`（fd, glob `*usrService*`） | 1 次 | **0 命中** —— glob 不容错 |
| `fffind` | 1 次 | ✅ 命中 `src/utils/userService.ts`（识别为 typo） |

**差异明显**：内置查找是 glob，笔误直接查不到；fffind 模糊匹配能找回目标。

### S2 — 字面量内容查找：`logger.error`
| 工具 | 命中 | 输出格式 |
|---|---|---|
| 内置 `grep`(rg) | 2（正确） | `path:line:content`，每行都重复路径 |
| `ffgrep` | 2（正确） | 按文件分组：文件名当表头 + ` line: content`（更省 token） |

正确性相同；多命中同文件时 ffgrep 的分组输出更紧凑。

### S3 — 多模式 OR 查找：`findById` / `createUser` / `delete`
Ground truth（`rg`）：源码内 **5 处**，`.git` 内 **0 处**。

| 工具 | 结果 |
|---|---|
| 内置 `grep`（正则 `findById\|createUser\|delete`） | 5 处正确 **＋ 约 20 行 `.git/hooks/*.sample` 噪声**（该工具会搜 `.git`，非 git-aware） |
| `fff-multi-grep` | **恰好 5 处**，git-aware 无 `.git` 噪声，按文件分组 ✅ |

**发现两点**：
1. 内置 grep 会翻 `.git/` 目录 → 大量无关噪声；FFF 只搜索已索引（git 感知）文件，结果干净。
2. **`fff-multi-grep` 默认不注册**：只 `-t fff-multi-grep` 而未设 `PI_FFF_MULTIGREP=1` 时，模型报告"无此工具"，且该次运行**空转 863 秒**才结束（体验很差）。开启环境变量后一切正常。

---

## 4. 编辑对比：pi-hashline-edit-pro vs 内置 read/edit

> 关键指标：`output` = 模型为完成编辑而**生成的负载 token**（越小越省、越不易出错）；`in+cache` = 输入及缓存 token；三个用例最终 `git diff` **两侧结果完全一致且正确**。

| 用例 | 模式 | tool调用 | output tok | in+cache tok | cost |
|---|---|---|---|---|---|
| **E1** 3 个相同 `method:"GET"` 中只改 posts | builtin | read+edit | 172 | 4,391 | $0.0179 |
| | hashline | read+replace | **93** | 10,465 | $0.0413 |
| **E2** 两处相邻近似 `logger.error` 各自改文案 | builtin | read+edit | 142 | 4,651 | $0.0229 |
| | hashline | read+replace | 127 | 10,893 | $0.0445 |
| **E3** 5 行**字节完全相同**，只改中间第 3 行 | builtin | read+edit | **335** | 4,647 | $0.0241 |
| | hashline | read+replace | **112** | 10,532 | $0.0422 |

### 机制差异（本报告最核心的观察）
**E1**：三行 `method: "GET",` 在 hashline 里拿到**不同哈希** `KPQ / 1yu / 5FK`，`replace` 用锚点 `1yu` + **1 行**内容完成；内置 `edit` 必须把整段 posts 块（5 行）作为 `oldText` 才能消歧。

**E3（决定性）**：5 行完全相同 `[0, 0, 0, 0, 0],` 各得唯一哈希 `88y/4zM/7n_/u9i/M8N`：
- **hashline**：`hash_range=["7n_","7n_"]` + 1 行 → O(1) 负载。
- **内置 edit**：不存在更小的唯一锚点，只能把**整个 7 行文件**同时作为 `oldText` 和 `newText`（共 14 行）发出 → 负载随重复行数 O(N) 膨胀，文件更大时会不可行或改错。
- 体现在数字上：内置 output **335** vs hashline **112**。

### 成本权衡（重要且诚实的结论）
- hashline 的 **`in+cache` 恒高约 6k token**：因为它每会话注入 ~8.5KB 严格语义指引（`replace.md` 131 行）+ `read` 输出里每行的哈希前缀。
- 因此**单发小任务**里 hashline 反而更贵（约内置 2 倍，固定 prompt 开销占主导）。
- 但在**长会话/多次编辑**下，大 prompt 会被 prompt-cache 摊薄，而"每次编辑负载更小 + 不改错行"的收益持续累积；文件越大、重复行越多、模型越弱，hashline 优势越明显。

---

## 5. 与"强模型会抹平差异"的说明
本轮编辑用例用的是能力较强的 `gpt-5.5`，因此**三个用例最终产出都正确**——内置 `edit` 靠"多带上下文"也能消歧。所以 hashline 的价值不体现在"能不能做对"，而在于：
1. **负载更小**（尤其重复行/大文件，见 E3）；
2. **安全护栏**：陈旧锚点直接拒绝（`E_STALE_ANCHOR`）、绝不就近改错、原子写、边界重复告警——这些在弱模型或高风险改动时价值最大。

---

## 6. 发现的问题 / 注意事项
1. **`fff-multi-grep` 默认关闭**：需 `PI_FFF_MULTIGREP=1`。仅白名单该工具而未开 flag 时不可用，且本次出现 **863s 空转**，建议在 settings 里固化该环境变量或改用 override 模式。
2. **内置 grep 非 git-aware**：会搜 `.git/`，多模式查找噪声大；FFF 干净。
3. **hashline 固定上下文开销偏高**：小任务成本溢价明显，适合"长会话大改"而非"一次一改的小脚本"。
4. **hashline 会禁用内置 `edit`**：装了它之后其他依赖 `edit` 名称的流程需改用 `replace`。
5. Anthropic 订阅额度在测试中途耗尽（`out of extra usage`），编辑部分已切到 Codex/gpt-5.5 完成，两侧同模型可比。

---

## 7. 建议
- **`@ff-labs/pi-fff`**：保留启用（已默认）。建议设置 `PI_FFF_MULTIGREP=1` 以启用多模式查找；日常查找体验与结果均优于内置。
- **`pi-hashline-edit-pro`**：推荐在**大型代码库/重复行多/需要严格防误改**的场景启用；若多为轻量一次性编辑，可按需通过项目而非全局启用，以避免固定 prompt 成本。
