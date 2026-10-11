import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, normalizeHost, parseEnvFile } from "../src/config";

describe("parseEnvFile", () => {
  test("handles comments, export, CRLF and matching quotes", () => {
    const text = "# kvm\r\nexport KVM_USER=\"admin\"\r\nKVM_PASS='p@ss=word'\nKVM_HOST = 192.168.8.100\n";
    expect(parseEnvFile(text)).toEqual({ KVM_USER: "admin", KVM_PASS: "p@ss=word", KVM_HOST: "192.168.8.100" });
  });

  test("rejects unbalanced quotes instead of sending a quote to the device", () => {
    expect(() => parseEnvFile('KVM_USER="admin')).toThrow(ConfigError);
    expect(() => parseEnvFile("KVM_PASS='secret\"")).toThrow(ConfigError);
  });
});

test("normalizeHost defaults to https and keeps an explicit scheme", () => {
  expect(normalizeHost("192.168.8.100")).toBe("https://192.168.8.100");
  expect(normalizeHost("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
});

describe("loadConfig", () => {
  const file = join(tmpdir(), `glkvm-test-${process.pid}.env`);
  afterEach(() => rmSync(file, { force: true }));

  test("environment overrides the env file", async () => {
    writeFileSync(file, "KVM_HOST=file-host\nKVM_USER=file-user\nKVM_PASS=file-pass\nKVM_INSECURE=1\n");
    const cfg = await loadConfig({ KVM_ENV_FILE: file, KVM_HOST: "env-host" });
    expect(cfg).toEqual({
      baseUrl: "https://env-host",
      user: "file-user",
      pass: "file-pass",
      insecure: true,
    });
  });

  test("names every missing variable", async () => {
    await expect(loadConfig({ KVM_ENV_FILE: file, KVM_USER: "u" })).rejects.toThrow(
      /missing KVM_HOST, KVM_PASS/,
    );
  });
});
