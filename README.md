# CalGuard - 智能日程守护助手

> 自动读取你的日历和邮件，在会议前推送智能简报到微信、飞书、邮箱。

## 核心功能

- **日程感知** — 自动读取 Apple Calendar（后续支持 Google 日历、飞书日历）
- **邮件关联** — 读取本地 Mac Mail 邮件，与日程事件智能匹配
- **关键词提取** — 中英文混合关键词提取，支持 2-gram/3-gram 滑动窗口
- **智能简报** — 三种摘要模式（简洁/标准/详细），支持 Claude/OpenAI API 或纯本地生成
- **多通道推送** — WorkBuddy（→微信）、飞书机器人、邮件通知
- **定时守护** — 支持 cron 定时执行或单次模式（兼容 WorkBuddy 自动化）

## 系统架构

```
┌──────────────────────────────────────────────┐
│                 CalGuard Agent                │
├──────────┬──────────┬──────────┬─────────────┤
│ 数据源    │ 数据源    │ 处理引擎  │  通知渠道    │
│          │          │          │             │
│ Apple    │ Mac Mail │ 消息索引  │ WorkBuddy   │
│ Calendar │ (SQLite) │ 关键词提取│ 飞书机器人    │
│          │          │ 简报生成  │ 邮件推送     │
└──────────┴──────────┴──────────┴─────────────┘
```

## 快速开始

### 环境要求

- Node.js >= 18（推荐 24+）
- macOS（当前仅支持 Apple Calendar + Mac Mail）

### 安装

```bash
git clone https://github.com/Cao150702/calguard.git
cd calguard
npm install
npm run build
```

### 配置

复制配置模板并按需修改：

```bash
cp config.example.yaml config.yaml
```

编辑 `config.yaml`：

```yaml
sources:
  calendars:
    - type: apple
      enabled: true
      skip_calendars:        # 跳过大日历，避免 AppleScript 超时
        - "个人"
        - "香港節日"
        - "中国大陆节假日"
      timeout_seconds: 45

  messages:
    - type: mac_mail
      enabled: true
      db_path: ~/Library/Mail/V10/MailData/Envelope Index

notifications:
  channels:
    - type: workbuddy        # stdout → WorkBuddy → 微信推送
      enabled: true
      template: full

llm:
  provider: none             # 设为 anthropic/openai 启用 LLM 摘要
```

### 使用

```bash
# 查看即将到来的日程
npx calguard events --hours 24

# 手动拉取邮件并建立索引
npx calguard fetch

# 预览日程简报（不发送通知）
npx calguard preview --mode standard

# 启动守护进程（持续运行）
npx calguard start

# 单次执行（适合 WorkBuddy 定时任务）
npx calguard start --once

# 查看运行状态
npx calguard status

# 校验配置文件
npx calguard config validate
```

## 项目结构

```
calguard/
├── src/
│   ├── cli/index.ts           # 命令行入口（Commander.js）
│   ├── config/
│   │   ├── schema.ts          # Zod 配置校验
│   │   └── loader.ts          # YAML 配置加载（支持 ${ENV_VAR}）
│   ├── sources/
│   │   ├── types.ts           # 统一数据模型
│   │   ├── calendar/apple.ts  # Apple Calendar（AppleScript）
│   │   └── messages/mac_mail.ts  # Mac Mail（SQLite CLI）
│   ├── engine/
│   │   ├── indexer.ts         # 消息索引（JSON 文件存储）
│   │   ├── extractor.ts       # 中英文关键词提取
│   │   └── summarizer.ts      # 摘要生成（LLM / 本地）
│   ├── notifiers/
│   │   ├── workbuddy.ts       # WorkBuddy 推送（stdout → 微信）
│   │   ├── feishu.ts          # 飞书机器人（HMAC 签名）
│   │   └── email.ts           # 邮件通知（nodemailer）
│   ├── scheduler/cron.ts      # 定时调度（node-cron）
│   └── index.ts               # 统一导出
├── config.example.yaml         # 配置模板
├── tsconfig.json
├── package.json
└── README.md
```

## 技术栈

| 技术 | 用途 |
|------|------|
| TypeScript + ESM | 开发语言和模块系统 |
| Zod | 运行时配置校验 |
| Commander.js | CLI 框架 |
| node-cron | 定时任务调度 |
| YAML | 配置文件格式 |
| AppleScript | 读取 Apple Calendar |
| SQLite CLI | 读取 Mac Mail 本地数据库 |
| nodemailer | 邮件发送 |
| Node Fetch | HTTP 请求（LLM API / 飞书 Webhook） |

## 数据存储

所有数据存储在 `~/.calguard/` 目录下：

| 文件 | 说明 |
|------|------|
| `messages.json` | 邮件消息索引 |
| `state.json` | 已发送提醒状态（去重） |
| `config.yaml` | 配置文件（也可放在项目目录） |

## 通知渠道说明

### WorkBuddy（推荐）

输出 Markdown 格式简报到 stdout，WorkBuddy 自动捕获并推送到微信。

支持两种模板：
- `full` — 完整简报（含关联消息详情）
- `checklist` — 精简清单（仅关键信息）

### 飞书机器人

通过 Webhook 发送交互式卡片消息，支持 HMAC-SHA256 签名验证。

### 邮件通知

通过 SMTP 发送 HTML 格式邮件。

## 开发

```bash
# 开发模式（直接运行 TypeScript）
npm run dev -- <子命令>

# 构建
npm run build

# 类型检查
npx tsc --noEmit
```

## 已知限制

- 当前仅支持 macOS 平台
- Apple Calendar 大日历（如"个人"日历）可能导致 AppleScript 超时，建议通过 `skip_calendars` 排除
- Mac Mail 数据库访问需要 macOS 完全磁盘访问权限
- LLM 摘要功能需要配置 API Key，默认使用本地生成

## 后续计划

- [ ] Google Calendar 数据源
- [ ] 飞书日历和消息数据源
- [ ] IMAP 邮件数据源（Gmail / 企业邮箱）
- [ ] 钉钉、企业微信通知渠道
- [ ] 微信本地数据库消息源
- [ ] 短信消息源
- [ ] Web UI 管理界面

## 许可证

MIT License

## 作者

[Cao](https://github.com/Cao150702)
