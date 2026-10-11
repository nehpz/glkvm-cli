import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Kvm } from "../src/client";
import { CliError } from "../src/errors";

// Minimal stand-in for kvmd: one valid token, rotated on every login.
let validToken = "";
let logins = 0;
const server = Bun.serve({
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/login") {
      const form = new URLSearchParams(await req.text());
      if (form.get("user") !== "admin" || form.get("passwd") !== "pw") {
        return Response.json(
          {
            ok: false,
            result: { error: "ForbiddenError", error_msg: "Forbidden" },
          },
          { status: 403 }
        );
      }
      logins += 1;
      validToken = `tok${logins}`;
      return new Response(null, {
        headers: { "set-cookie": `auth_token=${validToken}; Path=/; HttpOnly` },
      });
    }
    if (req.headers.get("cookie") !== `auth_token=${validToken}`) {
      return Response.json(
        {
          ok: false,
          result: { error: "UnauthorizedError", error_msg: "Unauthorized" },
        },
        { status: 401 }
      );
    }
    return Response.json({ ok: true, result: { power: "on" } });
  },
  port: 0,
});
const tokenFile = path.join(os.tmpdir(), `glkvm-test-${process.pid}.token`);
const cfg = {
  baseUrl: `http://127.0.0.1:${server.port}`,
  insecure: false,
  pass: "pw",
  user: "admin",
};
afterAll(async () => {
  await server.stop(true);
  rmSync(tokenFile, { force: true });
});

test("a stale cached token triggers one re-login and the new token is cached privately", async () => {
  writeFileSync(tokenFile, "expired");
  const result = await new Kvm(cfg, tokenFile).call("/atx");
  expect(result).toEqual({ power: "on" });
  expect(logins).toBe(1);
  expect(readFileSync(tokenFile, "utf-8").endsWith(`\n${validToken}`)).toBe(
    true
  );
  expect(statSync(tokenFile).mode.toString(8).endsWith("600")).toBe(true);

  // A second client reuses the cached token without logging in again.
  await new Kvm(cfg, tokenFile).call("/atx");
  expect(logins).toBe(1);
});

test("a changed password is not masked by a token cached under the old one", async () => {
  await new Kvm(cfg, tokenFile).call("/atx");
  const failure: unknown = await new Kvm({ ...cfg, pass: "wrong" }, tokenFile)
    .call("/atx")
    .catch((error: unknown) => error);
  expect(String(failure)).toContain("login failed (403)");
});

test("bad credentials surface the device's error", async () => {
  rmSync(tokenFile, { force: true });
  const kvm = new Kvm({ ...cfg, pass: "wrong" }, tokenFile);
  const failure: unknown = await kvm
    .call("/atx")
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(CliError);
  expect(String(failure)).toContain("login failed (403): Forbidden");
});
