import { expect, test } from "bun:test";

import { expandKeys, parseArgs, parseShortcut } from "../src/cli";
import { CliError } from "../src/errors";

const exitCodeOf = (fn: () => unknown): number | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof CliError ? error.exitCode : undefined;
  }
  return 0;
};

test("expandKeys repeats CODE*N in order", () => {
  expect(expandKeys(["Escape", "ArrowDown*3", "Enter"])).toEqual([
    "Escape",
    "ArrowDown",
    "ArrowDown",
    "ArrowDown",
    "Enter",
  ]);
});

test("expandKeys rejects malformed specs and out-of-range counts as usage errors", () => {
  for (const bad of [
    "Arrow Down",
    "Enter*0",
    "Enter*101",
    "Enter*x",
    "*3",
    "F2*1.5",
  ]) {
    expect(exitCodeOf(() => expandKeys([bad]))).toBe(2);
  }
});

test("parseShortcut needs at least two valid codes", () => {
  expect(parseShortcut("ControlLeft+AltLeft+Delete")).toEqual([
    "ControlLeft",
    "AltLeft",
    "Delete",
  ]);
  expect(exitCodeOf(() => parseShortcut("Delete"))).toBe(2);
  expect(exitCodeOf(() => parseShortcut("ControlLeft+"))).toBe(2);
});

test("parseArgs separates value flags, boolean flags and positionals", () => {
  expect(parseArgs(["atx", "click", "reset", "--port", "1", "--yes"])).toEqual({
    flags: { port: "1", yes: true },
    positional: ["atx", "click", "reset"],
  });
  expect(parseArgs(["key", "--delay=50", "--", "--not-a-flag"])).toEqual({
    flags: { delay: "50" },
    positional: ["key", "--not-a-flag"],
  });
  expect(exitCodeOf(() => parseArgs(["port", "--port"]))).toBe(2);
});
