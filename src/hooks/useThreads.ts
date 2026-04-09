import { useState, useCallback, useEffect, useRef } from "react";
import * as db from "../db/threads";
import type { DisplayMessage } from "../components/MessageList";

export function useThreads() {
  const [currentThread, setCurrentThread] = useState<db.Thread | null>(null);
  const [threads, setThreads] = useState<db.Thread[]>([]);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);

  // Use ref so callbacks don't depend on currentThread state
  const threadRef = useRef<db.Thread | null>(null);

  function setThread(t: db.Thread | null) {
    threadRef.current = t;
    setCurrentThread(t);
  }

  // Load threads on mount, create default if empty
  useEffect(() => {
    const all = db.listThreads();
    if (all.length === 0) {
      const t = db.createThread("main");
      setThreads([t]);
      setThread(t);
    } else {
      setThreads(all);
      setThread(all[0]!);
      const modelMsgs = db.getMessages(all[0]!.id);
      setMessages(modelMsgs.map(toDisplayMessage));
    }
  }, []);

  const refreshThreads = useCallback(() => {
    setThreads(db.listThreads());
  }, []);

  const switchThread = useCallback((threadId: string) => {
    const thread = db.getThread(threadId);
    if (!thread) return;
    setThread(thread);
    const modelMsgs = db.getMessages(threadId);
    setMessages(modelMsgs.map(toDisplayMessage));
  }, []);

  const createThread = useCallback((title?: string) => {
    const t = db.createThread(title ?? "New Thread");
    setThreads(db.listThreads());
    setThread(t);
    setMessages([]);
    return t;
  }, []);

  const addUserMessage = useCallback((text: string) => {
    const thread = threadRef.current;
    if (!thread) return;
    const msg: db.ChatMessage = { role: "user", content: text };
    db.addMessage(thread.id, msg);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
  }, []);

  const addAssistantMessage = useCallback(
    (content: string, toolCalls?: import("../components/MessageList").ToolCallInfo[]) => {
      const thread = threadRef.current;
      if (!thread) return;
      if (!content && (!toolCalls || toolCalls.length === 0)) return;
      if (content) {
        const msg: db.ChatMessage = { role: "assistant", content };
        db.addMessage(thread.id, msg);
      }
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content, toolCalls },
      ]);
    },
    []
  );

  const clearMessages = useCallback(() => {
    const thread = threadRef.current;
    if (!thread) return;
    db.clearMessages(thread.id);
    setMessages([]);
  }, []);

  return {
    currentThread,
    threads,
    messages,
    switchThread,
    createThread,
    addUserMessage,
    addAssistantMessage,
    clearMessages,
    refreshThreads,
  };
}

function toDisplayMessage(msg: db.ChatMessage): DisplayMessage {
  return { role: msg.role, content: msg.content };
}
