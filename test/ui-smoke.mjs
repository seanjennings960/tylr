// Exercise the compiled Reason application against the real Python LSP server.
// Install Playwright in a temporary prefix and set PLAYWRIGHT_MODULE to its
// package path when it is not installed in this checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const www = path.resolve(root, process.env.TYLR_WWW || "_build/default/src/web/www");
const artifacts = path.resolve(root, process.env.TYLR_UI_ARTIFACTS || "_build/ui-artifacts");

test("existing Tylr UI navigates Python and preserves arbitrary source ranges", { timeout: 90000 }, async () => {
  await Promise.all([access(path.join(www, "tiles.js")), access(path.join(www, "source-client.js"))]);
  await mkdir(artifacts, { recursive: true });
  const server = spawn("python3", ["-m", "server", "--http", "--port", "0", "--www", www], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = once(server, "exit");
  let browser, page;
  const errors = [];
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = "";
      server.once("error", reject);
      server.once("exit", code => reject(new Error(`Server exited before listening (${code}): ${output}`)));
      server.stderr.on("data", chunk => {
        output = (output + chunk).slice(-4096);
        const match = output.match(/tylr language server: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolve(match[1]);
      });
    });
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(endpoint, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      // Observe what the app writes to the actual browser copy event before
      // any platform clipboard normalization (for example LF/CRLF conversion).
      window.tylrCopyEvents = [];
      window.addEventListener("copy", event => {
        window.tylrCopiedSource = event.clipboardData.getData("text/plain");
        window.tylrCopyEvents.push({
          targetId: event.target.id, targetTag: event.target.tagName,
          prevented: event.defaultPrevented, text: window.tylrCopiedSource,
        });
      });
    });
    // Native text/carets are absolutely positioned, so its root can have zero
    // height even when the application is mounted and ready for interaction.
    await page.locator("#code-container .code").waitFor({ state: "attached" });
    await page.getByRole("button", { name: "Open source…", exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.locator("#code-container .source-code").count(), 0);
    await page.getByRole("textbox", { name: "Language server language ID" }).fill("python");

    async function openSource(name, text, status = "ready") {
      const choosing = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Open source…", exact: true }).click();
      await (await choosing).setFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
      await page.locator(`#code-container .source-code[data-source-status="${status}"]`).waitFor();
      await page.waitForFunction(expected => document.querySelector(".source-context")?.textContent.includes(expected), name);
    }

    async function selected(text) {
      await page.waitForFunction(expected =>
        Array.from(document.querySelectorAll("#code-container .source-selected"), element => element.textContent).join("") === expected,
      text);
    }

    async function copySelection(expected) {
      const previousCount = await page.evaluate(() => window.tylrCopyEvents.length);
      await page.keyboard.press("Control+c");
      await page.waitForFunction(count => window.tylrCopyEvents.length > count, previousCount);
      assert.equal(await page.evaluate(() => window.tylrCopiedSource), expected);
      // The copy-event value must remain exact; the OS clipboard may normalize
      // newline conventions without changing what the editor wrote.
      await page.waitForFunction(async text =>
        (await navigator.clipboard.readText()).replaceAll("\r\n", "\n") === text.replaceAll("\r\n", "\n"), expected);
    }

    async function caretAt(hand, row, col) {
      const position = await page.locator(`#code-container .caret.${hand}`).evaluate((caret, target) => {
        const box = caret.ownerSVGElement.getBoundingClientRect();
        const line = document.querySelectorAll("#code-container .source-line")[target.row].getBoundingClientRect();
        const font = document.getElementById("font-specimen").getBoundingClientRect();
        return { x: box.x, y: box.y, expectedX: line.x + target.col * font.width, expectedY: line.y };
      }, { row, col });
      assert.ok(Math.abs(position.x - position.expectedX) < 1, `${hand} caret aligns with source column ${col}: ${JSON.stringify(position)}`);
      assert.ok(Math.abs(position.y - position.expectedY) < 1, `${hand} caret aligns with source row ${row}: ${JSON.stringify(position)}`);
    }

    const expression = "2 + 3 * 4";
    await openSource("expression.py", expression);
    assert.equal(await page.locator("#code-container").count(), 1);
    assert.equal(await page.locator(".source-line").allTextContents().then(lines => lines.join("\n")), expression);
    assert.ok(await page.locator("#code-container .source-tile").count() >= 5);
    assert.equal(await page.locator("#code-container .caret.focus").count(), 1);

    await page.getByRole("button", { name: "Token →", exact: true }).click();
    await selected("2");
    await page.getByRole("button", { name: "↑ Parent", exact: true }).click();
    await selected(expression);
    await page.getByRole("button", { name: "↓ Child", exact: true }).click();
    await selected("2");
    await page.getByRole("button", { name: "Sibling →", exact: true }).click();
    await selected("+");
    await page.getByRole("button", { name: "← Sibling", exact: true }).click();
    await selected("2");

    // The same hidden clipboard input already used by Tylr routes keyboard
    // events through Page -> Update -> the generic source controller.
    await page.locator("#clipboard-shim").focus();
    await page.keyboard.press("Shift+ArrowRight");
    await selected("2 +");
    await page.keyboard.press("Shift+ArrowRight");
    await selected("2 + 3");
    await page.keyboard.press("ArrowRight");
    await selected("*");
    await page.keyboard.press("Shift+ArrowRight");
    await selected("* 4");

    // Click across AST branches using the shared font metrics, independently
    // of node selection. Neither 2 + 3 nor * 4 is an AST subtree here.
    await page.evaluate(() => document.fonts.ready);
    const metrics = await page.evaluate(() => {
      const code = document.getElementById("code-container").getBoundingClientRect();
      const font = document.getElementById("font-specimen").getBoundingClientRect();
      return { x: code.x, y: code.y, width: font.width, height: font.height };
    });
    await page.mouse.click(metrics.x + 0.1, metrics.y + metrics.height / 2);
    await page.keyboard.down("Shift");
    await page.mouse.click(metrics.x + metrics.width * 5, metrics.y + metrics.height / 2);
    await page.keyboard.up("Shift");
    await selected("2 + 3");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "clipboard-shim");
    assert.equal(await page.locator("#code-container .caret.anchor").count(), 1);
    await caretAt("focus", 0, 5);
    await caretAt("anchor", 0, 0);
    await copySelection("2 + 3");
    await page.screenshot({ path: path.join(artifacts, "cross-tree-selection.png"), fullPage: true });

    const original = "@decorator\r\ndef greet(name):\r\n\tmessage = \"𝒙\"  # retain tabs and CRLF\r\n\treturn f\"hi {name}\"\r\n";
    await openSource("unicode.py", original);
    assert.equal(await page.locator(".source-line").allTextContents().then(lines => lines.join("\n")), original.replaceAll("\r\n", "\n"));
    await page.locator("#clipboard-shim").focus();
    await page.keyboard.press("Control+a");
    await selected(original.replaceAll("\r\n", ""));
    await caretAt("focus", 4, 0);
    await caretAt("anchor", 0, 0);
    await copySelection(original);
    await page.keyboard.press("Delete");
    await page.keyboard.type("x");
    assert.equal(await page.locator(".source-line").allTextContents().then(lines => lines.join("\n")), original.replaceAll("\r\n", "\n"));
    await page.screenshot({ path: path.join(artifacts, "unicode-source.png"), fullPage: true });

    await openSource("unfinished.py", "def unfinished(\n", "unavailable");
    assert.match(await page.locator(".source-status").innerText(), /^unavailable:/);
    assert.equal(await page.locator(".source-line").allTextContents().then(lines => lines.join("\n")), "def unfinished(\n");
    await page.getByRole("button", { name: "Native editor", exact: true }).click();
    await page.locator("#code-container .source-code").waitFor({ state: "detached" });
    assert.equal(await page.locator("#code-container .code").count(), 1);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
      const state = await page.evaluate(() => ({
        activeElement: { id: document.activeElement?.id, tag: document.activeElement?.tagName },
        copyValue: window.tylrCopiedSource ?? null,
        copyEvents: window.tylrCopyEvents ?? [],
        selection: Array.from(document.querySelectorAll(".source-selected"), node => node.textContent).join(""),
      })).catch(() => null);
      await writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ state, pageErrors: errors, error: String(error) }, null, 2));
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
    await exited;
  }
});
