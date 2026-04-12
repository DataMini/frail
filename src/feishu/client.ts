import * as Lark from "@larksuiteoapi/node-sdk";
import * as fs from "fs";
import * as path from "path";
import type { FrailConfig } from "../config/schema";
import { createFeishuHandler } from "./handler";
import { getLogger } from "../daemon/logger";
import type { AgentSession } from "../daemon/session";

// Uploads dir is set per-session inside startFeishuClient based on config.workDir

let wsClient: Lark.WSClient | null = null;
export type FeishuConnectionStatus = "not configured" | "connecting" | "connected" | "error";

let feishuStatus: FeishuConnectionStatus = "not configured";
let firstMessageReceived = false;

export function getFeishuStatus(): FeishuConnectionStatus {
  return feishuStatus;
}

export function startFeishuClient(
  config: FrailConfig,
  session: AgentSession,
  broadcast: (event: object) => void
) {
  const log = getLogger();
  const baseConfig = {
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
  };

  const domain =
    config.feishu.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;

  const feishuClient = new Lark.Client({
    ...baseConfig,
    appType: Lark.AppType.SelfBuild,
    domain,
  });

  const uploadsDir = path.join(config.workDir, ".frail", "uploads");

  feishuStatus = "connecting";
  firstMessageReceived = false;
  const { onMessage } = createFeishuHandler(feishuClient, session, broadcast);

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: any) => {
      // Log raw event for debugging
      const msgType = data?.message?.message_type ?? "unknown";
      const chatId = data?.message?.chat_id ?? "?";
      const msgId = data?.message?.message_id ?? "?";
      log.info("Feishu", `Event received: type=${msgType} chat=${chatId} msg=${msgId}`);

      if (!firstMessageReceived) {
        firstMessageReceived = true;
        feishuStatus = "connected";
        log.info("Feishu", "Connection confirmed (first message received)");
      }
      try {
        const msg = data.message;
        if (!msg) {
          log.warn("Feishu", `Event has no message field: ${JSON.stringify(data).slice(0, 200)}`);
          return;
        }

        const { chat_id, message_id, content, message_type, sender } = msg;
        const senderId = sender?.sender_id?.open_id ?? "unknown";

        if (message_type === "text") {
          const text = extractText(content);
          if (!text) return;

          onMessage({ chatId: chat_id, messageId: message_id, text, senderId }).catch(
            (err: unknown) => log.error("Feishu", `Handler error: ${err}`)
          );
        } else if (message_type === "image") {
          try {
            const imageKey = JSON.parse(content).image_key;
            const localPath = await downloadImage(config.feishu.appId, config.feishu.appSecret, message_id, imageKey, uploadsDir);
            const text = `[用户发送了一张图片，已保存到 ${localPath}，请用 Read 工具查看并分析]`;
            onMessage({ chatId: chat_id, messageId: message_id, text, senderId }).catch(
              (err: unknown) => log.error("Feishu", `Handler error: ${err}`)
            );
          } catch (err) {
            log.error("Feishu", `Image download failed: ${err}`);
          }
        } else if (message_type === "post") {
          log.info("Feishu", `Post content: ${content.slice(0, 500)}`);
          try {
            const { text, imageKeys } = extractPost(content);
            log.info("Feishu", `Post parsed: text="${text.slice(0, 100)}" images=${imageKeys.length}`);
            // Download images with timeout, don't block text processing
            const imagePaths: string[] = [];
            for (const key of imageKeys) {
              try {
                log.info("Feishu", `Downloading image: ${key}`);
                const p = await Promise.race([
                  downloadImage(config.feishu.appId, config.feishu.appSecret, message_id, key, uploadsDir),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error("Download timeout (10s)")), 10000)
                ),
                ]);
                imagePaths.push(p);
                log.info("Feishu", `Image saved: ${p}`);
              } catch (err) {
                log.error("Feishu", `Image download failed for ${key}: ${err}`);
              }
            }
            let prompt = text;
            if (imagePaths.length > 0) {
              prompt += `\n[用户发送了 ${imagePaths.length} 张图片：${imagePaths.join(", ")}，请用 Read 工具查看并分析]`;
            }
            log.info("Feishu", `Post prompt: "${prompt.slice(0, 100)}"`);
            if (prompt.trim()) {
              onMessage({ chatId: chat_id, messageId: message_id, text: prompt.trim(), senderId }).catch(
                (err: unknown) => log.error("Feishu", `Handler error: ${err}`)
              );
            }
          } catch (err) {
            log.error("Feishu", `Post parse failed: ${err}`);
          }
        } else {
          log.warn("Feishu", `Unsupported message type: ${message_type}`);
        }
      } catch (err) {
        log.error("Feishu", `Event dispatch error: ${err}`);
      }
    },
  });

  wsClient = new Lark.WSClient({
    ...baseConfig,
    loggerLevel: Lark.LoggerLevel.info,
    logger: {
      info: (...args: any[]) => log.info("Feishu:SDK", args.map(String).join(" ")),
      warn: (...args: any[]) => log.warn("Feishu:SDK", args.map(String).join(" ")),
      error: (...args: any[]) => log.error("Feishu:SDK", args.map(String).join(" ")),
      debug: () => {},
      trace: () => {},
      log: (...args: any[]) => log.info("Feishu:SDK", args.map(String).join(" ")),
    } as any,
  });

  try {
    wsClient.start({ eventDispatcher });
    log.info("Feishu", "WebSocket client started");

    // Lark SDK doesn't expose a connection callback.
    // WSClient logs "ws client ready" after successful connect (~1-2s).
    // Mark as connected after a short delay if no error occurred.
    setTimeout(() => {
      if (feishuStatus === "connecting") {
        feishuStatus = "connected";
        log.info("Feishu", "WebSocket connected");
      }
    }, 5000);
  } catch (err) {
    feishuStatus = "error";
    throw err;
  }
}

