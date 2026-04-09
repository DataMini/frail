import { describe, test, expect } from "bun:test";
import { matchCommand, getCommandCompletions } from "../src/commands/index";

describe("commands", () => {
  test("matchCommand returns command for valid input", () => {
    const cmd = matchCommand("/threads");
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe("threads");
  });

  test("matchCommand returns null for non-slash input", () => {
    expect(matchCommand("hello")).toBeNull();
  });

  test("matchCommand returns null for unknown command", () => {
    expect(matchCommand("/unknown")).toBeNull();
  });

  test("matchCommand ignores arguments after command name", () => {
    const cmd = matchCommand("/new my thread");
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe("new");
  });

  test("getCommandCompletions returns matches for partial input", () => {
    const results = getCommandCompletions("/th");
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("threads");
  });

  test("getCommandCompletions returns all for /", () => {
    const results = getCommandCompletions("/");
    expect(results.length).toBeGreaterThan(0);
  });

  test("getCommandCompletions returns empty for non-slash", () => {
    expect(getCommandCompletions("hello")).toEqual([]);
  });
});
