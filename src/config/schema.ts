import { z } from "zod";
import { parseReminderOffset } from "../scheduler/reminders.js";

// ── 日历数据源 ──
const AppleCalendarConfigSchema = z.object({
  type: z.literal("apple"),
  enabled: z.boolean().default(true),
  skip_calendars: z.array(z.string()).default(["个人", "香港節日", "中国大陆节假日"]),
  timeout_seconds: z.number().default(45),
});

const GoogleCalendarConfigSchema = z.object({
  type: z.literal("google"),
  enabled: z.boolean().default(true),
  credentials_file: z.string().default("~/.calguard/google_credentials.json"),
  calendar_ids: z.array(z.string()).default(["primary"]),
});

const FeishuCalendarConfigSchema = z.object({
  type: z.literal("feishu"),
  enabled: z.boolean().default(true),
  app_id: z.string(),
  app_secret: z.string(),
});

const DingtalkCalendarConfigSchema = z.object({
  type: z.literal("dingtalk"),
  enabled: z.boolean().default(false),
  app_key: z.string(),
  app_secret: z.string(),
  union_id: z.string().optional(),
});

const OutlookCalendarConfigSchema = z.object({
  type: z.literal("outlook"),
  enabled: z.boolean().default(false),
  tenant_id: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
});

export const CalendarSourceConfigSchema = z.discriminatedUnion("type", [
  AppleCalendarConfigSchema,
  GoogleCalendarConfigSchema,
  FeishuCalendarConfigSchema,
  DingtalkCalendarConfigSchema,
  OutlookCalendarConfigSchema,
]);

// ── 消息数据源 ──
const ImapConfigSchema = z.object({
  host: z.string(),
  port: z.number().default(993),
  tls: z.boolean().default(true),
  user: z.string(),
  password: z.string(),
  folders: z.array(z.string()).default(["INBOX"]),
});

const EmailMessageConfigSchema = z.object({
  type: z.literal("email"),
  enabled: z.boolean().default(true),
  imap: ImapConfigSchema,
});

const FeishuMessageConfigSchema = z.object({
  type: z.literal("feishu_message"),
  enabled: z.boolean().default(true),
  app_id: z.string(),
  app_secret: z.string(),
});

const DingtalkMessageConfigSchema = z.object({
  type: z.literal("dingtalk_message"),
  enabled: z.boolean().default(false),
  app_key: z.string(),
  app_secret: z.string(),
});

const WechatLocalConfigSchema = z.object({
  type: z.literal("wechat_local"),
  enabled: z.boolean().default(false),
  db_path: z.string().optional(),
});

const SmsLocalConfigSchema = z.object({
  type: z.literal("sms_local"),
  enabled: z.boolean().default(false),
  db_path: z.string().default("~/Library/Messages/chat.db"),
});

const MacMailConfigSchema = z.object({
  type: z.literal("mac_mail"),
  enabled: z.boolean().default(true),
  db_path: z.string().default("~/Library/Mail/V10/MailData/Envelope Index"),
});

export const MessageSourceConfigSchema = z.discriminatedUnion("type", [
  EmailMessageConfigSchema,
  FeishuMessageConfigSchema,
  DingtalkMessageConfigSchema,
  WechatLocalConfigSchema,
  SmsLocalConfigSchema,
  MacMailConfigSchema,
]);

// ── 通知渠道 ──
const SmtpConfigSchema = z.object({
  host: z.string(),
  port: z.number().default(587),
  user: z.string(),
  password: z.string(),
  to: z.string(),
  subject_prefix: z.string().default("[CalGuard]"),
});

const FeishuBotConfigSchema = z.object({
  type: z.literal("feishu_bot"),
  enabled: z.boolean().default(false),
  webhook: z.string(),
  secret: z.string().optional(),
  template: z.enum(["full", "checklist"]).default("full"),
});

const EmailNotifyConfigSchema = z.object({
  type: z.literal("email"),
  enabled: z.boolean().default(false),
  smtp: SmtpConfigSchema,
});

const DingtalkBotConfigSchema = z.object({
  type: z.literal("dingtalk_bot"),
  enabled: z.boolean().default(false),
  webhook: z.string(),
  secret: z.string().optional(),
});

const WecomConfigSchema = z.object({
  type: z.literal("wecom"),
  enabled: z.boolean().default(false),
  corp_id: z.string(),
  agent_id: z.string(),
  secret: z.string(),
  to_user: z.string().default("@all"),
});

const WorkbuddyConfigSchema = z.object({
  type: z.literal("workbuddy"),
  enabled: z.boolean().default(true),
  template: z.enum(["full", "checklist"]).default("full"),
});

export const NotifierConfigSchema = z.discriminatedUnion("type", [
  FeishuBotConfigSchema,
  EmailNotifyConfigSchema,
  DingtalkBotConfigSchema,
  WecomConfigSchema,
  WorkbuddyConfigSchema,
]);

// ── LLM 配置 ──
export const LlmConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai", "none"]).default("none"),
  model: z.string().default("claude-sonnet-4-20250514"),
  api_key: z.string().default(""),
  max_tokens: z.number().default(1000),
});

// ── 完整配置 ──
export const CalGuardConfigSchema = z.object({
  sources: z.object({
    calendars: z.array(CalendarSourceConfigSchema).default([]),
    messages: z.array(MessageSourceConfigSchema).default([]),
  }),
  engine: z.object({
    fetch_interval_minutes: z.number().default(30),
    lookback_days: z.number().default(3),
    summary_mode: z.enum(["concise", "standard", "detailed"]).default("standard"),
    skip_summary_if_no_match: z.boolean().default(true),
    correlation_threshold: z.number().min(0).max(1).default(0.3),
  }),
  notifications: z.object({
    remind_at: z.array(z.string().refine(
      (value: string) => parseReminderOffset(value) !== undefined,
      "提醒时间必须是正整数分钟或小时（如 15m、1h、24h），最多 365 天"
    )).default(["24h", "1h"]),
    channels: z.array(NotifierConfigSchema).default([]),
  }),
  llm: LlmConfigSchema.default({}),
});

export type CalGuardConfig = z.infer<typeof CalGuardConfigSchema>;
export type CalendarSourceConfig = z.infer<typeof CalendarSourceConfigSchema>;
export type MessageSourceConfig = z.infer<typeof MessageSourceConfigSchema>;
export type NotifierConfig = z.infer<typeof NotifierConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
