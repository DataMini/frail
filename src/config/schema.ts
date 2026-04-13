import { z } from "zod";

const feishuSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(""),
  appSecret: z.string().default(""),
  domain: z.enum(["feishu", "lark"]).default("feishu"),
});

const conversationSchema = z.object({
  maxMessages: z.number().default(50),
  ttlMinutes: z.number().default(30),
});

const agentSchema = z.object({
  timeoutMinutes: z.number().default(5),
});

const providerSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  model: z.string().default("claude-sonnet-4-20250514"),
});

const mcpHttpServerSchema = z.object({
  type: z.literal("http").optional().default("http"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const frailConfigSchema = z.object({
  systemPrompt: z.string().default(""),
  workDir: z.string().default(process.cwd()),
  provider: providerSchema.default(() => providerSchema.parse({})),
  feishu: feishuSchema.default(() => feishuSchema.parse({})),
  conversation: conversationSchema.default(() => conversationSchema.parse({})),
  agent: agentSchema.default(() => agentSchema.parse({})),
  mcpServers: z.record(z.string(), mcpHttpServerSchema).default(() => ({})),
});

export type FrailConfig = z.infer<typeof frailConfigSchema>;
