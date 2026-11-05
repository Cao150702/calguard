# CalGuard - 智能日程守护助手

> 自动读取日历和邮件，在会议前推送智能简报到微信、飞书、邮箱、钉钉、企业微信。

## 它能做什么

CalGuard 是一个运行在本地的守护进程，三步完成日程守护：

1. **读取日程** — 从 Apple Calendar / Google Calendar / 飞书日历 获取即将到来的会议
2. **关联邮件** — 从 Mac Mail / Gmail / IMAP 邮箱 检索与日程相关的邮件
3. **推送简报** — 在会议前 24 小时 / 1 小时，自动推送智能摘要到你的通知渠道

```
日程事件 → 提取关键词 → 检索本地邮件索引 → 生成简报 → 推送到微信/飞书/邮箱
```

## 核心特性

- **本地优先** — 所有检索在本地完成，LLM 只做最后摘要。Token 用量最小化，隐私最大化
- **三层解耦** — 数据源（Source）→ 处理引擎（Engine）→ 通知渠道（Notifier），自由组合
- **多日历支持** — Apple Calendar、Google Calendar、飞书日历、钉钉日历
- **多邮件源** — Mac Mail 本地数据库、IMAP（Gmail / 企业邮箱 / Outlook）
- **多渠道推送** — WorkBuddy→微信、飞书机器人、钉钉机器人、企业微信、邮件
- **零配置可用** — Mac Mail + Apple Calendar + WorkBuddy 推送开箱即用，无需 API Key
- **完全本地运行** — 可选关闭 LLM，纯本地生成简报

## 快速开始

### 环境要求

- macOS 12+（当前仅支持 macOS 平台）
- Node.js >= 18（推荐 24+）

### 安装

```bash
git clone https://github.com/Cao150702/calguard.git
cd calguard
npm install
npm run build
```

### 三步上手（零配置）

如果你使用 Mac Mail 和 Apple Calendar，无需任何额外配置：

```bash
# 1. 拉取邮件建立索引
npx calguard fetch

# 2. 查看日程
npx calguard events --hours 24

# 3. 预览简报
npx calguard preview --mode standard
```

