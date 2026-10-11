import { expect, test } from "bun:test";
import { expandKeys, parseArgs, parseShortcut, UsageError } from "../src/cli";

test("expandKeys repeats CODE*N in order", () => {
  expect(expandKeys(["Escape", "ArrowDown*3", "Enter"])).toEqual([
    "Escape",
    "ArrowDown",
    "ArrowDown",
    "ArrowDown",
    "Enter",
  ]);
});

test("expandKeys rejects malformed specs and out-of-range counts", () => {
  for (const bad of ["Arrow Down", "Enter*0", "Enter*101", "Enter*x", "*3", "F2*1.5"]) {
    expect(() => expandKeys([bad])).toThrow(UsageError);
  }
});

test("parseShortcut needs at least two valid codes", () => {
  expect(parseShortcut("ControlLeft+AltLeft+Delete")).toEqual(["ControlLeft", "AltLeft", "Delete"]);
  expect(() => parseShortcut("Delete")).toThrow(UsageError);
  expect(() => parseShortcut("ControlLeft+")).toThrow(UsageError);
});

test("parseArgs separates value flags, boolean flags and positionals", () => {
  expect(parseArgs(["atx", "click", "reset", "--port", "1", "--yes"])).toEqual({
    positional: ["atx", "click", "reset"],
    flags: { port: "1", yes: true },
  });
  expect(parseArgs(["key", "--delay=50", "--", "--not-a-flag"])).toEqual({
    positional: ["key", "--not-a-flag"],
    flags: { delay: "50" },
  });
  expect(() => parseArgs(["port", "--port"])).toThrow(UsageError);
});
