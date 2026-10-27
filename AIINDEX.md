# AIINDEX — 代码索引（给 AI 代理 / 新接手的人）

> 人类使用者请读 [README.md](README.md)。本文件只回答三件事：**在哪、为什么这样、什么不能碰**。
> 改代码时同步改这里对应的一行，不要把它写成第二份 README。

## 0. 一句话定位

一个 VS Code 扩展：向宿主注册 `LanguageModelChatProvider`（vendor `custommodel`），把任意 **OpenAI 兼容**端点接进 Copilot Chat 与 Agents 窗口。**一组模型 = Base URL + 显示别名 + 真实 model id + API Key**，可并存多组，全部存在本机用户级凭据存储里。

## 1. 事实速查

| 项 | 值 |
| --- | --- |
| 版本 | `package.json` → `version`（当前 0.1.0；未发布，每次打包前手动递增） |
| 引擎 | `^1.109.0`（Agents 窗口相关 API 需要） |
| 激活 | `onStartupFinished` → `src/extension.ts` `activate()` |
| 入口产物 | `out/extension.js`（`tsc -p ./`，ES2022 / Node16 / strict） |
| Provider vendor | `custommodel`（必须与 `contributes.languageModelChatProviders[].vendor` 一致） |
| 自有设置项 | **1 个**：`customModel.modelList`（只读镜像，扩展写、从不读回） |
| 编译期依赖 | 只有 `vscode` / `fs` / `path` / `crypto`；无运行时 npm 依赖 |
| 验证门槛 | `npm run verify`（compile + i18n:check + smoke） |
| 打包 | `npm run package` 或 `./scripts/dev-install.sh`（打包 + `--install-extension --force`），之后必须 Reload Window |

**别读**：`node_modules/`、`out/`（编译产物与其 sourcemap）、`package-lock.json`。

## 2. 目录地图

| 路径 | 作用 |
| --- | --- |
| `src/` | 全部源码（17 个模块，约 5100 行），编译到 `out/` |
| `l10n/bundle.l10n.zh-cn.json` | 运行期文案（`vscode.l10n.t` 的中文译文） |
| `package.nls.json` / `package.nls.zh-cn.json` | 清单文案（`package.json` 里的 `%key%`） |
| `scripts/i18n-check.js` | 国际化硬门槛（`npm run i18n:check`） |
| `scripts/smoke.js` | 用 `vscode` stub 跑的纯逻辑测试（无宿主） |
| `scripts/dev-install.sh` | 打包 + 本机安装（macOS，自动找 `code` CLI） |
| `.vscodeignore` | 打包排除清单（`src`、`scripts`、`*.map`、`.workbuddy`、`*.vsix`） |
| `.workbuddy/memory/` | 历次改动的决策记录（含「当时为什么这么改」），排查历史问题时值得先读 |

## 3. 模块索引

