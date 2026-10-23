import test from "node:test";
import assert from "node:assert/strict";
import { pickWebStarter, webTokenFromLogText } from "./web-local.mjs";

const deepseek = {
  id: "deepseek",
  webCmd: ["dsh", "web", "--no-open"],
  webService: "dsh-web",
  webTask: "DSH-Web",
};

test("pickWebStarter: systemd cuando hay unit en Linux", () => {
  assert.equal(pickWebStarter(deepseek, "linux", true), "systemd");
  assert.equal(pickWebStarter(deepseek, "linux", false), "spawn");
});

test("pickWebStarter: task en Windows si hay webTask", () => {
  assert.equal(pickWebStarter(deepseek, "win32", false), "task");
});

test("webTokenFromLogText delega en lastWebToken", () => {
  const token = "A".repeat(20);
  assert.equal(webTokenFromLogText(`/?token=${token}\n`), token);
  assert.equal(webTokenFromLogText("sin token"), null);
});
