import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  /** Base URL including scheme, no trailing slash, e.g. `https://192.168.8.100`. */
  baseUrl: string;
  user: string;
  pass: string;
  /** Skip TLS certificate verification (GL.iNet KVMs ship self-signed certs). */
  insecure: boolean;
}

export class ConfigError extends Error {}

export const DEFAULT_ENV_FILE = join(homedir(), ".config", "glkvm.env");

/** Parses `KEY=value` lines; supports comments, `export`, and matching quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m as unknown as [string, string, string];
    let value = rawValue;
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
      value = value.slice(1, -1);
    } else if (q === '"' || q === "'") {
      throw new ConfigError(`${key}: unbalanced quote in env file`);
    }
    out[key] = value;
  }
  return out;
}

export function normalizeHost(host: string): string {
  const withScheme = /^https?:\/\//.test(host) ? host : `https://${host}`;
  return withScheme.replace(/\/+$/, "");
}

const TRUTHY: Record<string, true> = { "1": true, true: true, yes: true, on: true };

/** Process env wins over the env file; the file is optional. */
export async function loadConfig(env: Record<string, string | undefined> = process.env): Promise<Config> {
  const path = env.KVM_ENV_FILE ?? DEFAULT_ENV_FILE;
  const file = Bun.file(path);
  const fromFile = (await file.exists()) ? parseEnvFile(await file.text()) : {};
  const get = (k: string) => env[k] ?? fromFile[k];

  const missing = ["KVM_HOST", "KVM_USER", "KVM_PASS"].filter((k) => !get(k));
  if (missing.length) {
    throw new ConfigError(`missing ${missing.join(", ")} (set in the environment or ${path})`);
  }
  return {
    baseUrl: normalizeHost(get("KVM_HOST") as string),
    user: get("KVM_USER") as string,
    pass: get("KVM_PASS") as string,
    insecure: TRUTHY[(get("KVM_INSECURE") ?? "").toLowerCase()] === true,
  };
}
