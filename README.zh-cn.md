# Custom for Copilot Chat

**免 Copilot 登录，在 Copilot Chat / Agents 里使用任意 OpenAI 兼容模型** —— 自己填地址和 Key。

## 快速开始

1. 安装并启用本扩展后 **Reload Window**（需 VS Code 1.109+，且已装 GitHub Copilot Chat）。
2. 命令面板执行 **自定义模式: 管理模型…**（或点击状态栏 ✨ 图标），首次使用直接进入添加向导：
   - ① API Base URL（OpenAI 兼容，如 `https://api.example.com/v1`）
   - ② 显示别名（模型选择器里看到的名字，可留空 = 显示模型 ID）
   - ③ 真实模型 ID（发给接口的 `model` 参数）
   - ④ API Key（本地/内网无鉴权网关可留空）
3. 在 Copilot Chat 的模型选择器里选定它（BYOK 分组）即可开聊。

模型组存在本机**用户级凭据存储**里（不在 `settings.json`）：换配置文件、多窗口共享，保存立即生效、无需重载。

## 常用命令

- **自定义模式: 管理模型** —— 统一管理弹窗：添加 / 更新模型 ID / 复制模型组 / 删除。
- **自定义模式: 配置 Agents 窗口工具** —— 在 Agents 窗口把工具前置（可撤销）。
- **自定义模式: 重置已学习的思考强度限制** —— 清空「各端点拒绝过哪些思考档位」的记录。

## 常见问题

- **模型没出现在选择器**：确认 Copilot Chat 已启用。
- **网关报 400**：扩展会按四级阶梯自动降级重试，详细过程可见输出通道（输出 → 「Custom for Copilot Chat」）。
- **提示「请求超长」**：在模型旁的齿轮里调小「最大输入 tokens」，或新开会话。
- **事后排查**：请求日志落盘在扩展全局存储 `custom-for-copilot-chat.log`（macOS：`~/Library/Application Support/Code/User/globalStorage/CustomforCopilotChat.custom-for-copilot-chat/`）。

## 开发

```bash
npm install && npm run compile
npm run verify            # 编译 + 国际化检查 + smoke 测试
./scripts/dev-install.sh  # 打包并装进本机 VS Code（装完 Reload Window）
```

实现细节见 `AIINDEX.md`。

## 发布

发布走 [`.github/workflows/release.yml`](.github/workflows/release.yml)（semantic-release 全自动）：

1. 在 `master` 上按 conventional commits 提交（`feat:` / `fix:` / `BREAKING CHANGE:` 决定版本号）。
2. 发版时从 GitHub 网页开 PR 把 `master` 合进 `release` 分支，合并即可。
3. workflow 自动：推断版本 → 更新 `package.json` / `CHANGELOG.md` → 打 `v<version>` tag → `vsce publish`（Azure WIF 无密钥）→ 建 GitHub Release（附 vsix）→ 版本号自动回填 `master`。

首次启用前置（一次性）：打基线 tag（`git tag v0.1.0 && git push origin v0.1.0`）、创建远端 `release` 分支、配置 `AZURE_CLIENT_ID` / `AZURE_TENANT_ID`（详见 workflow 文件头部注释）。

## 许可

MIT
