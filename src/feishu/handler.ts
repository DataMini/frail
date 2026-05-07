import type * as Lark from "@larksuiteoapi/node-sdk";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { FrailSession } from "../daemon/session";
import { getLogger } from "../daemon/logger";

interface FeishuMessage {
  chatId: string;
  messageId: string;
  text: string;
  senderId: string;
  images?: ImageContent[];
}

export function createFeishuHandler(
  feishuClient: Lark.Client,
  frail: FrailSession,
  broadcast: (event: object) => void,
) {
  const log = getLogger();

  async function replyToMessage(messageId: string, text: string) {
    const truncated =
      text.length > 10000
        ? text.slice(0, 10000) + "\n\n...(truncated)"
        : text;

    await feishuClient.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text: truncated }),
        msg_type: "text",
      },
    });
  }

  async function onMessage({ chatId, messageId, text, senderId, images }: FeishuMessage) {
    const imageNote = images?.length
      ? ` (+${images.length} image${images.length > 1 ? "s" : ""})`
      : "";
    log.info("Feishu", `[${chatId}] <${senderId}> ${text.slice(0, 100)}${imageNote}`);

    // Tag the next user message so attached TUI clients render [Feishu].
    broadcast({
      type: "frail_source",
      source: "feishu",
      text,
      imageCount: images?.length ?? 0,
    });

    try {
      await frail.prompt(text, "feishu", images);
      const reply = frail.getLastAssistantText() ?? "";
      await replyToMessage(messageId, reply || "（无回复）");

      log.info(
        "Feishu",
        `[${chatId}] Bot: ${reply.slice(0, 100)}${reply.length > 100 ? "..." : ""}`,
      );
    } catch (err) {
      log.error("Feishu", `[${chatId}] Error: ${err}`);
      await replyToMessage(messageId, "抱歉，处理消息时出现错误，请稍后重试。").catch(
        () => undefined,
      );
    }
  }

  return { onMessage };
}
