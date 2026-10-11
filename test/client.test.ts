import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm, KvmError } from "../src/client";

// Minimal stand-in for kvmd: one valid token, rotated on every login.
let validToken = "";
let logins = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/auth/login") {
      const form = new URLSearchParams(await req.text());
      if (form.get("user") !== "admin" || form.get("passwd") !== "pw") {
        return Response.json(
          { ok: false, result: { error: "ForbiddenError", error_msg: "Forbidden" } },
          { status: 403 },
        );
      }
      validToken = `tok${++logins}`;
      return new Response(null, { headers: { "set-cookie": `auth_token=${validToken}; Path=/; HttpOnly` } });
    }
    if (req.headers.get("cookie") !== `auth_token=${validToken}`) {
      return Response.json(
        { ok: false, result: { error: "UnauthorizedError", error_msg: "Unauthorized" } },
        { status: 401 },
      );
    }
    return Response.json({ ok: true, result: { power: "on" } });
  },
});
const tokenFile = join(tmpdir(), `glkvm-test-${process.pid}.token`);
const cfg = { baseUrl: `http://127.0.0.1:${server.port}`, user: "admin", pass: "pw", insecure: false };
afterAll(() => {
  server.stop(true);
  rmSync(tokenFile, { force: true });
});

test("a stale cached token triggers one re-login and the new token is cached privately", async () => {
  writeFileSync(tokenFile, "expired");
  const result = await new Kvm(cfg, tokenFile).call<{ power: string }>("/atx");
  expect(result).toEqual({ power: "on" });
  expect(logins).toBe(1);
  expect(readFileSync(tokenFile, "utf8")).toBe(validToken);
  expect(statSync(tokenFile).mode & 0o777).toBe(0o600);

  // A second client reuses the cached token without logging in again.
  await new Kvm(cfg, tokenFile).call("/atx");
  expect(logins).toBe(1);
});

test("bad credentials surface the device's error", async () => {
  rmSync(tokenFile, { force: true });
  const kvm = new Kvm({ ...cfg, pass: "wrong" }, tokenFile);
  await expect(kvm.call("/atx")).rejects.toThrow(KvmError);
  await expect(kvm.call("/atx")).rejects.toThrow(/login failed \(403\): Forbidden/);
});
