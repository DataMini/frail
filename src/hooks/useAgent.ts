import { useState, useCallback } from "react";
import { streamChat } from "../ai/agent";
import type { DisplayMessage, ToolCallInfo } from "../components/MessageList";

interface UseAgentReturn {
  isLoading: boolean;
  streamingMessage: DisplayMessage | null;
  sendMessage: (
    text: string,
    onComplete: (text: string, toolCalls: ToolCallInfo[]) => void
  ) => void;
}

function summarizeArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // Show first meaningful arg value, truncated
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const str = typeof v === "string" ? v : JSON.stringify(v);
    const truncated = str.length > 60 ? str.slice(0, 60) + "..." : str;
    parts.push(truncated);
    if (parts.length >= 2) break; // max 2 args shown
  }
  return parts.join(", ");
}

export function useAgent(): UseAgentReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessage, setStreamingMessage] =
    useState<DisplayMessage | null>(null);
  // Tool call state is tracked inline in streamingMessage.toolCalls

  const sendMessage = useCallback(
    (
      text: string,
      onComplete: (text: string, toolCalls: ToolCallInfo[]) => void
    ) => {
      setIsLoading(true);
      setStreamingMessage({ role: "assistant", content: "" });

      (async () => {
        let fullText = "";
        const toolCalls: ToolCallInfo[] = [];

        try {
          for await (const msg of streamChat(text)) {
            switch (msg.type) {
              case "stream_event": {
                const event = msg.event;

                // Tool use start — extract name + args
                if (event.type === "content_block_start") {
                  const block = (event as any).content_block;
                  if (block?.type === "tool_use") {
                    const tc: ToolCallInfo = {
                      name: block.name,
                      args: summarizeArgs(block.input),
                      status: "running",
                    };
                    toolCalls.push(tc);
                    setStreamingMessage({
                      role: "assistant",
                      content: fullText,
                      toolCalls: [...toolCalls],
                    });
                  }
                }

                // Tool use input accumulating (input_json_delta)
                if (
                  event.type === "content_block_delta" &&
                  "delta" in event
                ) {
                  const delta = event.delta;
                  if (delta.type === "text_delta") {
                    fullText += (delta as any).text;
                    setStreamingMessage({
                      role: "assistant",
                      content: fullText,
                      toolCalls: [...toolCalls],
                    });
                  }
                }

                // Content block stop — mark tool as done
                if (event.type === "content_block_stop") {
                  if (toolCalls.length > 0) {
                    const last = toolCalls[toolCalls.length - 1]!;
                    if (last.status === "running") {
                      last.status = "done";
                                      setStreamingMessage({
                        role: "assistant",
                        content: fullText,
                        toolCalls: [...toolCalls],
                      });
                    }
                  }
                }
                break;
              }
              case "assistant": {
                // Complete assistant message — extract text + tool calls
                const content = msg.message?.content;
                if (Array.isArray(content)) {
                  let msgText = "";
                  for (const block of content) {
                    if (block.type === "text") {
                      msgText = block.text;
                    } else if (block.type === "tool_use") {
                      // Check if we already tracked this tool call via stream_event
                      const existing = toolCalls.find(
                        (tc) =>
                          tc.name === block.name && tc.status === "running"
                      );
                      if (existing) {
                        existing.args = summarizeArgs(block.input);
                        existing.status = "done";
                      } else {
                        toolCalls.push({
                          name: block.name,
                          args: summarizeArgs(block.input),
                          status: "done",
                        });
                      }
                    }
                  }
                  if (msgText) fullText = msgText;
                              setStreamingMessage({
                    role: "assistant",
                    content: fullText,
                    toolCalls: [...toolCalls],
                  });
                }
                break;
              }
              case "result": {
                if ("subtype" in msg && msg.subtype === "success") {
                  fullText = (msg as any).result;
                } else if ("is_error" in msg && (msg as any).is_error) {
                  fullText = `Error: ${(msg as any).error ?? "Unknown error"}`;
                }
                break;
              }
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("API key")) {
            fullText = `Error: ${errMsg}\n\nRun /init to configure your API key.`;
          } else {
            fullText = fullText
              ? fullText + `\n\nError: ${errMsg}`
              : `Error: ${errMsg}`;
          }
        }

        // Mark any remaining running tools as done
        for (const tc of toolCalls) {
          if (tc.status === "running") tc.status = "done";
        }

        setStreamingMessage(null);
          setIsLoading(false);

        onComplete(fullText, toolCalls);
      })();
    },
    []
  );

  return { isLoading, streamingMessage, sendMessage };
}