> 首次使用 Mac Mail 需要授权完全磁盘访问权限，参见下方[权限说明](#权限说明)。

### 配置文件

```bash
cp config.example.yaml config.yaml
# 编辑 config.yaml，按需启用数据源和通知渠道
npx calguard config validate
```

最小配置示例（纯本地运行，无需 API Key）：

```yaml
sources:
  calendars:
    - type: apple
      enabled: true
  messages:
    - type: mac_mail
      enabled: true

notifications:
  remind_at: [24h, 1h]
  channels:
    - type: workbuddy
      enabled: true

llm:
  provider: none    # 纯本地生成简报
```

### 启动守护进程

```bash
# 前台运行（调试用）
npx calguard start

# 单次执行（适合 WorkBuddy 定时任务）
npx calguard start --once

# 后台运行（推荐 pm2）
npm install -g pm2
pm2 start "npx calguard start" --name calguard
pm2 save
pm2 startup   # 设置开机自启
```

### 提醒时间与补发规则

- 守护模式每分钟检查一次，单次模式 `start --once` 使用同一套判断。提醒只在到期后发送，不会因容差窗口提前推送。例如 10:30 的会议，`1h` 提醒从 09:30 起可发送。
- `notifications.remind_at` 支持正整数分钟或小时，如 `15m`、`30m`、`1h`、`24h`、`48h`，最多 365 天。无效值会报错，不再静默当作 `1h`；`60m` 与 `1h` 会合并去重。
- 电脑休眠、检查延迟或正常重启后，尚未发送且已到期的提醒会在会议开始前补发。会议开始后不再补发。首次启动可能同时补发多个已到期的配置档位。调度器收到数据源、摘要或通知失败时，会继续尝试独立任务并汇总错误；单次任务最终以非零状态退出，已成功渠道保留去重记录。守护模式记录错误并在后续检查重试。状态保存失败仍立即停止后续发送，保留核对锁。
- 每个会议实例（数据源、日历、事件 ID、开始时间）、提醒档位和通知目标分别去重。只保存渠道确认成功的记录，失败渠道下次重试，已成功渠道不会跟着重发。旧版状态文件继续读取，按旧版 30 分钟窗口匹配原会议实例。
- 状态保存在 `~/.calguard/state.json`，采用临时文件加原子替换。内置通知渠道的目标标识经过哈希，不把 webhook、收件人或凭证写入状态。自定义通知器可提供稳定的 `deliveryId`；未提供时采用名称与同名序号，应保持配置顺序不变。
- 同一状态文件不能同时执行两个检查。检查期间会创建 `state.json.lock`，正常完成或发送前抛错时释放；另一个进程会明确报锁冲突。发送成功但保存状态失败时会保留锁，防止重启后静默重发。若进程被强制终止或保存失败留下锁，请先确认没有运行中的检查、核对最后一次通知是否送达并备份状态，再移除残留锁。程序不会擅自删除可能代表未确认发送的锁。
- 通知服务与本地文件之间没有共同事务：发送被服务接受后、状态保存前崩溃，或服务接受消息但响应丢失，仍可能产生重复。此实现不承诺跨服务的严格恰好一次投递。损坏的状态会报错停止，避免静默清空去重记录后重发。WorkBuddy 渠道仅确认本地 stdout 写入成功，无法确认后续微信投递。守护模式下 Ctrl-C / SIGTERM 会等待进行中的提醒与状态保存后退出；强制杀进程仍需按上述残留锁规则处理。

外部定时任务如需接近配置时间送达，应每分钟执行一次 `start --once`；更低频率只能在下次执行时补发。请勿同时运行守护进程和多个单次任务。`engine.skip_summary_if_no_match: true` 仍会跳过无相关消息的提醒。

### 离线回归测试

安装依赖后运行：

```bash
npm test
```

IMAP 读取会等待当前批次的邮件解析完成；读取、解析、提前断线或每文件夹 60 秒超时会作为错误返回。若部分邮件已成功读取，调度器及 `calguard fetch` 仍保存这些有效消息，同时报告失败，继续尝试其他文件夹/数据源。程序不会把部分读取冒充完整成功。现有提醒策略保持不变：可用的部分消息或旧索引仍可参与提醒，不自动补发已经成功发送的同档简报。

扩展消息源可在不完整读取时抛出 `PartialFetchError<Message>`，提供错误列表与有效的 `partialResults`；完整成功（含真正无消息）仍返回 `Message[]`。

Mac Mail 以独立参数、只读方式调用 SQLite。数据库不存在、命令失败、JSON 格式或消息行字段无效均会报告失败，不再冒充没有邮件；正常空输出或空数组仍是成功。有效行会保留，坏行不会进入索引。查询范围、500 条上限、消息 ID 和现有提醒策略保持不变。

Apple Calendar 命令使用 JXA 输出结构化 JSON，日期直接输出带时区的 UTC ISO 时间戳，不再把中文等本地化日期交给 `new Date(文本)` 猜测。命令、JSON、必需字段或无效日期错误会报告为失败；有效的部分日程仍参与原有提醒逻辑。日程列表与预览命令也会展示有效部分结果，同时以非零状态退出。真正没有日程仍是成功的空结果。现有事件 ID 规则保持不变。

Apple 命令脚本只通过假 Application 对象及合成日期测试，包含中文文本、上海时区以及夏令时重复小时。中文环境验证使用 `LC_ALL=zh_CN.UTF-8 LANG=zh_CN.UTF-8 TZ=Asia/Shanghai node --loader ./tests/apple-calendar-loader.mjs --test tests/apple-calendar.test.mjs`，属于 Node/VM 仿真；未验证原生 macOS JXA 自动化桥接或真实日历权限。Mac Mail 使用假文件探测、假 SQLite 命令及合成行测试，未验证原生 macOS 的 SQLite 版本、Mail 数据库结构或权限。现有日期转换仍按 2001-01-01 起算的秒数处理；该假设尚未在真实 Mail 数据库核实。修复不代表所有数据源的健康检查已完成。

测试仅使用假日历、假时钟、临时状态目录以及拦截的假 HTTP 响应，不读取真实日历、邮件或凭证，不发送真实通知，也不启动守护进程。

## CLI 命令

| 命令 | 说明 |
|------|------|
| `calguard start` | 启动守护进程 |
| `calguard start --once` | 执行一次后退出（适合定时任务） |
| `calguard fetch` | 手动拉取消息并更新索引 |
| `calguard events --hours 24` | 查看未来 24 小时的日程 |
| `calguard preview --mode standard` | 预览日程简报（不发送通知） |
| `calguard status` | 查看运行状态和索引信息 |
| `calguard config validate` | 校验配置文件格式 |

## 连接指南

### WorkBuddy 推送（→ 微信）

最简单的推送方式，无需任何额外配置。CalGuard 将 Markdown 格式简报输出到 stdout，WorkBuddy 自动化系统捕获后推送到微信。

```yaml
notifications:
  channels:
    - type: workbuddy
      enabled: true
      template: full       # full | checklist
```

**使用方式：**
1. 在 WorkBuddy 中创建定时任务
2. 任务命令：`cd /path/to/calguard && node dist/cli/index.js start --once`
3. WorkBuddy 自动捕获 stdout 推送到微信

### 飞书机器人

在飞书群中添加自定义机器人，通过 Webhook 推送消息卡片。

**创建步骤：**
1. 打开飞书群聊 → 点击右上角 **设置** → **群机器人**
2. 点击 **添加机器人** → 选择 **自定义机器人**
3. 设置机器人名称（如 "CalGuard 日程助手"）
4. **安全设置**：选择「加签」，复制 **Secret**
5. 复制 **Webhook URL**
6. 在配置文件中填入：

```yaml
notifications:
  channels:
    - type: feishu_bot
      enabled: true
      webhook: https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxxxxxxx
      secret: ${FEISHU_BOT_SECRET}    # 加签密钥（安全设置中获取）
      template: full
```

### 钉钉机器人

在钉钉群中添加自定义机器人，通过 Webhook 推送 Markdown 消息。

**创建步骤：**
1. 打开钉钉群聊 → 点击右上角 **设置** → **智能群助手**
2. 点击 **添加机器人** → 选择 **自定义**
3. 设置机器人名称（如 "CalGuard"）
4. **安全设置**：选择「加签」，复制 **Secret**
5. 复制 **Webhook URL**
6. 在配置文件中填入：

```yaml
notifications:
  channels:
    - type: dingtalk_bot
      enabled: true
      webhook: https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxxxxxxx
      secret: ${DINGTALK_BOT_SECRET}  # 加签密钥
```

### 企业微信

通过企业微信应用消息 API 推送。

**配置步骤：**
1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
2. 创建**自建应用**，记录 **AgentId** 和 **Secret**
3. 在「我的企业」页面复制 **企业 ID (CorpID)**
4. 确保应用对目标用户可见
5. 在配置文件中填入：

```yaml
notifications:
  channels:
    - type: wecom
      enabled: true
      corp_id: ww1234567890abcdef        # 企业 ID
      agent_id: "1000002"                # 应用 ID
      secret: ${WECOM_SECRET}            # 应用 Secret
      to_user: "@all"                    # @all 或指定用户 ID
```

### 邮件通知（SMTP）

通过 SMTP 发送 HTML 格式邮件给自己。

```yaml
notifications:
  channels:
    - type: email
      enabled: true
      smtp:
        host: smtp.gmail.com
        port: 587
        user: you@gmail.com
        password: ${EMAIL_PASSWORD}      # Gmail 使用 App Password
        to: you@gmail.com
        subject_prefix: "[CalGuard]"
```

**Gmail App Password 获取：**
1. 访问 Google 账号 → 安全性 → 两步验证
2. 启用两步验证后，在「App Password」中生成专用密码
3. 使用该密码替代账号密码

### IMAP 邮件源

除了 Mac Mail 本地数据库，还可以通过 IMAP 协议读取 Gmail 等邮箱。

```yaml
sources:
  messages:
    - type: email
      enabled: true
      imap:
        host: imap.gmail.com
        port: 993
        tls: true
        user: you@gmail.com
        password: ${EMAIL_PASSWORD}      # App Password
        folders: [INBOX, Sent]           # 要读取的文件夹
```

**常用 IMAP 服务器：**

| 邮箱 | IMAP 地址 | 端口 |
|------|-----------|------|
| Gmail | imap.gmail.com | 993 |
| Outlook / Hotmail | outlook.office365.com | 993 |
| QQ 邮箱 | imap.qq.com | 993 |
| 163 邮箱 | imap.163.com | 993 |
| 企业 Exchange | 由 IT 部门提供 | 993 |

### Apple Calendar

通过 macOS 内置 AppleScript 读取，无需 API Key。

首次使用需授予权限：
1. **系统偏好设置** → **安全性与隐私** → **辅助功能**
2. 点击锁图标解锁
3. 添加 **Terminal.app**（或你使用的终端）
4. 同时在**完全磁盘访问权限**中也添加 Terminal

**性能提示：**
- 「个人」等大日历可能导致 AppleScript 超时（30-60秒）
- 使用 `skip_calendars` 排除不需要的日历：
```yaml
sources:
  calendars:
    - type: apple
      enabled: true
      skip_calendars:
        - "个人"
        - "香港節日"
        - "中国大陆节假日"
      timeout_seconds: 45
```

### Mac Mail

直接读取 Mac Mail 本地 SQLite 数据库，无需额外配置。

需要**完全磁盘访问权限**：
1. **系统偏好设置** → **安全性与隐私** → **完全磁盘访问权限**
2. 添加 **Terminal.app**
3. 确保 Mac Mail 应用已打开过并同步了邮件

### 飞书日历 / 飞书消息

**创建飞书应用：**
1. 访问 [飞书开放平台](https://open.feishu.cn/app) → 创建企业自建应用
2. 在 **权限管理** 中添加：
   - `calendar:calendar:readonly`（日历读取）
   - `im:message:readonly`（消息读取）
3. 在 **版本管理与发布** 中发布应用
4. 等待管理员审批通过
5. 复制 **App ID** 和 **App Secret**

```yaml
sources:
  calendars:
    - type: feishu
      enabled: true
      app_id: ${FEISHU_APP_ID}
      app_secret: ${FEISHU_APP_SECRET}
  messages:
    - type: feishu_message
      enabled: true
      app_id: ${FEISHU_APP_ID}         # 与日历可共用
      app_secret: ${FEISHU_APP_SECRET}
```

## 权限说明

CalGuard 需要以下 macOS 系统权限：

| 权限 | 路径 | 用途 |
|------|------|------|
| 辅助功能 | 安全性与隐私 → 辅助功能 | AppleScript 控制 Apple Calendar |
| 完全磁盘访问 | 安全性与隐私 → 完全磁盘访问 | 读取 Mac Mail SQLite 数据库 |

> 添加权限后需要重启 Terminal 才能生效。

## 环境变量

敏感信息（API Key、密码）建议通过环境变量传入，不要明文写在配置文件中。

在配置文件中使用 `${VAR_NAME}` 语法引用：

```yaml
llm:
  api_key: ${ANTHROPIC_API_KEY}
```

支持 `.env` 文件或直接在 shell 中 export：

```bash
export ANTHROPIC_API_KEY=sk-ant-xxxxx
export EMAIL_PASSWORD=xxxxx
calguard start
```

| 环境变量 | 用途 | 获取方式 |
|----------|------|----------|
| `ANTHROPIC_API_KEY` | Claude API 密钥 | [console.anthropic.com](https://console.anthropic.com) |
| `OPENAI_API_KEY` | OpenAI API 密钥 | [platform.openai.com](https://platform.openai.com) |
| `EMAIL_PASSWORD` | 邮箱密码/App Password | 邮箱设置中生成 |
| `FEISHU_APP_ID` | 飞书应用 ID | 飞书开放平台 |
| `FEISHU_APP_SECRET` | 飞书应用密钥 | 飞书开放平台 |
| `FEISHU_BOT_SECRET` | 飞书机器人加签密钥 | 机器人安全设置 |
| `DINGTALK_APP_KEY` | 钉钉应用 Key | 钉钉开放平台 |
| `DINGTALK_APP_SECRET` | 钉钉应用密钥 | 钉钉开放平台 |
| `DINGTALK_BOT_SECRET` | 钉钉机器人加签密钥 | 机器人安全设置 |
| `WECOM_CORP_ID` | 企业微信企业 ID | 企业微信管理后台 |
| `WECOM_AGENT_ID` | 企业微信应用 ID | 应用管理页面 |
| `WECOM_SECRET` | 企业微信应用密钥 | 应用管理页面 |

## LLM 配置

CalGuard 支持三种摘要模式：

### 纯本地模式（默认，免费）

```yaml
llm:
  provider: none
```

使用本地模板生成简报，包含背景、待确认事项、行动项等结构化内容。

### Claude 模式

```yaml
llm:
  provider: anthropic
  model: claude-sonnet-4-20250514
  api_key: ${ANTHROPIC_API_KEY}
  max_tokens: 1000
```

### OpenAI 模式

```yaml
llm:
  provider: openai
  model: gpt-4o
  api_key: ${OPENAI_API_KEY}
  max_tokens: 1000
```

### Token 用量优化

三个旋钮控制 Token 消耗：

| 参数 | 省钱配置 | 均衡配置（默认） | 全量配置 |
|------|----------|------------------|----------|
| `fetch_interval_minutes` | 60 | 30 | 15 |
| `summary_mode` | concise (~200) | standard (~500) | detailed (~1200) |
| `skip_summary_if_no_match` | true | true | false |
| **月均 Token 估算** | **~5,000** | **~15,000** | **~50,000** |

> **最有效的省钱手段**：设置 `skip_summary_if_no_match: true`，无相关消息时直接跳过 LLM 调用。

## 系统架构

```
┌──────────────────────────────────────────────────────────────┐
│                     CalGuard Agent                          │
│                                                              │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │   数据源层       │  │   数据源层       │                  │
│  │   (Source)      │  │   (Source)      │                  │
│  │                 │  │                 │                  │
│  │  Apple Calendar │  │  Mac Mail       │                  │
│  │  Google Calendar│  │  IMAP (Gmail)   │                  │
│  │  飞书日历       │  │  飞书消息       │                  │
│  │  钉钉日历       │  │  微信本地       │                  │
│  └────────┬────────┘  └────────┬────────┘                  │
│           │                    │                            │
│           ▼                    ▼                            │
│  ┌─────────────────────────────────────────┐               │
│  │           处理引擎 (Engine)              │               │
│  │                                         │               │
│  │  1. 关键词提取 — 人名、项目、公司名      │               │
│  │  2. 消息检索 — 本地索引关键词匹配        │               │
│  │  3. 简报生成 — LLM API 或本地模板       │               │
│  └─────────────────┬───────────────────────┘               │
│                    │                                        │
│           ┌───────┼───────┬──────────┐                    │
│           ▼       ▼       ▼          ▼                    │
│  ┌────────┐┌────────┐┌────────┐┌────────┐                 │
│  │微信    ││飞书    ││钉钉    ││企业微信│                 │
│  │WorkBuddy││机器人  ││机器人  ││应用消息│                 │
│  └────────┘└────────┘└────────┘└────────┘                 │
└──────────────────────────────────────────────────────────────┘
```

## 项目结构

```
calguard/
├── src/
│   ├── cli/index.ts              # 命令行入口（Commander.js）
│   ├── config/
│   │   ├── schema.ts             # Zod 运行时配置校验
│   │   └── loader.ts             # YAML 配置加载（支持 ${ENV_VAR}）
│   ├── sources/
│   │   ├── types.ts              # 统一数据模型（CalendarEvent, Message 等）
│   │   ├── calendar/apple.ts     # Apple Calendar（AppleScript）
│   │   └── messages/
│   │       ├── mac_mail.ts       # Mac Mail（SQLite CLI）
│   │       └── email.ts          # IMAP 邮件（imap + mailparser）
│   ├── engine/
│   │   ├── indexer.ts            # 消息索引（JSON 文件存储）
│   │   ├── extractor.ts          # 中英文关键词提取（2-gram/3-gram）
│   │   └── summarizer.ts         # 摘要生成（Claude/OpenAI/本地）
│   ├── notifiers/
│   │   ├── workbuddy.ts          # WorkBuddy 推送（stdout → 微信）
│   │   ├── feishu.ts             # 飞书机器人（HMAC 签名）
│   │   ├── dingtalk.ts           # 钉钉机器人（HMAC 签名）
│   │   ├── wecom.ts              # 企业微信应用消息
│   │   └── email.ts              # 邮件通知（nodemailer）
│   ├── scheduler/cron.ts         # 定时调度（node-cron）
│   └── index.ts                  # 统一导出
├── config.example.yaml            # 配置模板（含详细注释）
├── tsconfig.json
├── package.json
└── README.md
```

## 数据存储

所有数据存储在 `~/.calguard/` 目录下：

| 文件/目录 | 说明 |
|-----------|------|
| `messages.json` | 邮件消息索引 |
| `state.json` | 已发送提醒状态（去重） |
| `config.yaml` | 配置文件（也可放在项目目录） |

## 扩展开发

新增数据源或通知渠道只需实现对应接口。

### 新增消息源

```typescript
// src/sources/messages/my_source.ts
import type { Message, MessageSource } from "../sources/types.js";

export class MySource implements MessageSource {
  readonly name = "my_source";

  async fetchMessages(since: Date): Promise<Message[]> {
    // 拉取消息逻辑
    return [];
  }
}
```

然后在 `src/cli/index.ts` 的 `createPlugins` 中注册，并在 `config/schema.ts` 中添加配置类型。

### 新增通知渠道

```typescript
// src/notifiers/my_notifier.ts
import type { Notifier, NotifyParams } from "../sources/types.js";

export class MyNotifier implements Notifier {
  readonly name = "my_notifier";

  async send(params: NotifyParams): Promise<void> {
    // 发送通知逻辑
  }
}
```

## 常见问题

### Apple Calendar 读取超时

某些日历（如「个人」日历）内容过多，AppleScript 查询会超时。

**解决方案：** 在 `skip_calendars` 中排除大日历：
```yaml
skip_calendars: ["个人", "香港節日", "中国大陆节假日"]
```

### Mac Mail 读取不到邮件

1. 确保已授予**完全磁盘访问权限**（系统偏好设置 → 安全性与隐私 → 完全磁盘访问权限 → Terminal）
2. 授予权限后**重启 Terminal**
3. 确保 Mac Mail 应用已打开过并完成同步
4. 检查数据库路径是否正确（默认 `~/Library/Mail/V10/MailData/Envelope Index`）

### IMAP 连接失败

1. 检查邮箱是否开启了 IMAP 访问
2. Gmail 用户需要使用 **App Password**，不能使用账号密码
3. 企业邮箱可能需要联系 IT 部门获取 IMAP 服务器地址
4. 检查防火墙是否阻止了 993 端口

### 飞书机器人发送失败

1. 检查 Webhook URL 是否正确（包含 access_token）
2. 如果启用了加签，确保 Secret 正确
3. 机器人只能发送到创建它的群聊

### 企业微信发送失败

1. 检查 `corp_id`、`agent_id`、`secret` 是否正确
2. 确保应用已发布且对目标用户可见
3. 检查应用是否有发送消息的权限

## 已知限制

- 当前仅支持 **macOS** 平台
- Apple Calendar 大日历可能导致超时，建议使用 `skip_calendars` 排除
- Google Calendar、飞书日历、钉钉日历、Outlook 数据源待实现
- 飞书消息、钉钉消息、微信本地、短信数据源待实现

## 后续计划

- [ ] Google Calendar 数据源
- [ ] 飞书日历 + 消息数据源
- [ ] 钉钉日历 + 消息数据源
- [ ] 微信本地消息源（wechat-dump-rs）
- [ ] 短信本地消息源
- [ ] `setup` 交互式配置向导
- [ ] 语义检索（向量搜索）
- [ ] Web UI 管理界面

## 技术栈

| 技术 | 用途 |
|------|------|
| TypeScript + ESM | 开发语言和模块系统 |
| Zod | 运行时配置校验 |
| Commander.js | CLI 框架 |
| node-cron | 定时任务调度 |
| imap + mailparser | IMAP 邮件读取 |
| nodemailer | SMTP 邮件发送 |
| YAML | 配置文件格式 |
| AppleScript | Apple Calendar 访问 |
| SQLite CLI | Mac Mail 数据库读取 |

## 许可证

MIT License

## 作者

[Cao](https://github.com/Cao150702)