function extractPost(content: string): { text: string; imageKeys: string[] } {
  try {
    const parsed = JSON.parse(content);
    // content 可能直接在顶层，也可能在 zh_cn/en_us 等 locale key 下
    const body = parsed.content
      ? parsed
      : (parsed.zh_cn || parsed.en_us || Object.values(parsed)[0] as any);
    if (!body?.content) return { text: "", imageKeys: [] };

    const texts: string[] = [];
    const imageKeys: string[] = [];

    for (const paragraph of body.content) {
      if (!Array.isArray(paragraph)) continue;
      for (const elem of paragraph) {
        if (elem.tag === "text") {
          texts.push(elem.text ?? "");
        } else if (elem.tag === "img") {
          if (elem.image_key) imageKeys.push(elem.image_key);
        }
      }
    }

    const title = body.title ? `${body.title}\n` : "";
    const text = (title + texts.join("")).replace(/@_user_\d+/g, "").replace(/@_all/g, "").trim();
    return { text, imageKeys };
  } catch {
    return { text: "", imageKeys: [] };
  }
}

function extractText(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    let text = parsed.text ?? "";
    text = text.replace(/@_user_\d+/g, "").replace(/@_all/g, "").trim();
    return text || null;
  } catch {
    return null;
  }
}

let tenantToken: string | null = null;
let tokenExpiry = 0;

async function getTenantToken(appId: string, appSecret: string): Promise<string> {
  if (tenantToken && Date.now() < tokenExpiry) return tenantToken;

  const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await resp.json() as any;
  if (data.code !== 0) throw new Error(`Token error: ${data.msg}`);

  tenantToken = data.tenant_access_token;
  tokenExpiry = Date.now() + (data.expire - 60) * 1000; // refresh 1 min early
  return tenantToken!;
}

async function downloadImage(
  appId: string,
  appSecret: string,
  messageId: string,
  fileKey: string,
  uploadsDir: string,
): Promise<string> {
  const log = getLogger();
  fs.mkdirSync(uploadsDir, { recursive: true });

  const token = await getTenantToken(appId, appSecret);
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=image`;

  log.info("Feishu", `Downloading image: ${fileKey} from message ${messageId}`);

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Image download failed: ${resp.status} ${body.slice(0, 200)}`);
  }

  const contentType = resp.headers.get("content-type") || "image/png";
  const ext = contentType.includes("jpeg") ? "jpg" : "png";
  const filePath = path.join(uploadsDir, `${Date.now()}_${fileKey}.${ext}`);

  const buf = await resp.arrayBuffer();
  fs.writeFileSync(filePath, Buffer.from(buf));

  log.info("Feishu", `Image saved: ${filePath} (${buf.byteLength} bytes)`);
  return filePath;
}

export function stopFeishuClient() {
  wsClient = null;
  feishuStatus = "not configured";
  firstMessageReceived = false;
}
