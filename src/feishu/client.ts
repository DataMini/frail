import * as Lark from "@larksuiteoapi/node-sdk";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { FrailConfig } from "../config/schema";
import { createFeishuHandler } from "./handler";
import { getLogger } from "../daemon/logger";
import type { FrailSession } from "../daemon/session";

let wsClient: Lark.WSClient | null = null;
export type FeishuConnectionStatus = "not configured" | "connecting" | "connected" | "error";

let feishuStatus: FeishuConnectionStatus = "not configured";
let firstMessageReceived = false;

export function getFeishuStatus(): FeishuConnectionStatus {
  return feishuStatus;
}

export function startFeishuClient(
  config: FrailConfig,
  frail: FrailSession,
  broadcast: (event: object) => void,
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

  feishuStatus = "connecting";
  firstMessageReceived = false;
  const { onMessage } = createFeishuHandler(feishuClient, frail, broadcast);

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
        const ctx: MessageContext = {
          chatId: chat_id,
          messageId: message_id,
          senderId,
          appId: config.feishu.appId,
          appSecret: config.feishu.appSecret,
          onMessage,
        };

        switch (message_type) {
          case "text":
            await handleTextMessage(ctx, content);
            break;
          case "image":
            await handleImageMessage(ctx, content);
            break;
          case "post":
            await handlePostMessage(ctx, content);
            break;
          default:
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

interface MessageContext {
  chatId: string;
  messageId: string;
  senderId: string;
  appId: string;
  appSecret: string;
  onMessage: (msg: {
    chatId: string;
    messageId: string;
    text: string;
    senderId: string;
    images?: ImageContent[];
  }) => Promise<void>;
}

const IMAGE_FETCH_TIMEOUT_MS = 10_000;

function dispatch(
  ctx: MessageContext,
  text: string,
  images?: ImageContent[],
): void {
  ctx.onMessage({
    chatId: ctx.chatId,
    messageId: ctx.messageId,
    text,
    senderId: ctx.senderId,
    images,
  }).catch((err: unknown) =>
    getLogger().error("Feishu", `Handler error: ${err}`),
  );
}

async function handleTextMessage(ctx: MessageContext, content: string): Promise<void> {
  const text = extractText(content);
  if (!text) return;
  dispatch(ctx, text);
}

async function handleImageMessage(ctx: MessageContext, content: string): Promise<void> {
  const log = getLogger();
  try {
    const imageKey = JSON.parse(content).image_key;
    const image = await fetchImage(ctx.appId, ctx.appSecret, ctx.messageId, imageKey);
    dispatch(ctx, "(图片)", [image]);
  } catch (err) {
    log.error("Feishu", `Image fetch failed: ${err}`);
  }
}

async function handlePostMessage(ctx: MessageContext, content: string): Promise<void> {
  const log = getLogger();
  log.info("Feishu", `Post content: ${content.slice(0, 500)}`);
  let parsed: { text: string; imageKeys: string[] };
  try {
    parsed = extractPost(content);
  } catch (err) {
    log.error("Feishu", `Post parse failed: ${err}`);
    return;
  }
  const { text, imageKeys } = parsed;
  log.info("Feishu", `Post parsed: text="${text.slice(0, 100)}" images=${imageKeys.length}`);

  const results = await Promise.all(
    imageKeys.map(async (key) => {
      try {
        return await Promise.race([
          fetchImage(ctx.appId, ctx.appSecret, ctx.messageId, key),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Fetch timeout (${IMAGE_FETCH_TIMEOUT_MS}ms)`)),
              IMAGE_FETCH_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (err) {
        log.error("Feishu", `Image fetch failed for ${key}: ${err}`);
        return null;
      }
    }),
  );
  const images = results.filter((r): r is ImageContent => r !== null);

  const finalText = text.trim() || (images.length > 0 ? "(图片)" : "");
  log.info("Feishu", `Post prompt: "${finalText.slice(0, 100)}" images=${images.length}`);
  if (!finalText && images.length === 0) return;
  dispatch(ctx, finalText, images.length > 0 ? images : undefined);
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

async function fetchImage(
  appId: string,
  appSecret: string,
  messageId: string,
  fileKey: string,
): Promise<ImageContent> {
  const log = getLogger();
  const token = await getTenantToken(appId, appSecret);
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=image`;

  log.info("Feishu", `Fetching image: ${fileKey} from message ${messageId}`);

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Image fetch failed: ${resp.status} ${body.slice(0, 200)}`);
  }

  const mimeType = resp.headers.get("content-type") || "image/png";
  const buf = await resp.arrayBuffer();
  const data = Buffer.from(buf).toString("base64");

  log.info("Feishu", `Image fetched: ${fileKey} (${buf.byteLength} bytes, ${mimeType})`);
  return { type: "image", data, mimeType };
}

export function stopFeishuClient() {
  wsClient = null;
  feishuStatus = "not configured";
  firstMessageReceived = false;
}