| 文件 | 行 | 职责 | 关键导出 |
| --- | --- | --- | --- |
| `extension.ts` | 212 | 激活编排：建 store → 挂设置镜像 → 修宿主槽位 → 注册 provider → 跨窗口监听 → Agents 默认值 → 命令（4 个）→ 一次性提示 | `activate` / `deactivate` |
| `provider.ts` | 982 | Provider 实现：模型发现（含**双通道声明**：`configurationSchema` 给 VS Code picker，`supportsReasoningEffort`/`defaultReasoningEffort` 给 Copilot）、请求主循环、400 阶梯、上下文溢出分支、诊断日志（只写文件，无打开入口） | `registerModelProvider` `notifyProviderChanged` `setDiagnosticLogDir` |
| `config.ts` | 483 | **形状与派生**：`Profile`、`parseProfile`、内置限额预设链、picker id 编解码、思考强度档位、输出通道 | `MODEL_PROVIDER_VENDOR` `STATE_KEYS` `detectModelPreset` `resolveProfileEntry` `realInputCeiling` `summaryInputTokens` `tokenWindowLabel` `summaryWindowLabel` `THINKING_EFFORTS` `DEFAULT_THINKING_EFFORT` `resolveThinkingEffort` `thinkingEffortParam` `encodePickerId` `decodePickerId` `modelOutput` `readProfileApiKey` `writeProfileApiKey` |
| `profileStore.ts` | 262 | **唯一真相源**：模型组列表（SecretStorage `customModel.profiles.v2`）+ 同步缓存 + 跨窗口 reload + 限额覆写 | `initProfileStore` `readProfiles` `readProfile` `firstProfile` `writeProfiles` `upsertProfile` `removeProfile` `reloadProfiles` `applyProfileLimitOverrides` `onProfilesChanged` `resetProfileStoreForTests` |
| `message.ts` | 668 | 请求体构造与消息映射：tool/图片拆分、思考回放、辅助请求降级、400 阶梯、结构指纹 | `buildRequestBody` `convertMessage` `applyCompatibilityFallback` `dropRejectedParams` `bodyDigest` `readThinkingEffortChoice` `readModelLimitOverrides` `applyLimitOverrides` `estimatePromptTokens` `safeJsonStringify` |
| `stream.ts` | 283 | SSE 解析、tool call 增量拼接、usage 数据部件、错误脱敏与映射 | `streamSseToProgress` `usageDataPart` `sanitizeDetail` `readErrorDetail` `responseErrorWithDetail` |
| `replay.ts` | 162 | 思考回放标记（宿主不透明 data part）的写与读 | `REPLAY_MARKER_MIME` `createReasoningMarker` `readReasoningMarker` |
| `requestKind.ts` | 215 | 「谁在问？」分类 + 辅助请求降级策略 | `classifyProviderRequest` `classifyRequestShape` `utilityDowngrade` `isUtilityKind` |
| `toolPreflight.ts` | 291 | `activate_*` 工具激活握手（零 token 往返）+ 合成控制流清理 | `inspectActivatePreflight` `pickActivatorToCall` `filterPreflightControlFlow` `createPreflightToolCallId` `summarizeToolSurface` `countRealTools` `MAX_PREFLIGHT_ROUNDS` |
| `hostDefaults.ts` | 175 | 把 `chat.defaultModel` / 两个 utility 槽位 / `byokUtilityModelDefault` 指向本插件（fill-only + stale 自愈，无强制覆盖路径） | `defaultChatUtilitySettingsToOwnModel` |
| `agentWindow.ts` | 152 | Agents 窗口三个兼容开关，一次性写入 | `applyAgentWindowDefaults` `applyAgentWindowDefaultsOnce` |
| `agentWindowTools.ts` | 234 | Agents 窗口工具可见性开关（关 tool search + 通配 capability）及其撤销 | `readAgentWindowToolState` `applyFullToolVisibility` `restoreAgentWindowToolDefaults` `showAgentWindowToolsMenu` |
| `modelListSetting.ts` | 138 | 设置镜像：把模型组渲染成 `customModel.modelList` 多行文本（只读，Settings UI 唯一能看到清单的地方） | `modelListLines` `modelListText` `syncModelListSetting` `registerModelListMirror` |
| `statusBar.ts` | 44 | 状态栏 ✨ 计数入口：显示本机模型组数量，点击执行 `customModel.manageModels`，随 `onProfilesChanged` 重绘 | `registerModelStatusBar` |
| `modelCapability.ts` | 382 | 学到的端点能力：某个 `(端点, 模型)` 到底接受哪些 `reasoning_effort` 值（存 SecretStorage，跨 VS Code 配置文件共享） | `initCapabilityStore` `effortVerdict` `fallbackEffort` `recordEffortVerdict` `parseSupportedFromDetail` `clearCapabilities` |
| `setup.ts` | 652 | 统一管理弹窗 `manageModels`（空列表→添加向导；选组→更新 ID/复制整组/删除，末行固定添加；**添加成功即结束访问**）+ 四步向导 + 一次性配置提示 | `manageModels` `addModelProfile` `maybeShowSetupHint` |
| `copilotChat.ts` | 79 | Copilot Chat 可用性探测（纯查询，无编排） | `isCopilotChatAvailable` `waitUntilCopilotChatAvailable` `openCopilotChatExtension` |
| `thinking.ts` | 46 | proposed API `LanguageModelThinkingPart` 的运行时探测与转发 | `isThinkingPart` `thinkingPartText` `reportThinking` |

**分层**：`config`（形状/派生，无状态）→ `profileStore`（唯一的可变状态）→ `provider`（编排）→ `message`/`stream`/`replay`/`requestKind`/`toolPreflight`（纯函数为主，最易测）→ `hostDefaults`/`agentWindow*`/`setup`/`copilotChat`（宿主设置与 UI 边缘）。

