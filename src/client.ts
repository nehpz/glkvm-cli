import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "./config";

export class KvmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  ok: boolean;
  result: T & { error?: string; error_msg?: string };
}

interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean>;
  body?: string | URLSearchParams;
  timeoutMs?: number;
}

/**
 * Client for the PiKVM-derived `kvmd` HTTP API exposed by GL.iNet KVMs
 * (`https://<host>/api/...`). Auth uses the `auth_token` cookie returned by
 * `POST /api/auth/login`; the token is cached on disk (mode 0600) and
 * refreshed once when the device answers 401/403.
 */
export class Kvm {
  private token: string | undefined;
  readonly tokenFile: string;

  constructor(
    private readonly cfg: Config,
    tokenFile = join(
      process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
      "glkvm-cli",
      `${new URL(cfg.baseUrl).host.replace(/[^\w.-]/g, "_")}.token`,
    ),
  ) {
    this.tokenFile = tokenFile;
  }

  async login(): Promise<string> {
    const res = await this.fetch("/auth/login", {
      method: "POST",
      body: new URLSearchParams({ user: this.cfg.user, passwd: this.cfg.pass }),
    });
    if (res.status !== 200) {
      throw new KvmError(`login failed (${res.status}): ${await errorMessage(res)}`, res.status);
    }
    const token = /auth_token=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    if (!token) throw new KvmError("login succeeded but no auth_token cookie was returned");
    this.token = token;
    mkdirSync(dirname(this.tokenFile), { recursive: true, mode: 0o700 });
    writeFileSync(this.tokenFile, token, { mode: 0o600 });
    chmodSync(this.tokenFile, 0o600); // `mode` above only applies when the file is created
    return token;
  }

  /** Authenticated request; re-logs in once if the cached token is rejected. */
  async request(path: string, opts: RequestOptions = {}): Promise<Response> {
    if (!this.token) {
      try {
        this.token = readFileSync(this.tokenFile, "utf8").trim() || undefined;
      } catch {
        // No cached token yet.
      }
    }
    if (!this.token) await this.login();
    let res = await this.fetch(path, opts);
    if (res.status === 401 || res.status === 403) {
      await this.login();
      res = await this.fetch(path, opts);
    }
    return res;
  }

  /** Requests a JSON endpoint and unwraps kvmd's `{ok, result}` envelope. */
  async call<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(path, opts);
    const env = (await res.json()) as Envelope<T>;
    if (!env.ok) {
      throw new KvmError(`${path}: ${env.result.error_msg ?? env.result.error ?? res.status}`, res.status);
    }
    return env.result;
  }

  /**
   * Returns a JPEG of the current video input. The streamer only runs while a
   * client holds a `stream=1` websocket, so one is opened for the duration.
   */
  async snapshot(timeoutMs = 20_000): Promise<Uint8Array> {
    await this.request("/auth/check");
    const ws = new WebSocket(`${this.cfg.baseUrl.replace(/^http/, "ws")}/api/ws?stream=1`, {
      headers: { Cookie: `auth_token=${this.token}` },
      tls: { rejectUnauthorized: !this.cfg.insecure },
    });
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        const res = await this.request("/streamer/snapshot", { timeoutMs: 10_000 });
        if (res.status === 200 && res.headers.get("content-type")?.startsWith("image/")) {
          return new Uint8Array(await res.arrayBuffer());
        }
        if (res.status !== 503) {
          throw new KvmError(`snapshot failed (${res.status}): ${await errorMessage(res)}`, res.status);
        }
        await Bun.sleep(1000);
      }
      throw new KvmError(`no video frame within ${timeoutMs / 1000}s (is a source connected?)`);
    } finally {
      ws.close();
    }
  }

  private fetch(path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = new URL(`${this.cfg.baseUrl}/api${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    return fetch(url, {
      method: opts.method ?? "GET",
      body: opts.body,
      headers: this.token ? { Cookie: `auth_token=${this.token}` } : {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      tls: { rejectUnauthorized: !this.cfg.insecure },
    });
  }
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const env = JSON.parse(text) as Envelope<unknown>;
    return env.result.error_msg ?? env.result.error ?? text;
  } catch {
    return text.slice(0, 200);
  }
}
