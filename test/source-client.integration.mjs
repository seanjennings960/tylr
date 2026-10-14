// Real browser-client/Python-server contract check, without an OCaml toolchain.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const { SourceSession, renderSnapshot } = createRequire(import.meta.url)("../src/web/source-client.js");

test("real Python LSP serves exact source, navigation, recovery, and isolated sessions", { timeout: 30000 }, async () => {
  const process = spawn("python3", ["-m", "server", "--http", "--port", "0"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = once(process, "exit");
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = "";
      process.once("error", reject);
      process.once("exit", code => reject(new Error("Language server exited before listening: " + code + " " + output)));
      process.stderr.on("data", chunk => {
        output = (output + chunk).slice(-4096);
        const match = output.match(/tylr language server: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolve(match[1]);
      });
    });
    const samples = [
      "2 + 3 * 4",
      "@wrap\r\ndef greet(name):\r\n\tmessage = \"𝒙\"  # comment\r\n\treturn f\"hi {name}\"\r\n",
      "def f():\n    return \"\"\"line one\nline two\"\"\"",
      "", "# only a comment", "def unfinished(",
    ];
    for (const [i, text] of samples.entries()) {
      const session = new SourceSession({ endpoint, uri: `file:///sample${i}.py`, languageId: "python", text });
      await session.start();
      assert.equal(session.status, i === 5 ? "unavailable" : "ready");
      if (i === 0) {
        session.navigate("nextToken");
        session.navigate("nextToken", { extend: true });
        session.navigate("nextToken", { extend: true });
        assert.equal(session.snapshot().selectedText, "2 + 3");
        session.navigate("nextToken");
        session.navigate("nextToken", { extend: true });
        assert.equal(session.snapshot().selectedText, "* 4");
      }
      session.selectOffsets(0, text.length);
      assert.equal(renderSnapshot(session).source, text);
      assert.equal(renderSnapshot(session).selected_text, text);
      if (i === 5) {
        assert.ok(session.snapshot().diagnostics.length);
        await session.update("answer = 42\r\n");
        assert.equal(session.status, "ready");
        assert.equal(session.version, 2);
        assert.equal(session.text, "answer = 42\r\n");
      }
      await session.close();
    }
    const left = new SourceSession({ endpoint, uri: "file:///same.py", languageId: "python", text: "left = 1" });
    const right = new SourceSession({ endpoint, uri: "file:///same.py", languageId: "python", text: "right = 2" });
    await Promise.all([left.start(), right.start()]);
    assert.notEqual(left.sessionId, right.sessionId);
    left.navigate("nextToken");
    right.navigate("nextToken");
    assert.equal(left.snapshot().selectedText, "left");
    assert.equal(right.snapshot().selectedText, "right");
    await Promise.all([left.close(), right.close()]);
    await assert.rejects(left.rpc("tylr/structure", { textDocument: { uri: left.uri, version: 1 } }), /HTTP 404/);
  } finally {
    process.kill("SIGTERM");
    await exited;
  }
});
