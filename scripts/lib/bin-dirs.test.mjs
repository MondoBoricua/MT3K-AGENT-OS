import test from "node:test";
import assert from "node:assert/strict";
import { nvmBinDirs } from "./bin-dirs.mjs";

// fake FS: `versions` = installed dir names, `files` = { path: content }
const fakeFs = (nvmDir, versions, files = {}) => {
  const vdir = `${nvmDir}/versions/node`;
  const dirs = new Set([vdir, ...versions.map((v) => `${vdir}/${v}/bin`)]);
  return {
    exists: (p) => dirs.has(p),
    readdir: (p) => { if (p !== vdir) throw new Error("ENOENT"); return versions; },
    readFile: (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; },
  };
};
const bin = (nvmDir, v) => `${nvmDir}/versions/node/${v}/bin`;
const H = "/home/u";
const N = `${H}/.nvm`;

test("default alias (bare version) goes first", () => {
  const fs = fakeFs(N, ["v22.23.2", "v24.14.0"], { [`${N}/alias/default`]: "22.23.2\n" });
  assert.deepEqual(nvmBinDirs({ home: H, ...fs }), [bin(N, "v22.23.2"), bin(N, "v24.14.0")]);
});

test("default alias with leading v goes first", () => {
  const fs = fakeFs(N, ["v20.1.0", "v22.23.2", "v24.14.0"], { [`${N}/alias/default`]: "v20.1.0" });
  assert.deepEqual(nvmBinDirs({ home: H, ...fs }), [bin(N, "v20.1.0"), bin(N, "v24.14.0"), bin(N, "v22.23.2")]);
});

test("unresolvable alias (lts/*) falls back to version descending", () => {
  const fs = fakeFs(N, ["v9.0.0", "v22.23.2", "v24.14.0"], { [`${N}/alias/default`]: "lts/*" });
  assert.deepEqual(nvmBinDirs({ home: H, ...fs }), [bin(N, "v24.14.0"), bin(N, "v22.23.2"), bin(N, "v9.0.0")]);
});

test("alias chaining through lts/* file resolves", () => {
  const fs = fakeFs(N, ["v22.23.2", "v24.14.0"], { [`${N}/alias/default`]: "lts/*", [`${N}/alias/lts/*`]: "lts/jod", [`${N}/alias/lts/jod`]: "v22.23.2" });
  assert.deepEqual(nvmBinDirs({ home: H, ...fs })[0], bin(N, "v22.23.2"));
});

test("partial alias (22) picks newest installed 22.x", () => {
  const fs = fakeFs(N, ["v22.1.0", "v22.23.2", "v24.14.0"], { [`${N}/alias/default`]: "22" });
  assert.deepEqual(nvmBinDirs({ home: H, ...fs })[0], bin(N, "v22.23.2"));
});

test("missing alias file falls back to version descending", () => {
  const fs = fakeFs(N, ["v22.23.2", "v24.14.0"]);
  assert.deepEqual(nvmBinDirs({ home: H, ...fs }), [bin(N, "v24.14.0"), bin(N, "v22.23.2")]);
});

test("no nvm installed → []", () => {
  const fs = fakeFs(N, []);
  assert.deepEqual(nvmBinDirs({ home: "/nowhere", exists: () => false, readdir: fs.readdir, readFile: fs.readFile }), []);
});

test("version dir without bin is skipped; non-version entries ignored", () => {
  const fs = fakeFs(N, ["v22.23.2", "v24.14.0", "junk"]);
  const exists = (p) => fs.exists(p) && !p.includes("v24.14.0");
  assert.deepEqual(nvmBinDirs({ home: H, ...fs, exists }), [bin(N, "v22.23.2")]);
});

test("NVM_DIR overrides ~/.nvm", () => {
  const custom = "/opt/nvm";
  const fs = fakeFs(custom, ["v18.0.0", "v22.23.2"], { [`${custom}/alias/default`]: "18.0.0" });
  assert.deepEqual(nvmBinDirs({ home: H, env: { NVM_DIR: custom }, ...fs }), [bin(custom, "v18.0.0"), bin(custom, "v22.23.2")]);
});

test("does not mutate injected readdir result", () => {
  const names = ["v1.0.0", "v2.0.0"];
  const fs = fakeFs(N, names);
  nvmBinDirs({ home: H, ...fs });
  assert.deepEqual(names, ["v1.0.0", "v2.0.0"]);
});

test("ambiguous partial alias 22.1 picks v22.1.x, not v22.10.x", () => {
  const fs = fakeFs(N, ["v22.1.0", "v22.10.0"], { [`${N}/alias/default`]: "22.1" });
  assert.deepEqual(nvmBinDirs({ home: H, ...fs }), [bin(N, "v22.1.0"), bin(N, "v22.10.0")]);
});

for (const alias of ["node", "stable"]) {
  test(`alias "${alias}" puts the newest installed version first`, () => {
    const fs = fakeFs(N, ["v18.0.0", "v24.14.0", "v22.23.2"], { [`${N}/alias/default`]: alias });
    assert.deepEqual(nvmBinDirs({ home: H, ...fs }), [bin(N, "v24.14.0"), bin(N, "v22.23.2"), bin(N, "v18.0.0")]);
  });
}

test("alias chain longer than 5 hops does not throw; default is ignored (version descending)", () => {
  const files = { [`${N}/alias/default`]: "a0" };
  for (let i = 0; i < 6; i++) files[`${N}/alias/a${i}`] = `a${i + 1}`;
  files[`${N}/alias/a6`] = "v22.0.0";
  const fs = fakeFs(N, ["v22.0.0", "v24.14.0"], files);
  assert.deepEqual(nvmBinDirs({ home: H, ...fs }), [bin(N, "v24.14.0"), bin(N, "v22.0.0")]);
});

test("default alias naming a version that is not installed gives plain descending order (documented current behavior)", () => {
  const fs = fakeFs(N, ["v22.23.1", "v24.14.0"], { [`${N}/alias/default`]: "22.23.2" });
  assert.deepEqual(nvmBinDirs({ home: H, ...fs }), [bin(N, "v24.14.0"), bin(N, "v22.23.1")]);
});
