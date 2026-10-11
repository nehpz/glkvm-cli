#!/usr/bin/env bun
import { parseArgs } from "node:util";

import { Kvm } from "./client";
import { loadConfig } from "./config";
import { CliError, usageError } from "./errors";
import { isRecord } from "./guards";

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

type Flags = Record<string, string | boolean | undefined>;

const KEY_CODE = /^[A-Za-z][A-Za-z0-9]*$/u;
const KEY_SPEC = /^(?<code>[^*]+)(?:\*(?<count>.+))?$/u;
const MAX_REPEAT = 100;
const ATX_BUTTONS: Record<string, true> = {
  power: true,
  power_long: true,
  reset: true,
};
const ATX_ACTIONS: Record<string, true> = {
  off: true,
  off_hard: true,
  on: true,
  reset_hard: true,
};

/** Expands `ArrowDown*3` into three `ArrowDown` taps. */
export const expandKeys = (specs: string[]): string[] =>
  specs.flatMap((spec) => {
    const groups = KEY_SPEC.exec(spec)?.groups;
    const code = groups?.code ?? "";
    const count = Number(groups?.count ?? "1");
    if (
      !KEY_CODE.test(code) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_REPEAT
    ) {
      throw usageError(
        `invalid key spec "${spec}" (expected CODE or CODE*N, N 1-${MAX_REPEAT})`
      );
    }
    return Array.from({ length: count }, () => code);
  });

export const parseShortcut = (spec: string): string[] => {
  const keys = spec.split("+");
  if (keys.length < 2 || !keys.every((key) => KEY_CODE.test(key))) {
    throw usageError(`invalid shortcut "${spec}" (expected CODE+CODE...)`);
  }
  return keys;
};

const parseCount = (
  value: string | boolean | undefined,
  name: string
): number => {
  const n =
    typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(n) || n < 0) {
    throw usageError(`--${name} needs a non-negative integer`);
  }
  return n;
};

/** Reads the parts of `GET /api/switch` the CLI reports. */
const parseSwitch = (
  value: unknown
): { port: number; videoLinks: boolean[] } => {
  const summary = isRecord(value) ? value.summary : undefined;
  const video = isRecord(value) ? value.video : undefined;
  const port = isRecord(summary) ? summary.active_port : undefined;
  const links = isRecord(video) ? video.links : undefined;
  if (typeof port !== "number" || !Array.isArray(links)) {
    throw new CliError("/switch: unexpected response shape");
  }
  return { port, videoLinks: links.map(Boolean) };
};

interface Io {
  out: NodeJS.WriteStream;
  print: (value: unknown) => void;
}

type Action = (kvm: Kvm) => Promise<void>;

/** Each handler validates its arguments without config or network access, then returns the work. */
type Handler = (rest: string[], flags: Flags, io: Io) => Action;

const atx: Handler = (rest, flags, { print }) => {
  const [sub, arg = ""] = rest;
  if (sub === undefined) {
    return async (kvm) => {
      print(await kvm.call("/atx"));
    };
  }
  const known =
    sub === "click" ? ATX_BUTTONS[arg] : sub === "power" && ATX_ACTIONS[arg];
  if (known !== true) {
    throw usageError(
      "atx: expected `click power|power_long|reset` or `power on|off|off_hard|reset_hard`"
    );
  }
  if (flags.yes === undefined) {
    throw usageError(`atx ${sub} affects host power; pass --yes`);
  }
  if (sub === "power") {
    if (flags.port !== undefined) {
      throw usageError("atx power does not support --port; use atx click");
    }
    return async (kvm) => {
      await kvm.call("/atx/power", { method: "POST", query: { action: arg } });
    };
  }
  const port =
    flags.port === undefined ? undefined : parseCount(flags.port, "port");
  return async (kvm) => {
    await (port === undefined
      ? kvm.call("/atx/click", { method: "POST", query: { button: arg } })
      : kvm.call("/switch/atx/click", {
          method: "POST",
          query: { button: arg, port },
        }));
  };
};

