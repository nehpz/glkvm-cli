import os from "node:os";
import path from "node:path";

import { CliError } from "./errors";

export interface Config {
  /** Base URL including scheme, no trailing slash, e.g. `https://192.168.8.100`. */
  baseUrl: string;
  user: string;
  pass: string;
  /** Skip TLS certificate verification (GL.iNet KVMs ship self-signed certs). */
  insecure: boolean;
}

export const DEFAULT_ENV_FILE = path.join(os.homedir(), ".config", "glkvm.env");

const ENV_LINE =
  /^(?:export\s+)?(?<key>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$/u;
const TRUTHY: Record<string, true> = {
  "1": true,
  on: true,
  true: true,
  yes: true,
};

const unquote = (key: string, value: string): string => {
  const [quote] = value;
  if (quote !== '"' && quote !== "'") {
    return value;
  }
  if (value.length < 2 || !value.endsWith(quote)) {
    throw new CliError(`${key}: unbalanced quote in env file`);
  }
  return value.slice(1, -1);
};

/** Parses `KEY=value` lines; supports comments, `export`, and matching quotes. */
export const parseEnvFile = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    const groups = line.startsWith("#")
      ? undefined
      : ENV_LINE.exec(line)?.groups;
    if (groups?.key !== undefined && groups.value !== undefined) {
      out[groups.key] = unquote(groups.key, groups.value);
    }
  }
  return out;
};

export const normalizeHost = (host: string): string => {
  const withScheme = /^https?:\/\//u.test(host) ? host : `https://${host}`;
  return withScheme.replace(/\/+$/u, "");
};

/** Process env wins over the env file; the file is optional. */
export const loadConfig = async (
  env: Record<string, string | undefined> = process.env
): Promise<Config> => {
  const file = env.KVM_ENV_FILE ?? DEFAULT_ENV_FILE;
  const handle = Bun.file(file);
  const fromFile = (await handle.exists())
    ? parseEnvFile(await handle.text())
    : {};
  const get = (key: string): string => env[key] ?? fromFile[key] ?? "";

  const host = get("KVM_HOST");
  const user = get("KVM_USER");
  const pass = get("KVM_PASS");
  const missing = Object.entries({
    KVM_HOST: host,
    KVM_PASS: pass,
    KVM_USER: user,
  })
    .filter(([, value]) => value === "")
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new CliError(
      `missing ${missing.join(", ")} (set in the environment or ${file})`
    );
  }
  return {
    baseUrl: normalizeHost(host),
    insecure: TRUTHY[get("KVM_INSECURE").toLowerCase()] === true,
    pass,
    user,
  };
};
