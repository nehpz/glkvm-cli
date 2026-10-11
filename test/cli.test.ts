import { expect, test } from "bun:test";

import { expandKeys, parseShortcut, run } from "../src/cli";
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

test("power commands with a missing or bad --port fail as usage errors before config or network", async () => {
  // A nonexistent config makes any regression fail with exit 1 instead of reaching a real device.
  process.env.KVM_ENV_FILE = "/nonexistent/glkvm.env";
  delete process.env.KVM_HOST;
  const failures = await Promise.all(
    [
      ["atx", "click", "reset", "--port", "--yes"],
      ["atx", "click", "reset", "--yes", "--port"],
      ["atx", "click", "reset", "--port=x", "--yes"],
      ["atx", "click", "reset", "--port=", "--yes"],
      ["atx", "click", "reset", "--port", " ", "--yes"],
      ["atx", "power", "off", "--port", "1", "--yes"],
      ["atx", "power", "off", "--port=x", "--yes"],
    ].map(async (argv) => await run(argv).catch((error: unknown) => error))
  );
  expect(
    failures.map((f) => (f instanceof CliError ? f.exitCode : undefined))
  ).toEqual([2, 2, 2, 2, 2, 2, 2]);
});
