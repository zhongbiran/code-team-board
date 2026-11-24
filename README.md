# Code Team 控制台

Code Team 工作流的可视化控制台（Mini App）。

## 它是什么

- **问题诊断**：不是展示"用了多少"，而是回答"这次哪里不对"。7 条诊断规则对应
  Code Team 机制里的真实失效模式（规划返工、只规划没落地、验收缺失、前缀未复用……）。
- **统计详情**：项目 → 会话 → 角色三级分组，全字段检索。
- **配置**：按角色配置。决策角色（Overmind / Coder）可改调用方式，以及该调用方式实际支持的字段；
  内置执行角色（Worker / Explore / Verifier）只可改模型与思考档位，backend 与 agent 身份固定。
  字段范围由 API 的能力描述（capabilities）决定，写回插件的 `config/team.json`，
  从下一次对应角色的调用开始生效。

### 模型中立

控制台不内置任何模型目录，也不假设某个品牌后端：可选调用方式、每个调用方式支持哪些字段、
模型与档位的取值域，全部来自 `GET /api/config` 返回的 `capabilities`。
换后端、换模型、换专业 Skill 组合，页面都跟着实际能力走——
后端不支持的字段会被禁用并写明原因，能力未确认的字段只显示当前值、不可编辑。

## 两个例子

### 例子一：把决策调用方式换成本地外部命令

在「配置 → Overmind → 调用方式」里选 **external-command**，然后填：

| 字段 | 值 |
|---|---|
| 可执行程序 | `local-planner` |
| 参数数组 | `["plan", "--stdin", "--model", "{model}", "--effort", "{effort}"]` |
| 模型 | `planner-large`（参数里含完整的 `{model}` 占位元素时才可填） |
| 思考档位 | `high`（同上，需要完整的 `{effort}` 占位元素） |

参数数组按元素原样传递，**不经 shell 拼接**；只有完整等于 `{model}` / `{effort}` 的元素会被替换成实际值。
参数里没有这两个占位元素时，模型与档位会被禁用并写明原因。

这条命令必须自己满足：

- 能由本机**无 shell** 启动（Windows 的 `.cmd` / `.bat` 不在支持域）
- prompt 从 **stdin** 读取（整段 UTF-8 文本，读完写端即关闭）
- 退出码 0 且 stdout 输出非空文本——这段文本就是规划输出
- 想要续问就得自己实现线程句柄；没声明时控制台只做新调用，不会把新会话伪装成续问

保存后从**下一次 Overmind 调用**开始生效，已经在途的调用不受影响。

依赖没装会怎样：控制台照常保存配置（配置只是数据），但第一次真正调用会因为拉不起这个程序而失败。
能力描述里带预检结果时，卡片会先写出阻塞原因与一条可执行的下一步；核心插件版本过旧、读不到
后端能力描述时，调用方式会标成"不可用"并给出修复动作（升级插件后重新打开控制台）。
预检本身不发起任何模型调用。

### 例子二：前端专业方向 → 命中 Skill

方向写在插件的 `config/team.json` 里，只存方向名和按优先级排好的完整 skill 名：

```json
"routing": {
  "directions": [
    { "id": "frontend", "skills": ["frontend-design:frontend-design", "senior-fullstack-developer:frontend-dev"] }
  ]
}
```

效果：方向选为 `frontend` 的包会带上 `attachment.specialty`：

```json
{ "direction": "frontend",
  "skills": [
    { "fullName": "frontend-design:frontend-design", "visibleName": "frontend-design:frontend-design" },
    { "fullName": "senior-fullstack-developer:frontend-dev", "visibleName": "senior-fullstack-developer:frontend-dev" }
  ],
  "skipped": [] }
```

- 每个包最多附 **2** 个专业 skill，按优先级取；方向里排在第三位及以后的会进 `skipped`，原因写 `limit`
- 角色自带的 skills 不占这两个位置
- `skipped` 写明为什么没带：`not-visible`（当前会话不可见）、`visibility-unknown`（拿不到可见清单）、`limit`（超出上限）
- 执行者按 `visibleName` 加载，不是按 `fullName`

前提与降级：目标插件必须已安装，并且在目标会话的可见清单里。
只有本地 SKILL.md、没有会话清单时，专业 skills 数组是空的——包退回角色基础能力完成工作，
不会凭空猜一个 skill 名。角色基础 skills 与路由配置互不影响。

## 与插件的关系

控制台**只读** Code Team 插件产生的事件流，不自己跑决策后端、不自己派工。

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
node checks/config-view.mjs   # 配置页行为检查（沙箱里跑真实客户端脚本）
node miniapp/node/server.mjs   # 需要 MiniMax Code 的 Host 环境变量才能独立跑
```

实际开发用宿主提供的环境：发布后 `miniapp.open` 会分配端口与凭证。

## 已知限制

- **发布或重启运行时后，旧页面的凭证会失效**，fetch 全返回 401。页面会显式提示
  "会话凭证已失效"，重新打开即可。这是 MiniApp 的 loopback 认证守卫机制，不是 bug。
- 检索状态存在 `sessionStorage`，跨刷新保留；但不写 URL（写 URL 会被宿主判为页面导航）。
- 配置页只展示后端**当前**能力描述里 supported 的字段。想看某个后端支持什么，
  先把调用方式切过去；能力不可用时选项会被禁用并写明原因。
