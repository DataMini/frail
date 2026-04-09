import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useApp } from "ink";
import { MessageList, type DisplayMessage } from "./MessageList";
import { InputBar } from "./InputBar";
import { StatusBar } from "./StatusBar";
import { IPCClient } from "../daemon/ipc-client";
import type { ToolCallInfo } from "./MessageList";

export function AttachView() {
  const { exit } = useApp();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streaming, setStreaming] = useState<DisplayMessage | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [model, setModel] = useState("");
  const [feishuStatus, setFeishuStatus] = useState<string | undefined>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<IPCClient | null>(null);
  const streamTextRef = useRef("");
  const streamToolsRef = useRef<ToolCallInfo[]>([]);

  useEffect(() => {
    const ipc = new IPCClient();
    clientRef.current = ipc;

    ipc.on("history", (data: any) => {
      setMessages(
        data.messages.map((m: any) => ({
          role: m.role,
          content: m.content,
          source: m.source,
          toolCalls: m.toolCalls,
        }))
      );
    });

    ipc.on("status_update", (data: any) => {
      if (data.model) setModel(data.model);
    });

    ipc.on("status_reply", (data: any) => {
      if (data.model) setModel(data.model);
      // Display as system message
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant" as const,
          content: `Status: pid=${data.pid}, uptime=${data.uptime}s, messages=${data.messageCount}, session=${data.sessionId?.slice(0, 8)}...`,
        },
      ]);
    });

    ipc.on("stream_start", () => {
      setIsLoading(true);
      streamTextRef.current = "";
      streamToolsRef.current = [];
      setStreaming({ role: "assistant", content: "" });
    });

    ipc.on("stream_delta", (data: any) => {
      streamTextRef.current += data.text || "";
      setStreaming({
        role: "assistant",
        content: streamTextRef.current,
        toolCalls: [...streamToolsRef.current],
      });
    });

    ipc.on("stream_tool", (data: any) => {
      const existing = streamToolsRef.current.find(
        (tc) => tc.name === data.name && tc.status === "running"
      );
      if (existing) {
        existing.status = data.status;
        if (data.args) existing.args = data.args;
      } else {
        streamToolsRef.current.push({
          name: data.name,
          args: data.args,
          status: data.status,
        });
      }
      setStreaming({
        role: "assistant",
        content: streamTextRef.current,
        toolCalls: [...streamToolsRef.current],
      });
    });

    ipc.on("stream_end", (data: any) => {
      setIsLoading(false);
      setStreaming(null);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant" as const,
          content: data.fullText || "",
          toolCalls: data.toolCalls,
        },
      ]);
    });

    ipc.on("feishu_incoming", (data: any) => {
      setMessages((prev) => [
        ...prev,
        {
          role: "user" as const,
          content: data.text,
          source: "feishu" as const,
        },
      ]);
    });

    ipc.on("user_message", (data: any) => {
      setMessages((prev) => [
        ...prev,
        {
          role: "user" as const,
          content: data.content,
          source: data.source,
        },
      ]);
    });

    ipc.on("session_reset", () => {
      setMessages([]);
      setStreaming(null);
      setIsLoading(false);
    });

    ipc.on("error", (data: any) => {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant" as const,
          content: `Error: ${data.message || data}`,
        },
      ]);
    });

    ipc.on("disconnected", () => {
      setConnected(false);
      setError("Disconnected from daemon.");
    });

    ipc
      .connect()
      .then(() => {
        setConnected(true);
        ipc.attach();
      })
      .catch((err) => {
        setError(`Failed to connect: ${err.message}`);
      });

    return () => {
      ipc.close();
    };
  }, []);

  const handleSubmit = useCallback((text: string) => {
    const client = clientRef.current;
    if (!client || !client.isConnected()) return;

    if (text === "/quit" || text === "/q") {
      exit();
      return;
    }

    if (text === "/help") {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant" as const,
          content:
            "Commands:\n  /new — Reset session\n  /status — Show daemon status\n  /quit — Exit\n  /help — Show this help",
        },
      ]);
      return;
    }

    if (text.startsWith("/")) {
      const name = text.slice(1).split(/\s+/)[0]!;
      client.sendCommand(name);
      return;
    }

    // Don't add locally — daemon broadcasts user_message back to us
    setIsLoading(true);
    client.sendMessage(text);
  }, [exit]);

  if (error) {
    return (
      <Box padding={1}>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  if (!connected) {
    return (
      <Box padding={1}>
        <Text>Connecting to daemon...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <MessageList
        messages={messages}
        streamingMessage={streaming}
        isLoading={isLoading}
      />
      <InputBar onSubmit={handleSubmit} disabled={isLoading} />
      <StatusBar
        model={model}
        threadTitle="session"
        feishuStatus={feishuStatus}
      />
    </Box>
  );
}
