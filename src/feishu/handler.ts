import type * as Lark from "@larksuiteoapi/node-sdk";
import type { AgentSession } from "../daemon/session";
import { getLogger } from "../daemon/logger";

interface FeishuMessage {
  chatId: string;
  messageId: string;
  text: string;
  senderId: string;
}

export function createFeishuHandler(
  feishuClient: Lark.Client,
  session: AgentSession,
  broadcast: (event: object) => void
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

  async function onMessage({ chatId, messageId, text, senderId }: FeishuMessage) {
    log.info("Feishu", `[${chatId}] <${senderId}> ${text.slice(0, 100)}`);

    // Broadcast to attached TUI clients
    broadcast({ type: "feishu_incoming", chatId, senderId, text });

    try {
      const reply = await session.chat(text, "feishu", (event) => broadcast(event));
      await replyToMessage(messageId, reply || "（无回复）");

      log.info(
        "Feishu",
        `[${chatId}] Bot: ${(reply || "").slice(0, 100)}${(reply || "").length > 100 ? "..." : ""}`
      );
    } catch (err) {
      log.error("Feishu", `[${chatId}] Error: ${err}`);
      await replyToMessage(messageId, "抱歉，处理消息时出现错误，请稍后重试。").catch(() => {});
    }
  }

  return { onMessage };
}
