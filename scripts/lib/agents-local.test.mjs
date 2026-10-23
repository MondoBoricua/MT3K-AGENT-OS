import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateLocalAgentEntry,
  parseAgentsLocalDocument,
  mergeLocalAgentDefs,
} from "./agents-local.mjs";

const codeDefs = [{ id: "claude", name: "Claude", bins: ["claude"], proc: ["claude"] }];

describe("agents-local", () => {
  it("entrada válida web-external", () => {
    const v = validateLocalAgentEntry({
      id: "muse",
      name: "Muse",
      adapter: "web-external",
      url: "https://muse.ai",
      logo: "muse",
    });
    assert.deepEqual(v, {
      id: "muse",
      name: "Muse",
      adapter: "web-external",
      url: "https://muse.ai/",
      logo: "muse",
    });
  });

  it("id inválido", () => {
    assert.equal(
      validateLocalAgentEntry({ id: "Muse", name: "x", adapter: "web-external", url: "https://muse.ai" }),
      null,
    );
  });

  it("url http:// rechazada", () => {
    assert.equal(
      validateLocalAgentEntry({ id: "muse", name: "Muse", adapter: "web-external", url: "http://muse.ai" }),
      null,
    );
  });

  it("adapter no permitido", () => {
    assert.equal(
      validateLocalAgentEntry({ id: "muse", name: "Muse", adapter: "cli-tmux", url: "https://muse.ai" }),
      null,
    );
  });

  it("dos locales con el mismo id: la primera gana, la segunda con warning", () => {
    const warnings = [];
    const local = [
      { id: "muse", name: "Muse", adapter: "web-external", url: "https://muse.ai" },
      { id: "muse", name: "Muse dup", adapter: "web-external", url: "https://other.example.com" },
    ];
    const merged = mergeLocalAgentDefs([], local, (m) => warnings.push(m));
    assert.equal(merged.length, 1);
    assert.equal(merged[0].name, "Muse");
    assert.match(warnings.join(" "), /duplicado en locales/);
  });

  it("duplicado con uno de código se omite con warning", () => {
    const warnings = [];
    const local = [{ id: "claude", name: "Dup", adapter: "web-external", url: "https://example.com" }];
    const merged = mergeLocalAgentDefs(codeDefs, local, (m) => warnings.push(m));
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "claude");
    assert.match(warnings.join(" "), /omitido/);
  });

  it("JSON roto → lista vacía sin lanzar", () => {
    const warnings = [];
    const list = parseAgentsLocalDocument("{ nope", (m) => warnings.push(m));
    assert.deepEqual(list, []);
    assert.match(warnings[0], /inválido/i);
  });
});