## 4. 一次聊天请求的数据流

```
VS Code / Copilot Chat
  └─ provideLanguageModelChatResponse(model, messages, options, progress, token)   [provider.ts]
       1. rid + t0；decodePickerId(model.id) → profile（裸 id 退回第一组）
       2. readProfileApiKey(profile) → 无 key 抛 NoPermissions
       3. resolveProfileEntry → 限额（显式 > 预设 > 默认 1M/128K）
       4. classifyProviderRequest → RequestKind（辅助请求降级用）
       5. runToolPreflight → 需要激活则只 report 一个 activate_* 调用并 return（不发请求）
       6. readModelLimitOverrides → 面板改数：本请求生效 + 持久化进该组
       7. resolveThinkingEffort（默认 auto）+ 已学到的降级（learnedEffortFor）+ buildRequestBody（映射消息、工具、reasoning_effort）
       8. fetch POST {baseURL}/chat/completions   （有 Key 才带 Bearer，无鉴权端点不带 Authorization，SSE）
       9. 非 2xx：context overflow → 删 max_tokens 重试一次；400 → 先做单参数探测（body 带
          reasoning_effort 就只删它重发，成功即归因并写入能力库）；失败再走四级阶梯；其余直接报错
      10. streamSseToProgress → 文本 / tool call / 思考 / usage
      11. progress.report(createReasoningMarker(reasoning))   （未取消时）
      12. progress.report(usageDataPart(usage))               （网关没给就用估算）
```

## 5. 不变量（改代码前必读）

