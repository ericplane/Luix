import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import * as vscode from "vscode";

function contentApi(directory: string, failDirectory?: string) {
  const filename = path.join(__dirname, "..", "robloxContent.js");
  const module = { exports: {} };
  const warnings: string[] = [];
  const fileSystem = {
    ...fs,
    promises: {
      ...fs.promises,
      readdir: async (target: string, options: { withFileTypes: true; recursive?: boolean }) => {
        assert.strictEqual(options.recursive, undefined, "must work before Node 18.17");
        if (target === failDirectory) { throw new Error("unreadable content directory"); }
        return fs.promises.readdir(target, options);
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports, Buffer, TextDecoder, TextEncoder, process,
    require: (id: string) => {
      if (id === "vscode") { return vscode; }
      if (id === "fs") { return fileSystem; }
      if (id === "./configCompat") {
        return { getConfig: (key: string, fallback: unknown) => key === "robloxContent.path" ? directory : fallback };
      }
      if (id === "./output") { return { logWarn: (message: string) => warnings.push(message) }; }
      return require(require.resolve(id, { paths: [path.dirname(filename)] }));
    },
  }, { filename });
  return { api: module.exports as typeof import("../robloxContent"), warnings };
}

async function removeFixture(directory: string): Promise<void> {
  assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith("luix-content-compatibility-"));
  await fs.promises.rm(directory, { recursive: true, force: true });
}

suite("Roblox content runtime compatibility", () => {
  test("nested content is discovered without recursive readdir and remains sorted", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "luix-content-compatibility-"));
    try {
      await fs.promises.mkdir(path.join(directory, "textures", "ui"), { recursive: true });
      await fs.promises.mkdir(path.join(directory, "fonts"), { recursive: true });
      await fs.promises.writeFile(path.join(directory, "textures", "ui", "zeta.png"), "png");
      await fs.promises.writeFile(path.join(directory, "textures", "ui", "alpha.PNG"), "png");
      await fs.promises.writeFile(path.join(directory, "fonts", "Family.json"), "{}");
      await fs.promises.writeFile(path.join(directory, "textures", "ignored.txt"), "not an asset");
      const { api } = contentApi(directory);
      assert.deepStrictEqual(Array.from(await api.getContentFiles()), [
        "fonts/Family.json", "textures/ui/alpha.PNG", "textures/ui/zeta.png",
      ]);
    } finally { await removeFixture(directory); }
  });

  test("directory links retain their asset paths without traversing ancestor cycles", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "luix-content-compatibility-"));
    try {
      await fs.promises.mkdir(path.join(directory, "textures"));
      await fs.promises.writeFile(path.join(directory, "textures", "icon.png"), "png");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await fs.promises.symlink(path.join(directory, "textures"), path.join(directory, "linked"), linkType);
      await fs.promises.symlink(directory, path.join(directory, "textures", "back"), linkType);
      const { api } = contentApi(directory);
      assert.deepStrictEqual(Array.from(await api.getContentFiles()), ["linked/icon.png", "textures/icon.png"]);
    } finally { await removeFixture(directory); }
  });

  test("a directory read failure keeps the existing empty-result and warning behavior", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "luix-content-compatibility-"));
    try {
      const textures = path.join(directory, "textures");
      await fs.promises.mkdir(textures);
      const { api, warnings } = contentApi(directory, textures);
      assert.deepStrictEqual(Array.from(await api.getContentFiles()), []);
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes("failed to scan content folder"));
    } finally { await removeFixture(directory); }
  });
});
