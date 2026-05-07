import { z } from "zod";

const feishuSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(""),
  appSecret: z.string().default(""),
  domain: z.enum(["feishu", "lark"]).default("feishu"),
});

const linearSchema = z.object({
  apiKey: z.string().optional(),
});

export const frailConfigSchema = z.object({
  systemPrompt: z.string().default(""),
  workDir: z.string().default(process.cwd()),
  allowedRoots: z.array(z.string()).optional(),
  /** Idle minutes before the daemon auto-rolls onto a fresh session. 0 disables the feature. */
  autoNewSessionIdleMinutes: z.number().int().min(0).default(30),
  feishu: feishuSchema.default(() => feishuSchema.parse({})),
  linear: linearSchema.default(() => linearSchema.parse({})),
});

export type FrailConfig = z.infer<typeof frailConfigSchema>;
