export type ViewName = "chat" | "threads" | "config" | "help" | "init";

export interface SlashCommand {
  name: string;
  description: string;
  action: "switchView" | "callback";
  view?: ViewName;
  callback?: () => void;
}

export const commands: SlashCommand[] = [
  {
    name: "threads",
    description: "List and switch between threads",
    action: "switchView",
    view: "threads",
  },
  {
    name: "new",
    description: "Create a new thread",
    action: "callback",
  },
  {
    name: "init",
    description: "Run setup wizard",
    action: "switchView",
    view: "init",
  },
  {
    name: "config",
    description: "Open configuration panel",
    action: "switchView",
    view: "config",
  },
  {
    name: "model",
    description: "Quick switch model",
    action: "callback",
  },
  {
    name: "clear",
    description: "Clear current thread messages",
    action: "callback",
  },
  {
    name: "help",
    description: "Show available commands",
    action: "switchView",
    view: "help",
  },
  {
    name: "quit",
    description: "Exit frail",
    action: "callback",
  },
];

export function matchCommand(input: string): SlashCommand | null {
  if (!input.startsWith("/")) return null;
  const name = input.slice(1).split(/\s+/)[0]?.toLowerCase();
  if (!name) return null;
  return commands.find((c) => c.name === name) ?? null;
}

export function getCommandCompletions(partial: string): SlashCommand[] {
  if (!partial.startsWith("/")) return [];
  const prefix = partial.slice(1).toLowerCase();
  return commands.filter((c) => c.name.startsWith(prefix));
}
