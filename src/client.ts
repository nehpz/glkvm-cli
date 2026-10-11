import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Config } from "./config";
import { CliError } from "./errors";
import { isRecord } from "./guards";

interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean>;
  body?: string | URLSearchParams;
  timeoutMs?: number;
}

interface Envelope {
  ok: boolean;
  result: unknown;
}

const isEnvelope = (value: unknown): value is Envelope =>
  isRecord(value) && typeof value.ok === "boolean" && "result" in value;

/** kvmd reports failures as `{ok: false, result: {error, error_msg}}`. */
const describeFailure = (result: unknown, fallback: string): string => {
  if (isRecord(result)) {
    const message = result.error_msg ?? result.error;
    if (typeof message === "string") {
      return message;
    }
  }
  return fallback;
};

const errorMessage = async (res: Response): Promise<string> => {
  const text = await res.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return isEnvelope(parsed)
      ? describeFailure(parsed.result, text)
      : text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
};

const defaultTokenFile = (baseUrl: string): string =>
  path.join(
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
    "glkvm-cli",
    `${new URL(baseUrl).host.replaceAll(/[^\w.-]/gu, "_")}.token`
  );

/**
 * Client for the PiKVM-derived `kvmd` HTTP API exposed by GL.iNet KVMs
 * (`https://<host>/api/...`). Auth uses the `auth_token` cookie returned by
 * `POST /api/auth/login`; the token is cached on disk (mode 0600) and
 * refreshed once when the device answers 401/403.
 */
export class Kvm {
  readonly tokenFile: string;
  private readonly cfg: Config;
  private token: string | undefined;

  constructor(cfg: Config, tokenFile = defaultTokenFile(cfg.baseUrl)) {
    this.cfg = cfg;
    this.tokenFile = tokenFile;
  }

  async login(): Promise<string> {
    const res = await this.fetch("/auth/login", {
      body: new URLSearchParams({ passwd: this.cfg.pass, user: this.cfg.user }),
      method: "POST",
    });
    if (res.status !== 200) {
      throw new CliError(
        `login failed (${res.status}): ${await errorMessage(res)}`,
        1,
        res.status
      );
    }
    const cookie = res.headers.get("set-cookie") ?? "";
    const token = /auth_token=(?<token>[^;]+)/u.exec(cookie)?.groups?.token;
    if (token === undefined) {
      throw new CliError(
        "login succeeded but no auth_token cookie was returned"
      );
    }
    this.token = token;
    mkdirSync(path.dirname(this.tokenFile), { mode: 0o700, recursive: true });
    writeFileSync(this.tokenFile, token, { mode: 0o600 });
    // `mode` above only applies when the file is created.
    chmodSync(this.tokenFile, 0o600);
    return token;
  }

  /** Authenticated request; re-logs in once if the cached token is rejected. */
  async request(apiPath: string, opts: RequestOptions = {}): Promise<Response> {
    if (this.token === undefined) {
      try {
        const cached = readFileSync(this.tokenFile, "utf-8").trim();
        this.token = cached === "" ? undefined : cached;
      } catch {
        // No cached token yet.
      }
    }
    if (this.token === undefined) {
      await this.login();
    }
    const res = await this.fetch(apiPath, opts);
    if (res.status !== 401 && res.status !== 403) {
      return res;
    }
    await this.login();
    return await this.fetch(apiPath, opts);
  }

  /** Requests a JSON endpoint and unwraps kvmd's `{ok, result}` envelope. */
  async call(apiPath: string, opts: RequestOptions = {}): Promise<unknown> {
    const res = await this.request(apiPath, opts);
    const body: unknown = await res.json();
    if (!isEnvelope(body)) {
      throw new CliError(
        `${apiPath}: unexpected response (${res.status})`,
        1,
        res.status
      );
    }
    if (!body.ok) {
      throw new CliError(
        `${apiPath}: ${describeFailure(body.result, String(res.status))}`,
        1,
        res.status
      );
    }
    return body.result;
  }

  /**
   * Returns a JPEG of the current video input. The streamer only runs while a
   * client holds a `stream=1` websocket, so one is opened for the duration.
   */
  async snapshot(timeoutMs = 20_000): Promise<Uint8Array> {
    // Ensures a valid token before it is copied into the websocket headers.
    await this.request("/auth/check");
    const ws = new WebSocket(
      `${this.cfg.baseUrl.replace(/^http/u, "ws")}/api/ws?stream=1`,
      {
        headers: { Cookie: `auth_token=${this.token ?? ""}` },
        tls: { rejectUnauthorized: !this.cfg.insecure },
      }
    );
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        // Polling is inherently sequential: wait for the streamer to come up.
        // oxlint-disable-next-line no-await-in-loop
        const res = await this.request("/streamer/snapshot", {
          timeoutMs: 10_000,
        });
        const isImage =
          res.headers.get("content-type")?.startsWith("image/") === true;
        if (res.status === 200 && isImage) {
          // oxlint-disable-next-line no-await-in-loop
          return new Uint8Array(await res.arrayBuffer());
        }
        if (res.status !== 503) {
          // oxlint-disable-next-line no-await-in-loop
          const detail = await errorMessage(res);
          throw new CliError(
            `snapshot failed (${res.status}): ${detail}`,
            1,
            res.status
          );
        }
        // oxlint-disable-next-line no-await-in-loop
        await Bun.sleep(1000);
      }
      throw new CliError(
        `no video frame within ${timeoutMs / 1000}s (is a source connected?)`
      );
    } finally {
      ws.close();
    }
  }

  private async fetch(
    apiPath: string,
    opts: RequestOptions = {}
  ): Promise<Response> {
    const url = new URL(`${this.cfg.baseUrl}/api${apiPath}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    return await fetch(url, {
      body: opts.body,
      headers:
        this.token === undefined ? {} : { Cookie: `auth_token=${this.token}` },
      method: opts.method ?? "GET",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      tls: { rejectUnauthorized: !this.cfg.insecure },
    });
  }
}
