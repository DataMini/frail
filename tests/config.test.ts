import { describe, test, expect } from "bun:test";
import { frailConfigSchema } from "../src/config/schema";

describe("config/schema", () => {
  test("parses empty object with all defaults", () => {
    const config = frailConfigSchema.parse({});
    expect(config.systemPrompt).toBe("");
    expect(config.feishu.enabled).toBe(false);
    expect(config.feishu.appId).toBe("");
    expect(config.feishu.domain).toBe("feishu");
    expect(config.linear?.apiKey).toBeUndefined();
    expect(typeof config.workDir).toBe("string");
  });

  test("respects overrides", () => {
    const config = frailConfigSchema.parse({
      systemPrompt: "custom",
      feishu: { enabled: true, appId: "abc", appSecret: "def", domain: "lark" },
      linear: { apiKey: "lin_api_xyz" },
    });
    expect(config.systemPrompt).toBe("custom");
    expect(config.feishu.enabled).toBe(true);
    expect(config.feishu.appId).toBe("abc");
    expect(config.feishu.domain).toBe("lark");
    expect(config.linear?.apiKey).toBe("lin_api_xyz");
  });

  test("rejects invalid feishu domain", () => {
    expect(() =>
      frailConfigSchema.parse({ feishu: { domain: "bogus" } }),
    ).toThrow();
  });
});