1. **picker id 是 `<profile.key>::<model>`**；请求体 `model` 永远是 `profile.model`，**别名只用于显示**，绝不入库。
2. 两组即使用同一个上游 model id，picker id 也必须不同 —— VS Code 按 id 索引模型表，重复即静默覆盖。
3. 宿主槽位（`chat.defaultModel` 等）存的是**同一套编码 id**，编码不一致 → 解析不到模型。
4. assistant 消息 `content` 用 `''` 不用 `null`；无文本/无 tool_calls/无 reasoning 的空 assistant 轮**整条不发**。
5. **tool result 必须先于用户文本输出**：顺过来会把 `assistant(tool_calls) → tool(...)` 配对中间塞进一个空 user 消息，严格网关直接 400。
6. 思考回放的来源优先级：**marker > thinking part**；marker 只在流正常结束、且 token 未取消时写（半截思维链比没有更糟）。
7. 400 阶梯是**累积修改同一个 body**、每级重试一次、最多 `MAX_COMPATIBILITY_LEVEL = 4`；`401/403/404/5xx` 永不重试。
8. 上下文溢出**不进阶梯**：阶梯不减少 token，只会白白发四次请求。先删 `max_tokens` 重试，再给可执行报错。
9. 模型组只在 SecretStorage（application 级 `customModel.profiles.v2`）；`settings.json` 里不落任何模型组数据 —— 唯一写进设置的是只读镜像 `customModel.modelList`，且镜像里没有端点与密钥。
10. `await initProfileStore(context)` 必须排在**任何读 profile 之前**；SecretStorage 不可用时降级为**仅内存**（当前会话可用，不持久化，输出通道记一行 `[profiles] credential store unavailable`）。
11. `getConfiguration(section)` 的 key 一律**段内相对**（`chat.*`、`github.copilot.chat.*`、`chat.agentHost.*`、`extensions.*`）；传全名会变成 `chat.chat.*`，`update()` 直接抛错。
12. 宿主设置写入是 **fill-only**（只填空位）+ 只修自家命名空间的 stale 值；**没有任何代码路径会覆盖用户自己填的值**。
13. 限额覆写三态：`undefined` = 本次没动 · `>0` = 自定义（并持久化进模型组） · `<=0`（`Number('')===0`）= 清空，恢复自动。**窗口不再有 gear 控件**（见第 26 条），所以这三个值是「宿主把原始字段名下发」或「向导/manage 里手填」时才出现；`contextSize` 已从读取面移除，旧值不会再把模型改小。
14. 思考档位**四个位置就是宿主能标注的那四个词**：`none` / `low` / `medium` / `high`。`none`（默认）**不发送任何思考参数**；其余原样发 `reasoning_effort`。未知值回落 `none`；退役 id `auto` 也映射到 `none`（老存储值不失效）。辅助请求（utility 降级命中）一律不带该参数。`reasoning_effort` 已在 `OPTIONAL_BODY_PARAMS` 里，被网关拒绝时 400 阶梯会自动摘掉。**id 不能随便命名**：Copilot 侧用固定表（`none/minimal/low/medium/high/xhigh/max`）逐项生成标签，表外的值被**直接丢弃** —— 曾用 `auto` 导致同一模型在一侧 5 档、另一侧 4 档。
15. 辅助请求降级恒定生效：文本类 helper 去 `tools` + `max_tokens=2048`；`todo-tracker` / `prompt-categorizer` 保留唯一工具；`main-agent` / `terminal-steering` 绝不降级。
16. preflight 每轮**只发一个** activator（宿主的分组互斥），最多 3 轮；合成 call id 前缀 `cm_preflight_activate_`，发真实请求前会被 `filterPreflightControlFlow` 摘掉。
17. `l10n.t()` 的参数必须是**字符串字面量**；清单文案走 `%key%`，en/zh 两份都要有（缺键不会回退，会原样显示 `%key%`）。
18. 诊断日志（`fs.appendFileSync`）全部包在 try/catch 内 —— 日志失败绝不能让请求失败。
19. **`customModel.modelList` 是镜像，不是输入**：只写不读，`onProfilesChanged` 触发重绘；手改会在下次变更时被覆盖。镜像里**不得出现端点与密钥**（凭据存储的全部意义就是不落盘这两样），`scope: machine` 保证设置同步不带走它。
20. 镜像用**多行字符串**（`editPresentation: multilineText`）而不是字符串数组 —— 数组会被设置 UI 渲染成可编辑列表（每行的编辑/删除 ✕ + 「添加项」按钮），在只读镜像上等于给出一堆点了没用的控件。
21. **能力学习只认「单参数探测」的成功**：400 后先只删 `reasoning_effort` 重发一次，成功才归因并记账（有无网关点名字段都成立 —— 差别只在能否顺带解析出白名单）。阶梯那次重试可能一次删掉六个参数，成功不证明是档位的问题，所以**阶梯永不学习**。成功（200）会撤销该值的拒绝记录。
22. 学到的结论按 `端点(host+path) | model` 存 SecretStorage，最多 64 条（LRU 淘汰），**不存任何密钥**；没有 TTL，只能由 `customModel.resetCapabilities` 清除 —— 网关升级可能放宽值域，靠过期同样会误伤。
23. gear 面板**不从 enum 里删除**被拒档位：VS Code 把选择存在自己的 per-model 存储里，抽掉 enum 成员会让面板显示空值。改为在 `enumDescriptions` 里标注「会改用 X」，请求路径提前替换，不再花那一趟往返。
24. **「已配置」由 `noAuth` 或非空 Key 决定**（`profileHasCredentials`），不是只看 Key：自建推理服务（本地或内网、未开鉴权）没有密钥，若把空 Key 一律当未配置，这些端点永远加不进来。`noAuth` 只认字面量 `true`（手改 payload 写 `"true"` 不生效）；无鉴权请求**完全不发 Authorization 头**（空 `Bearer ` 会被把「头存在」当凭据的代理判 401）。
25. base URL 只做**后缀归一**：去尾斜杠、把误粘的 `…/chat/completions` 折回 base。**不补 `/v1`、不改前缀** —— 各家根路径不同（`/v1`、`/v1/openai`、`/openai/v1`、带 deployment 的路径），猜错就是把可用的换成 404；而 404 不在重试阶梯里。
26. **上下文窗口是声明，不是控件**：`maxInputTokens` = 模型真实窗口（`realInputCeiling`，预设值或 1M 默认），手填值优先；**没有 gear 下拉，也没有档位阶梯**（`CONTEXT_WINDOW_TIERS` / `contextTierOptions` / `defaultContextTier` / `hostWindowLabel` 已删）。原因是两个 harness 的渲染面不同：VS Code 自己的 picker 会画 `tokens` 组，Copilot 侧不画 —— 同一个模型于是在一个窗口里可调、在另一个窗口里莫名其妙被调小，且没人能改回来。要小窗口就让模型条目自己带小窗口（换一个 `maxInputTokens` 更小的 id / 在管理里手填上限），让「选模型」承担这个维度；Copilot 客户端本来就会在声明窗口的 ~80% 处自动压缩，压小只换来更早压缩。**旧安装注意**：以前在下拉里选过的档位被持久化进了模型组（`profile.maxInputTokens > 0`），升级后仍然生效，需要恢复就把它改回 0。
27. **「添加模型」是唯一会结束管理器访问的动作**：`addModelProfile` / `modelWizard` 返回 `saved: boolean`，管理器（`manageModels` 的 `for(;;)` 与空列表分支）在 `true` 时 `return` —— 向导已把焦点交给 Copilot Chat，再弹回列表只会挡住用户正要打字的输入框。`false`（向导任意一步 Esc / 空必填 / 写盘失败）才 `continue` 回列表。更新 ID / 复制 / 删除**照旧回到列表**（那仍处于「我在管理」的意图里）。
28. 焦点交回 Chat 要**两条命令**：`workbench.action.chat.open`（显示视图）+ `workbench.action.chat.focusInput`（把光标放进输入框，实测命令存在）。只有前者时焦点会停在视图容器或上次聚焦的编辑器里。两条都包 try/catch —— 版本没有该命令时静默失败，配置本身已成功。
29. **摘要（设置镜像 / 管理列表 / 添加向导）显示的就是声明值**：`summaryInputTokens()` = 手填值优先，否则 `realInputCeiling()`；档位阶梯删掉后它与 `resolveProfileEntry().maxInputTokens` 恒等（保留独立函数名是为了表达「这个模型本身多大」）。两个标签函数口径不同、不要合并：`tokenWindowLabel`（二进制：131072 → `128K`）与 `summaryWindowLabel`（十进制厂商口径：200000 → `200K`），合并会把 200K 印成 `195K`。

