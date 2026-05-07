import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@mariozechner/pi-coding-agent";

const FS_TOOLS = new Set(["read", "ls", "grep", "find"]);

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

function canonicalize(root: string): string {
  return resolve(expandTilde(root));
}

function isInside(absolute: string, root: string): boolean {
  if (absolute === root) return true;
  const r = root.endsWith(sep) ? root : root + sep;
  return absolute.startsWith(r);
}

function isGitIgnored(absolutePath: string, repoRoot: string): boolean {
  try {
    const r = spawnSync("git", ["check-ignore", "-q", "--", absolutePath], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function pathSandboxExtension(
  allowedRoots: string[],
): ExtensionFactory {
  if (allowedRoots.length === 0) {
    throw new Error("pathSandboxExtension requires at least one allowed root");
  }
  const roots = allowedRoots.map(canonicalize);
  const cwdRoot = roots[0]!;
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", (event) => {
      if (!FS_TOOLS.has(event.toolName)) return undefined;
      const raw = (event.input as { path?: string }).path ?? ".";
      const expanded = expandTilde(raw);
      const absolute = isAbsolute(expanded)
        ? resolve(expanded)
        : resolve(cwdRoot, expanded);
      if (!roots.some((r) => isInside(absolute, r))) {
        return {
          block: true,
          reason: `Path "${raw}" is outside the allowed roots (${roots.join(", ")}). The agent can only read files inside the configured workDir / allowedRoots.`,
        };
      }
      if (
        absolute !== cwdRoot &&
        isInside(absolute, cwdRoot) &&
        isGitIgnored(absolute, cwdRoot)
      ) {
        return {
          block: true,
          reason: `Path "${raw}" is git-ignored (matches a rule in .gitignore or .git/info/exclude). The agent cannot access ignored files such as .env, secrets, or build outputs.`,
        };
      }
      return undefined;
    });
  };
}
