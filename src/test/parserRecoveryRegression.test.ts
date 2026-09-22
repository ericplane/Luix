import * as assert from "assert";
import { spawnSync } from "child_process";

/** Keep a scanner regression from hanging the extension-host test runner. */
function runParserInChild(body: string): void {
  const script = [
    `const parser = require(${JSON.stringify(require.resolve("../parser"))});`,
    'const assert = require("assert");',
    body,
    'process.stdout.write("completed");',
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    // The VS Code test host runs in Electron; launch its Node runtime.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, "completed");
}

suite("Parser recovery from partially typed Vide calls", () => {
  test("unmatched closers terminate and preserve subsequent properties", () => {
    runParserInChild(`
      for (const prefix of ["create)", "create {} )", "create {} ]", "create {} }", "Size = )", "[key] = ]"]) {
        const body = prefix + ', Name = "Recovered", Visible = true';
        const entries = parser.extractPropEntries(body);
        assert.deepStrictEqual(entries.slice(-2).map(entry => entry.key), ["Name", "Visible"]);
        const name = entries.find(entry => entry.key === "Name");
        assert.strictEqual(body.slice(name.valueStart, name.valueEnd), '"Recovered"');
      }
    `);
  });

  test("full-document prop extraction recovers from an incomplete child call", () => {
    runParserInChild(`
      const prefix = 'return create "ImageButton" {';
      const body = 'create {} ), Name = "Recovered"';
      const text = prefix + body + '}';
      const entries = parser.extractPropEntriesFromDocument(text, prefix.length, prefix.length + body.length);
      assert.deepStrictEqual(entries.map(entry => entry.key), ["Name"]);
    `);
  });

  test("component scanning survives malformed then repaired text in the same worker", () => {
    runParserInChild(`
      const aliases = { parens: ["create"], curried: ["create"], parensWithInlineChildren: ["create"] };
      const component = child => 'local function ButtonTest(props)\\n return create "ImageButton" { ' + child + ' }\\nend';
      const repaired = component('create "TextLabel" {}');
      for (const child of ['create)', 'create {} )', 'create {} ]', 'create {}']) {
        const malformed = component(child);
        const brokenScan = parser.scanDocument(malformed, aliases);
        assert.strictEqual(brokenScan.get("ButtonTest").detectedBase, "ImageButton");
        const recoveredScan = parser.scanDocument(repaired, aliases);
        assert.strictEqual(recoveredScan.get("ButtonTest").detectedBase, "ImageButton");
        const calls = parser.findAllCreateElementCalls(repaired, aliases);
        assert.deepStrictEqual(calls.map(call => call.className), ["ImageButton", "TextLabel"]);
        const bodyStart = calls[0].propsBraceStart + 1;
        assert.deepStrictEqual(parser.extractPropEntriesFromDocument(repaired, bodyStart, calls[0].propsBraceEnd), []);
      }
    `);
  });
});
