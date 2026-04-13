import { describe, test, expect } from "bun:test";
import { frailConfigSchema } from "../src/config/schema";

describe("config/schema", () => {
  test("parses empty object with all defaults", () => {
    const config = frailConfigSchema.parse({});
    expect(config.systemPrompt).toBe("");
    expect(config.provider.model).toBe("claude-sonnet-4-20250514");
    expect(config.provider.apiKey).toBeUndefined();
    expect(config.provider.baseURL).toBeUndefined();
    expect(config.feishu.enabled).toBe(false);
    expect(config.feishu.appId).toBe("");
    expect(config.feishu.domain).toBe("feishu");
    expect(config.conversation.maxMessages).toBe(50);
    expect(config.conversation.ttlMinutes).toBe(30);
    expect(config.agent.timeoutMinutes).toBe(5);
  });

  test("respects overrides", () => {
    const config = frailConfigSchema.parse({
      provider: { model: "claude-opus-4-20250515", apiKey: "test-key" },
      feishu: { enabled: true, appId: "abc", appSecret: "def" },
      agent: { timeoutMinutes: 10 },
    });
    expect(config.provider.model).toBe("claude-opus-4-20250515");
    expect(config.provider.apiKey).toBe("test-key");
    expect(config.feishu.enabled).toBe(true);
    expect(config.feishu.appId).toBe("abc");
    expect(config.agent.timeoutMinutes).toBe(10);
  });

  test("rejects invalid types", () => {
    expect(() =>
      frailConfigSchema.parse({ agent: { timeoutMinutes: "not a number" } })
    ).toThrow();
  });

  test("parses provider with baseURL", () => {
    const config = frailConfigSchema.parse({
      provider: {
        baseURL: "https://proxy.example.com",
        model: "claude-sonnet-4-20250514",
      },
    });
    expect(config.provider.baseURL).toBe("https://proxy.example.com");
    expect(config.provider.apiKey).toBeUndefined();
  });
});