const COMMANDS: Record<string, Handler> = {
  atx,
  key: (rest, flags) => {
    const keys = expandKeys(rest);
    if (keys.length === 0) {
      throw usageError("key: give at least one key CODE");
    }
    const delay =
      flags.delay === undefined ? 150 : parseCount(flags.delay, "delay");
    return async (kvm) => {
      for (const [i, key] of keys.entries()) {
        // Keys must arrive in order with a gap, so each tap waits for the last.
        if (i > 0) {
          // oxlint-disable-next-line no-await-in-loop
          await Bun.sleep(delay);
        }
        // oxlint-disable-next-line no-await-in-loop
        await kvm.call("/hid/events/send_key", {
          method: "POST",
          query: { key },
        });
      }
    };
  },
  port: (rest, _flags, { print }) => {
    const port =
      rest[0] === undefined ? undefined : parseCount(rest[0], "port");
    return async (kvm) => {
      if (port !== undefined) {
        await kvm.call("/switch/set_active", {
          method: "POST",
          query: { port },
        });
      }
      print(parseSwitch(await kvm.call("/switch")));
    };
  },
  shortcut: (rest) => {
    const [spec] = rest;
    if (spec === undefined || rest.length !== 1) {
      throw usageError("shortcut: give exactly one CODE+CODE spec");
    }
    const keys = parseShortcut(spec).join(",");
    return async (kvm) => {
      await kvm.call("/hid/events/send_shortcut", {
        method: "POST",
        query: { keys },
      });
    };
  },
  snap: (rest, _flags, { out }) => {
    const target =
      rest[0] ??
      `snapshot-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}.jpg`;
    return async (kvm) => {
      const jpeg = await kvm.snapshot();
      if (target === "-") {
        out.write(jpeg);
        return;
      }
      await Bun.write(target, jpeg);
      out.write(`${target}\n`);
    };
  },
  status:
    (_rest, _flags, { print }) =>
    async (kvm) => {
      const [atxState, sw, hid, streamer] = await Promise.all([
        kvm.call("/atx"),
        kvm.call("/switch"),
        kvm.call("/hid"),
        kvm.call("/streamer"),
      ]);
      print({
        atx: atxState,
        hid,
        streamer: isRecord(streamer) ? streamer.streamer : null,
        ...parseSwitch(sw),
      });
    },
  type: (rest) => {
    if (rest.length === 0) {
      throw usageError("type: give the text to type");
    }
    const body = rest.join(" ");
    return async (kvm) => {
      await kvm.call("/hid/print", {
        body,
        method: "POST",
        query: { limit: 0 },
      });
    };
  },
};

export const run = async (
  argv: string[],
  out: NodeJS.WriteStream = process.stdout
): Promise<void> => {
  const { values: flags, positionals: positional } = parseArgs({
    allowPositionals: true,
    args: argv,
    options: { delay: { type: "string" }, port: { type: "string" } },
    strict: false,
  });
  const [cmd, ...rest] = positional;
  if (cmd === undefined || cmd === "help" || flags.help !== undefined) {
    out.write(`${USAGE}\n`);
    return;
  }
  const handler = COMMANDS[cmd];
  if (handler === undefined) {
    throw usageError(`unknown command "${cmd}"`);
  }
  const print = (value: unknown): void => {
    out.write(`${JSON.stringify(value, null, 2)}\n`);
  };
  const action = handler(rest, flags, { out, print });
  await action(new Kvm(await loadConfig()));
};

if (import.meta.main) {
  try {
    await run(Bun.argv.slice(2));
  } catch (error) {
    const known = error instanceof CliError;
    console.error(`glkvm: ${known ? error.message : String(error)}`);
    if (known && error.exitCode === 2) {
      console.error("Run `glkvm help` for usage.");
    }
    process.exit(known ? error.exitCode : 1);
  }
}
