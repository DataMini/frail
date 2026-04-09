import React from "react";
import { describe, test, expect, beforeAll } from "bun:test";
import { render } from "ink-testing-library";
import { loadConfig } from "../src/config/loader";
import { App } from "../src/app";

// Initialize foundation before tests
beforeAll(async () => {
  await loadConfig();
});

function waitForFrame(ms = 150) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("App", () => {
  test("renders without crashing and shows status bar", async () => {
    const instance = render(<App />);
    await waitForFrame();

    const frame = instance.lastFrame()!;
    expect(frame).toContain("frail");
    expect(frame).toContain("thread:");
    instance.unmount();
  });

  test("renders with feishu status", async () => {
    const instance = render(<App feishuStatus="connected" />);
    await waitForFrame();

    const frame = instance.lastFrame()!;
    expect(frame).toContain("Feishu");
    expect(frame).toContain("connected");
    instance.unmount();
  });

  test("shows input prompt in chat view", async () => {
    const instance = render(<App />);
    await waitForFrame();

    const frame = instance.lastFrame()!;
    expect(frame).toContain("❯");
    instance.unmount();
  });

  test("does not produce infinite re-render (frame count stays bounded)", async () => {
    const instance = render(<App />);
    await waitForFrame(200);

    const frameCount = instance.frames.length;
    expect(frameCount).toBeLessThan(50);

    instance.unmount();
  });

  test("shows thread label in status bar", async () => {
    const instance = render(<App />);
    await waitForFrame();

    const frame = instance.lastFrame()!;
    expect(frame).toContain("thread:");
    instance.unmount();
  });

  test("typing text does not cause infinite re-render", async () => {
    const instance = render(<App />);
    await waitForFrame();

    const framesBefore = instance.frames.length;

    instance.stdin.write("h");
    instance.stdin.write("e");
    instance.stdin.write("l");
    instance.stdin.write("l");
    instance.stdin.write("o");
    await waitForFrame(200);

    const framesAfter = instance.frames.length;
    expect(framesAfter - framesBefore).toBeLessThan(30);

    instance.unmount();
  });

  test("typing slash command does not cause infinite re-render", async () => {
    const instance = render(<App />);
    await waitForFrame();

    const framesBefore = instance.frames.length;

    instance.stdin.write("/");
    instance.stdin.write("h");
    instance.stdin.write("e");
    await waitForFrame(200);

    const framesAfter = instance.frames.length;
    expect(framesAfter - framesBefore).toBeLessThan(30);

    instance.unmount();
  });
});
