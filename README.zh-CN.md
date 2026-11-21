# opencode-qwenwork-auth — 千问办公（QwenWork）接入 magpie / OpenCode

[English](README.md)

![Platform](https://img.shields.io/badge/platform-macOS-blue) ![Platform](https://img.shields.io/badge/platform-Windows-blue)

把你的千问办公订阅接成 OpenCode provider：用千问办公自己的设备登录流程登录，
再通过千问办公自己的 agent 端点调用它的模型 —— 宿主 agent 的工具会随请求下发。

> 非官方插件。未经 magpie 审阅，安装前请先看代码。
> 已在 macOS 上对着千问办公 1.2.5 桌面版跑通端到端。

| Provider id | 服务 | 模型 |
|---|---|---|
| `qwenwork` | 千问办公（`gateway.qwenwork.cn`） | 账号自己的 `qwork` 目录 |

本包导出 `QwenWorkAuthPlugin`。

## 安装

从这个 GitHub 仓库安装（推荐）：

```sh
magpie plugin add github:harwinvoid/magpie-plugin-qwenwork
magpie plugin login qwenwork
```

`magpie plugin add` 接受 bun 支持的各种 spec：npm 包、`github:owner/repo` 仓库，
或本地目录。本仓库就是给 `github:` 方式安装用的 —— 这样才会跟随这里的代码、并
收到更新。

本插件没有自己的运行时依赖。给某个 agent 选 `qwenwork/<模型>` 即可，例如
`magpie claude qwenwork/flash`。

- **之前是从本地目录装的？** 加上 `github:` spec、再删掉本地目录那条，让 magpie
  改为跟踪仓库：
  ```sh
  magpie plugin add github:harwinvoid/magpie-plugin-qwenwork
  magpie plugin rm /你本地/magpie-plugin-qwenwork 的路径
  ```
  登录态会保留。
- **在应用里找到它。** 本仓库打了 `magpie-plugin` topic，magpie 会把它列在
  插件 → 发现 → *非官方*（社区插件，未经 magpie 审阅）。可以在那里安装，也可以用
  上面的命令。

## 工作原理

登录使用与千问办公桌面端相同的 PKCE 设备流，随后用自带的 refresh token 持续续期
access token。账号按名称显示，取不到时回退到 id。

对话会被改写成千问办公自己的 `agent_chat_generation` 请求 —— 与桌面端引擎、
Qoder 客户端说的是同一种请求：

- 宿主 agent 的**工具随请求下发**，OpenCode 会话在 `qwenwork` 模型上保留完整的
  工具循环（read、edit、bash…）。
- **工具调用以结构化形式返回**：要么是网关原生的 `tool_calls`，要么从内联的
  `<tool_call>` 文本里提取 —— 绝不会以标记形式混进回答。
- 宿主的 system 消息置于一段简短的 QwenWork 前导之下原样保留；reasoning、
  usage 与积分按客户端的展示方式映射回来。

以下配置取自千问办公桌面端自身的打包文件：

```text
clientId      e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb
web / openapi / api   https://gateway.qwenwork.cn
redirect_uri  qwenwork-cn://
设备流        /device/selectAccounts -> /api/v1/deviceToken/poll
刷新          /api/v1/deviceToken/refresh   (target: "c")
对话          /algo/api/v2/service/pro/sse/agent_chat_generation
模型          "qwork" scene
```

以上每一项，连同 COSY RSA 公钥，都可以通过 `QWENWORK_*` 环境变量和
`defaults.json` 覆盖。

## 用量

magpie 会在 provider 旁边显示账号的积分。数据取自登录时已经在读的同一个
`account-context`，因此不会额外发请求：

| 显示项 | 来源 |
|---|---|
| `额度 · Credits` 百分比（`used` + `limit: 100`） | `quota.total` 有值（付费版有总量）时用 `quota.used / quota.total` |
| `额度 · Credits` 余额（`balance` + `unit`，不发 `used`/`limit`） | `quota.total` 为 null（免费版没有总量，只有钱包）时用 `quota.remaining` |
| `停用 · 额度耗尽`（`used: 100`） | `quota.exceeded` —— 让路由跳过该号的唯一开关 |
| `说明 · 计划 <套餐名>` | `plan.name` |
| 重置时间 | `plan.next_refresh_date`，没有则用 `plan.next_due_date`；两者都为空则不设 `until` |

读取被拒（401/403）会标记登录失效；其余读不到的情况收敛成一条
`说明 · 额度不可读（<原因>）` 窗口 —— 绝不写顶层 `error`，那会整块替换卡片。
实现见 `index.mjs` 里的 `qwenworkUsage()`。`magpie quota qwenwork` 会在终端打印：

```text
qwenwork · 个人免费版 · 七七@example.com  subscription  额度 · Credits 399.94 credits  说明 · 计划 个人免费版
```

## 登录

两条路，都在「添加提供商」的登录弹窗里：

| 方式 | 走什么 | 什么时候用 |
|---|---|---|
| **设备码登录**（`Sign in with QwenWork`） | QwenWork 原生：显示一个码，在浏览器里确认 | 默认 |
| **粘贴 access token** | 把 token 粘进来，插件先打一次 `account-context` 验证，通了才收 | 设备码走不通时（轮询超时 / 厂商故障 / redirect 打不开） |

两条都能在插件设置里单独开关（`允许设备码登录` / `允许粘贴 access token`）。**两个都关掉时会自动保留设备码**，不会让人无路可走。

## 从文件导入

供应商编辑页里有「从文件导入账号…」。支持四种形状，都认：

```jsonc
// ① 单对象
{ "access": "eyJ...", "accountId": "uuid", "expires": 1797702136000 }

// ② 数组
[ { "access": "eyJ..." }, { "access": "eyJ..." } ]

// ③ version:1 容器
{ "version": 1, "accounts": [ { "access": "eyJ..." } ] }

// ④ NDJSON（一行一条，坏行只丢那一行）
{ "access": "eyJ..." }
{ "access": "eyJ..." }
```

- token 键名认 `access` / `access_token` / `key` / `token`
- `accountId` 优先级：`accountId` → `user.id` → JWT 的 `sub` → token 前 8 位（**永不为空**）
- `expires` 给秒级会自动 ×1000
- 已在 `plugin-auth.json` 里的 token 会被拒，并说明是哪个 key
- 单次最多 100 条；超出会多返回一条「还有 N 条未处理」，**不静默截断**

## 说明

- 只服务 chat completions 端点。登录失效会明确报出；上游错误在返回给调用方前
  会做裁剪并脱敏 token。
- **上游没有签到接口**（实测 `/api/v1/adapter/user/daily-checkin` 等五个候选全部 404，
  `account-context` 也不返回签到字段），所以本插件不提供 `auth.checkin`。
- provider 图标用的是千问办公的应用图标，用于标识该产品。
- MIT。

## 验证

```sh
node --test        # 离线：额度卡片的形状与命名
node check.mjs     # 离线：mock 上游
./live-e2e.sh      # 在线：经网关验证模型、对话、流式
```

## 文件

- `index.mjs` — provider：配置、设备登录、用量。
- `vendor/qoder.mjs` — 与 Qoder 插件共用的适配层：登录、agent_chat_generation
  编解码、工具调用提取、用量。
- `defaults.json` — 已核实的桌面端配置。
- `icon.png` — provider 图标，即千问办公应用图标。
- `check.mjs`、`live-e2e.sh` — 离线与在线检查。
- `test/` — 额度卡片的测试（`node --test`）。