## 6. 日志 stage 对照（`console.log` + `<globalStorage>/custom-for-copilot-chat.log`）

| stage | 含义 / 读法 |
| --- | --- |
| `response.enter` | 请求进入 provider（带 `model=` 编码 id） |
| `request.start` | body 已构造：`kind= effort= messages= tools= max_tokens= stream_options= adjusted=` |
| `response.headers` | 收到响应头（含 status）；`status>=400` 也会进可见输出通道 |
| `response.firstChunk` | 首个 body 字节到达（推理耗时 = headers→firstChunk 的间隔） |
| `response.thinking` | 本轮有思维链：`chars= shown=`（`shown=false` 说明宿主没有 thinking part） |
| `response.replay` | marker 是否写入成功（`skipped:` 说明宿主拒收） |
| `request.fallback` | 阶梯降级：`level= dropped=` + 结构指纹 |
| `request.overflow` | 上下文溢出分支：是否已去掉 `max_tokens` 重试 |
| `response.rejected` | 最终被拒：status + 结构指纹 + 完整错误体（脱敏后 2000 字） |
| `preflight.activate/ready/drift/abort` | 激活握手进度、当前工具面 `real= activators= groups=`、未展开、超过轮数上限 |

## 7. 已知故障 → 对应机制

| 现象 | 机制位置 |
| --- | --- |
| 第一轮正常、第二轮起 400 | `convertMessage` 的 tool 输出顺序 + `replay.ts` 的 marker + `applyCompatibilityFallback` |
| 聊久了报「请求超长」 | `isContextOverflow` → 删 `max_tokens` 重试 → 提示调小「最大输入 tokens」 |
| helper 请求报 `No utility model is configured` | `hostDefaults.defaultChatUtilitySettingsToOwnModel`（四槽位） |
| 换一个 VS Code 配置文件后「有 Key 没模型」 | `profileStore`（列表与 Key 同在 application 级存储） |
| Agents 窗口模型在、工具几乎没有 | `toolPreflight` + 命令 `customModel.configureAgentWindowTools` |
| 上下文用量小部件一直 0% | `stream.usageDataPart`（mime `usage`，三个字段必须是数字） |
| 模型选择器条目消失 | `provider.modelInformation` 始终列出每组（未配置加 ⚠），不会隐藏 |
| `chat.defaultModel` 指向已删组 | `hostDefaults.isStalePickerId`（只改带 `::` 的自有值） |
| 设置里的模型清单对不上 | `modelListSetting.syncModelListSetting`（镜像只在列表变更时重绘；手改会被覆盖） |

## 8. 常见改动配方

