# Code Team 控制台

Code Team 工作流的可视化控制台（Mini App）。

## 它是什么

- **问题诊断**：不是展示"用了多少"，而是回答"这次哪里不对"。7 条诊断规则对应
  Code Team 机制里的真实失效模式（规划返工、只规划没落地、验收缺失、前缀未复用……）。
- **统计详情**：项目 → 会话 → 角色三级分组，全字段检索。
- **配置**：改 Overmind / Coder 的后端与模型，写回插件的 `config/team.json`。

## 与插件的关系

控制台**只读** Code Team 插件产生的事件流，不自己跑 Codex、不自己派工。

数据源（默认）：

```
%USERPROFILE%\.minimax\plugins\code-team\config\events.jsonl
%USERPROFILE%\.minimax\plugins\code-team\config\team.json
```

插件装在别处时，设环境变量：

```bash
export CODE_TEAM_PLUGIN_DIR=/path/to/code-team
```

Windows：

```powershell
$env:CODE_TEAM_PLUGIN_DIR = 'D:\path\to\code-team'
```

**必须先装 Code Team 插件**，否则控制台读不到任何数据。

## 安装

这是 MiniMax Plugin 格式（`MiniMax Plugin` 清单），在 MiniMax Code 里用：

1. 把仓库克隆下来，或让 Agent 用 `/miniapp-creator` 指向本目录
2. 桌面端对话里说「把 D:\path\to\code-team-board 做成 Mini App」
3. 打开后选「Code Team 控制台」

## 本地开发

```bash
node miniapp/node/server.mjs   # 需要 MiniMax Code 的 Host 环境变量才能独立跑
```

实际开发用宿主提供的环境：发布后 `miniapp.open` 会分配端口与凭证。

## 已知限制

- **发布或重启运行时后，旧页面的凭证会失效**，fetch 全返回 401。页面会显式提示
  "会话凭证已失效"，重新打开即可。这是 MiniApp 的 loopback 认证守卫机制，不是 bug。
- 检索状态存在 `sessionStorage`，跨刷新保留；但不写 URL（写 URL 会被宿主判为页面导航）。
