// Exercise typed expression drafts through the compiled Reason UI and real LSP.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const www = path.resolve(root, process.env.TYLR_WWW || "_build/default/src/web/www");
const artifacts = path.resolve(root, process.env.TYLR_UI_ARTIFACTS || "_build/ui-artifacts");

test("typed expression draft holes preserve operands and never overwrite source", { timeout: 90000 }, async () => {
  await Promise.all([access(path.join(www, "tiles.js")), access(path.join(www, "source-client.js"))]);
  await mkdir(artifacts, { recursive: true });
  const server = spawn("python3", ["-m", "server", "--http", "--port", "0", "--www", www], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = once(server, "exit");
  const errors = [];
  let browser, page;
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
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
    context.setDefaultTimeout(10000);
    page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(endpoint, { waitUntil: "networkidle" });
    await page.locator("#code-container .code").waitFor({ state: "attached" });
    const button = name => page.getByRole("button", { name, exact: true });
    await button("Open source…").waitFor({ state: "visible" });
    await page.getByRole("textbox", { name: "Language server language ID" }).fill("python");

    async function openSource(name, text) {
      const choosing = page.waitForEvent("filechooser");
      await button("Open source…").click();
      await (await choosing).setFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
      await page.locator('#code-container .source-code[data-source-status="ready"]').waitFor();
      await page.waitForFunction(expected => document.querySelector(".source-context")?.textContent.includes(expected), name);
      await sourceEquals(text);
    }

    async function sourceEquals(text) {
      await page.waitForFunction(expected =>
        Array.from(document.querySelectorAll("#code-container .source-line"), node => node.textContent).join("\n") === expected,
      text);
    }

    async function selected(text) {
      await page.waitForFunction(expected =>
        Array.from(document.querySelectorAll("#code-container .source-selected"), node => node.textContent).join("") === expected,
      text);
    }

    async function selectToken(text) {
      const exact = new RegExp("^" + text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
      await page.locator("#code-container .source-segment").filter({ hasText: exact }).click();
      // A click chooses a caret; token movement then selects the exact token.
      await button("← Token").click();
      await button("Token →").click();
      await selected(text);
    }

    const original = "2 + 3 * 4";
    await openSource("expression.py", original);
    assert.equal(await page.locator(".source-edit-heading").count(), 0);
    await button("Edit expression draft").click();
    await page.locator(".source-edit-heading").waitFor();
    await sourceEquals("(2 + (3 * 4))");
    await selectToken("+");
    await button("Delete operator").click();
    await sourceEquals("(2 ◇ (3 * 4))");
    await selected("◇");
    assert.equal(await button("Export draft").isDisabled(), true);
    await page.screenshot({ path: path.join(artifacts, "edit-holes.png"), fullPage: true });

    await button("Fill *").click();
    const multiplied = "(2 * (3 * 4))";
    await sourceEquals(multiplied);
    assert.equal(await button("Export draft").isEnabled(), true);
    const downloading = page.waitForEvent("download");
    await button("Export draft").click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "expression.py");
    const downloaded = await download.path();
    assert.ok(downloaded);
    assert.equal(await readFile(downloaded, "utf8"), multiplied);

    await selectToken("2");
    await button("Delete expression").click();
    await sourceEquals("(□ * (3 * 4))");
    assert.equal(await button("Export draft").isDisabled(), true);
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("class");
    await button("Fill name").click();
    await page.waitForFunction(() => document.querySelector(".source-edit-hint")?.textContent.includes("action rejected"));
    await sourceEquals("(□ * (3 * 4))");
    assert.equal(await button("Export draft").isDisabled(), true);
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("total");
    await button("Fill name").click();
    await sourceEquals("(total * (3 * 4))");
    assert.equal(await button("Export draft").isEnabled(), true);

    await button("Discard draft").click();
    await page.locator(".source-edit-heading").waitFor({ state: "detached" });
    await sourceEquals(original);
    assert.match(await page.locator(".source-help").innerText(), /^Read-only/);
    await page.locator("#clipboard-shim").focus();
    await page.keyboard.press("Control+a");
    await selected(original);
    await page.keyboard.press("Delete");
    await page.keyboard.type("x");
    await sourceEquals(original);

    // Unsupported Python stays available for navigation, with no partial draft.
    await openSource("call.py", "f(2)");
    await button("Edit expression draft").click();
    await page.waitForFunction(() => document.querySelector(".source-edit-hint")?.textContent.includes("only binary"));
    await sourceEquals("f(2)");
    assert.equal(await page.locator(".source-edit-heading").count(), 0);
    assert.equal(await button("Discard draft").count(), 0);
    assert.match(await page.locator(".source-help").innerText(), /^Read-only/);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(artifacts, "edit-failure.png"), fullPage: true }).catch(() => {});
      const state = await page.evaluate(() => ({
        activeElement: { id: document.activeElement?.id, tag: document.activeElement?.tagName },
        source: Array.from(document.querySelectorAll(".source-line"), node => node.textContent).join("\n"),
        selection: Array.from(document.querySelectorAll(".source-selected"), node => node.textContent).join(""),
        hint: document.querySelector(".source-edit-hint")?.textContent,
        status: document.querySelector(".source-status")?.textContent,
      })).catch(() => null);
      await writeFile(path.join(artifacts, "edit-failure.json"), JSON.stringify({ state, pageErrors: errors, error: String(error) }, null, 2));
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
    await exited;
  }
});
