#!/usr/bin/env bun
import { Kvm, KvmError } from "./client";
import { ConfigError, loadConfig } from "./config";

export const USAGE = `glkvm — control a GL.iNet (PiKVM-based) KVM over its HTTP API

Usage:
  glkvm status                              ATX power, active port, video, HID state (JSON)
  glkvm snap [FILE|-]                       save a JPEG of the screen (default: snapshot-<time>.jpg)
  glkvm port [N]                            show the active switch port, or switch to port N (0-based)
  glkvm key CODE[*N]... [--delay MS]        tap keys in order, e.g. Escape ArrowDown*3 Enter
  glkvm shortcut CODE+CODE...               press keys together, e.g. ControlLeft+AltLeft+Delete
  glkvm type TEXT                           type text as keystrokes
  glkvm atx                                 ATX power/LED state
  glkvm atx click BUTTON [--port N] --yes   press power | power_long | reset
  glkvm atx power ACTION --yes              on | off | off_hard | reset_hard

Key CODEs are browser KeyboardEvent.code names (Escape, Enter, F2, ArrowDown, KeyA...).

Config (environment, or KEY=value lines in $KVM_ENV_FILE, default ~/.config/glkvm.env):
  KVM_HOST      hostname/IP or URL of the KVM
  KVM_USER      web UI username
  KVM_PASS      web UI password
  KVM_INSECURE  1 to skip TLS verification (the devices ship self-signed certs)`;

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS: Record<string, true> = { port: true, delay: true };

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (!VALUE_FLAGS[name]) {
      flags[name] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    flags[name] = value;
  }
  return { positional, flags };
}

const KEY_CODE = /^[A-Za-z][A-Za-z0-9]*$/;

/** Expands `ArrowDown*3` into three `ArrowDown` taps. */
export function expandKeys(specs: string[]): string[] {
  return specs.flatMap((spec) => {
    const [code, count = "1"] = spec.split("*", 2) as [string, string | undefined];
    const n = Number(count);
    if (!KEY_CODE.test(code) || !Number.isInteger(n) || n < 1 || n > 100) {
      throw new UsageError(`invalid key spec "${spec}" (expected CODE or CODE*N, N 1-100)`);
    }
    return Array<string>(n).fill(code);
  });
}

export function parseShortcut(spec: string): string[] {
  const keys = spec.split("+");
  if (keys.length < 2 || !keys.every((k) => KEY_CODE.test(k))) {
    throw new UsageError(`invalid shortcut "${spec}" (expected CODE+CODE...)`);
  }
  return keys;
}

function intFlag(value: string | true | undefined, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const n = Number(value);
  if (typeof value !== "string" || !Number.isInteger(n) || n < 0) {
    throw new UsageError(`--${name} needs a non-negative integer`);
  }
  return n;
}

export class UsageError extends Error {}

const ATX_BUTTONS: Record<string, true> = { power: true, power_long: true, reset: true };
const ATX_ACTIONS: Record<string, true> = { on: true, off: true, off_hard: true, reset_hard: true };

interface SwitchState {
  summary: { active_port: number; active_id: string };
  video: { links: boolean[] };
}

export async function run(argv: string[], out = process.stdout): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  if (!cmd || flags.help || cmd === "help") {
    out.write(`${USAGE}\n`);
    return;
  }
  const print = (value: unknown) => out.write(`${JSON.stringify(value, null, 2)}\n`);
  const action = plan(cmd, rest, flags, out, print);
  await action(new Kvm(await loadConfig()));
}

type Action = (kvm: Kvm) => Promise<void>;

/** Validates arguments without touching config or the network, then returns the work to do. */
function plan(
  cmd: string,
  rest: string[],
  flags: ParsedArgs["flags"],
  out: NodeJS.WriteStream,
  print: (value: unknown) => void,
): Action {
  switch (cmd) {
    case "status":
      return async (kvm) => {
        const [atx, sw, hid, streamer] = await Promise.all([
          kvm.call("/atx"),
          kvm.call<SwitchState>("/switch"),
          kvm.call("/hid"),
          kvm.call<{ streamer: unknown }>("/streamer"),
        ]);
        print({
          atx,
          port: sw.summary.active_port,
          videoLinks: sw.video.links,
          hid,
          streamer: streamer.streamer,
        });
      };
    case "snap": {
      const target = rest[0] ?? `snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
      return async (kvm) => {
        const jpeg = await kvm.snapshot();
        if (target === "-") {
          out.write(jpeg);
        } else {
          await Bun.write(target, jpeg);
          out.write(`${target}\n`);
        }
      };
    }
    case "port": {
      const port = rest[0] === undefined ? undefined : intFlag(rest[0], "port");
      return async (kvm) => {
        if (port !== undefined) await kvm.call("/switch/set_active", { method: "POST", query: { port } });
        const sw = await kvm.call<SwitchState>("/switch");
        print({ port: sw.summary.active_port, videoLinks: sw.video.links });
      };
    }
    case "key": {
      const keys = expandKeys(rest);
      if (!keys.length) throw new UsageError("key: give at least one key CODE");
      const delay = intFlag(flags.delay, "delay", 150);
      return async (kvm) => {
        for (const [i, key] of keys.entries()) {
          if (i) await Bun.sleep(delay);
          await kvm.call("/hid/events/send_key", { method: "POST", query: { key } });
        }
      };
    }
    case "shortcut": {
      if (rest.length !== 1) throw new UsageError("shortcut: give exactly one CODE+CODE spec");
      const keys = parseShortcut(rest[0] as string).join(",");
      return async (kvm) => {
        await kvm.call("/hid/events/send_shortcut", { method: "POST", query: { keys } });
      };
    }
    case "type": {
      if (!rest.length) throw new UsageError("type: give the text to type");
      const body = rest.join(" ");
      return async (kvm) => {
        await kvm.call("/hid/print", { method: "POST", query: { limit: 0 }, body });
      };
    }
    case "atx": {
      const [sub, arg] = rest;
      if (sub === undefined) return async (kvm) => print(await kvm.call("/atx"));
      if (sub === "click" && arg && ATX_BUTTONS[arg]) {
        if (!flags.yes) throw new UsageError("atx click affects host power; pass --yes");
        const port = flags.port === undefined ? undefined : intFlag(flags.port, "port");
        return async (kvm) => {
          if (port === undefined) {
            await kvm.call("/atx/click", { method: "POST", query: { button: arg } });
          } else {
            await kvm.call("/switch/atx/click", { method: "POST", query: { port, button: arg } });
          }
        };
      }
      if (sub === "power" && arg && ATX_ACTIONS[arg]) {
        if (!flags.yes) throw new UsageError("atx power affects host power; pass --yes");
        return async (kvm) => {
          await kvm.call("/atx/power", { method: "POST", query: { action: arg } });
        };
      }
      throw new UsageError(
        "atx: expected `click power|power_long|reset` or `power on|off|off_hard|reset_hard`",
      );
    }
    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

if (import.meta.main) {
  try {
    await run(Bun.argv.slice(2));
  } catch (err) {
    const known = err instanceof UsageError || err instanceof ConfigError || err instanceof KvmError;
    console.error(`glkvm: ${known ? err.message : String(err)}`);
    if (err instanceof UsageError) console.error("Run `glkvm help` for usage.");
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}