- **加运行期文案**：源码写 `vscode.l10n.t('English literal')` → `npm run i18n:check` 报缺键与行号 → 补 `l10n/bundle.l10n.zh-cn.json` → 重跑。
- **加清单文案**：`package.json` 写 `%key%` → 两份 `package.nls*.json` 各加一条（同名同占位符）。
- **加命令**：`contributes.commands`（`title` 走 `%cmd.xxx.title%`）+ 两份 nls + `extension.ts` 里 `registerCommand` + 任何弹窗文案补 l10n。
- **在设置项里放可点链接**：`markdownDescription` 写 `[文本](command:命令id)`（命令必须先注册）；这就是设置页「管理模型」统一入口的实现方式。链接文本里**不要写 `$(codicon)`** —— 设置 UI 不渲染图标，会原样显示成 `$(add)`（QuickPick 的 label 里则可以正常用）。
- **加模型限额预设**：`config.ts` 的 `MODEL_PRESETS` 插入（**窄 id 必须排在同族通配之前**）→ `smoke.js` 补断言。README 不再列逐条限额表（预设是示例性质，随网关而异），只保留「默认 1M/128K + 管理里可覆盖」的说法。
- **改思考强度档位**：`config.ts` 的 `THINKING_EFFORTS` / `DEFAULT_THINKING_EFFORT` / `resolveThinkingEffort` / `thinkingEffortParam` + `provider.ts` 的 `thinkingEffortProperty`（`enumItemLabels` / `enumDescriptions` 与 `THINKING_EFFORTS` 必须同序）+ `modelInformation` 里的 `supportsReasoningEffort` / `defaultReasoningEffort`。**新档位 id 必须是 `none/minimal/low/medium/high/xhigh/max` 之一**，否则 Copilot 侧直接丢弃（见第 14 条）；改完跑 `npm run e2e`，PASS 3b 会核对两侧枚举一致。
- **调模型窗口**：改 `MODEL_PRESETS` 的 `maxInputTokens`，或在管理里给该组手填上限（`profile.maxInputTokens`）。**不要**恢复 gear 下拉或档位阶梯 —— 两个 harness 只有一侧渲染 `tokens` 组，见第 26 条；`smoke.js` 里 `resolveProfileEntry(...).maxInputTokens` 断言现在盯的是「真实窗口不再被吸附」。
- **改面板字段**：`provider.modelConfigurationSchema`（`navigation` 组 = 思考档位，枚举→下拉）+ `message.readThinkingEffortChoice` 读回；**新增字段必须同时在 `supportsReasoningEffort` 一侧声明**，否则只有 VS Code 自己那个窗口看得到它。
- **打包安装**：`npm run verify` → `npm run package`（或 `./scripts/dev-install.sh`）→ **Reload Window**（VS Code 不热替换已安装扩展）。

## 9. 验证门槛

| 命令 | 作用 |
| --- | --- |
| `npm run compile` | `tsc -p ./`，strict，零错是底线 |
| `npm run i18n:check` | 清单 `%key%` 双向齐全、重复键、占位符一致、源语言不得含中文、`l10n.t` 必须字面量、`show*Message` 不许裸字符串；缺条=错误，过期=告警（`--strict` 转错误） |
| `node scripts/smoke.js` | `vscode` stub 下跑纯逻辑：SSE（含无尾空行）、消息映射形状、400 阶梯、分类器、picker id 往返、限额解析、store 初始化/二次激活/跨窗口 reload |
| `npm run verify` | 上面三个串起来，改文案或源码后必跑 |

## 10. 硬性禁止

- 不要新增 `customModel.*` 设置 —— 唯一例外是那个只读镜像；需要新行为就走「常量 + 代码」。
- 不要在模型发现（`provideLanguageModelChatInformation`）里弹任何 UI —— 静默枚举也会调用它。
- 不要把 API Key 写进 `settings.json`、日志或错误文案（`sanitizeDetail` 会打码，但源头不该出现）。
- 不要给 400 以外的状态码加重试阶梯（重试治不了凭证/路由/上游问题）。
- 不要直接 `instanceof vscode.LanguageModelDataPart`（旧宿主上是 `undefined`，会抛错）；用 `isDataPart` / `replay.dataPartClass`。
- 不要删除 `.workbuddy/`（项目决策记录，不进 vsix）。
