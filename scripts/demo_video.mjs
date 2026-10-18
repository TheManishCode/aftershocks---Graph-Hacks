// Record a captioned walkthrough of the running UI against the `ledger` demo repo.
//
//   PLAYWRIGHT_FROM=<node_modules with playwright-core> node scripts/demo_video.mjs <workdir> media/aftershock-demo.mp4
//   (frames come from Chrome's screencast; needs ffmpeg on PATH)
//
// Needs: the API (AFTERSHOCK_ALLOW_RUN=1, an LLM key in its environment for the Ask step), the web UI,
// the `ledger` repo indexed, and the compliance suite at DEMO_LIB. API keys are never typed into the page;
// any key suffix the settings page shows is masked before it is painted.
// Env: DEMO_BASE (default http://localhost:3111), DEMO_API (default http://127.0.0.1:8100/api/v1),
//      DEMO_LIB (default /home/Fool/aftershock-demo/compliance-suite), DEMO_MODEL (default DeepSeek V3.2),
//      CHROMIUM (default /usr/bin/chromium).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? fileURLToPath(new URL("../web/node_modules/", import.meta.url)));
const { chromium } = require("playwright-core");

const BASE = process.env.DEMO_BASE ?? "http://localhost:3111";
const API = process.env.DEMO_API ?? "http://127.0.0.1:8100/api/v1";
const LIB = process.env.DEMO_LIB ?? "/home/Fool/aftershock-demo/compliance-suite";
const MODEL = process.env.DEMO_MODEL ?? "DeepSeek V3.2";
const OUT = process.argv[2];
const REPO = "ledger";
const SYM = "ledger/money.py::Money.times";
const EXT = "@lib/compliance/test_month_end.py::test_month_end_never_overdraws_an_account";
const enc = encodeURIComponent;

// Start clean so the library is registered on camera.
await fetch(`${API}/repos/${REPO}/libraries/compliance`, { method: "DELETE" }).catch(() => {});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  // Mask any "…abcd" key suffix before it is painted.
  const mask = (n) => {
    const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) if (/^…\S{4}$/.test(w.currentNode.nodeValue.trim())) w.currentNode.nodeValue = "…••••";
  };
  new MutationObserver(() => document.body && mask(document.body)).observe(document, { subtree: true, childList: true, characterData: true });
});
const page = await ctx.newPage();
// Chrome's own screencast, encoded with the system ffmpeg (no Playwright ffmpeg download needed).
const frames = [];
const cdp = await ctx.newCDPSession(page);
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  frames.push({ data, t: metadata.timestamp });
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));

const wait = (ms) => page.waitForTimeout(ms);
const caption = (title, sub = "") =>
  page.evaluate(([t, s]) => {
    document.getElementById("demo-cap")?.remove();
    const d = document.createElement("div");
    d.id = "demo-cap";
    d.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99999;max-width:880px;padding:14px 22px;background:rgba(18,20,22,.92);border:1px solid #c6ff1a;color:#f2f2f2;font:500 18px/1.4 Inter,system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5);pointer-events:none";
    d.innerHTML = `<div style="color:#c6ff1a;font:600 12px/1 'JetBrains Mono',monospace;letter-spacing:.14em;text-transform:uppercase;margin-bottom:6px">${t}</div>${s}`;
    document.body.appendChild(d);
  }, [title, sub]);
const go = async (path, title, sub, hold = 3000) => {
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 60000 });
  await caption(title, sub);
  await wait(hold);
};
const scroll = async (dy, hold = 1800) => {
  await page.mouse.wheel(0, dy);
  await wait(hold);
};

// 1 — what it is
await go("/", "Aftershock", "What breaks if I change this? Code is parsed into a FalkorDB graph; every answer shows its evidence.", 4500);
await scroll(700);

// 2 — the external compliance suite is registered through the API (an operator step; the page lists it), then the
// built-in script library runs its read-only checks
const reg = await fetch(`${API}/repos/${REPO}/libraries`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "compliance", path: LIB }),
});
if (!reg.ok) throw new Error(`registering the compliance library failed: ${reg.status} ${await reg.text()}`);
await go(`/r/${REPO}/tests`, "1 · Tests and checks", "The compliance suite outside the repo is registered; the built-in script library checks the repo.", 2500);
await page.getByText("B · Script library").scrollIntoViewIfNeeded();
await wait(800);
await page.getByRole("button", { name: "Run all quick checks" }).click();
await page.getByText(/^Passed$/).first().waitFor({ timeout: 30000 }).catch(() => {});
await wait(3000);

// 4 — overview
await go(`/r/${REPO}`, "2 · Overview", "Hotspots, central symbols, cycles and dead code — straight from the graph, with query receipts.", 3500);
await scroll(800);
await scroll(900, 2500);

// 5 — explore + impact
await go(`/r/${REPO}/explore?ref=${enc(SYM)}`, "3 · Explore", "Someone changed Money.times to truncate instead of round. Here are its callers and callees.", 4000);
await go(`/r/${REPO}/impact?t=${enc(SYM)}&change=body&depth=4`, "4 · Impact", "The blast radius of that change, hop by hop — including tests the repo itself doesn't know about.", 5500);
await scroll(700, 2500);

// 6 — diff
await go(`/r/${REPO}/diff`, "5 · Diff", "Score the uncommitted working tree before opening the PR.", 1200);
await page.getByRole("button", { name: /Analyze/ }).waitFor({ state: "visible" });
await wait(800);
await page.getByRole("button", { name: /Analyze/ }).click();
await page.getByText(/Money\.times|times/).first().waitFor({ timeout: 30000 }).catch(() => {});
await wait(4500);
await scroll(700, 2500);

// 7 — path
await go(`/r/${REPO}/path?from=${enc(EXT)}&to=${enc(SYM)}`, "6 · Path", "How does an external compliance test reach the changed method? Every hop, with how it was resolved.", 1500);
const find = page.locator("form button[type=submit]").first();
if (await find.isEnabled().catch(() => false)) await find.click();
await wait(5000);

// 8 — run the selected tests
await go(`/r/${REPO}/tests`, "7 · Run only what the change reaches", "Tests are selected from the graph — repo tests and the compliance library together — then run live.", 2000);
await page.locator("button[type=submit]").filter({ hasText: /Run/ }).first().click().catch(() => {});
await page.waitForSelector('a[href*="/culprit?run="]', { timeout: 90000 }).catch(() => {});
await wait(3000);
await scroll(600, 2500);

// 9 — culprit
const href = await page.locator('a[href*="/culprit?run="]').first().getAttribute("href").catch(() => null);
await go(href && !href.includes("heal") ? href : `/r/${REPO}/culprit`, "8 · Culprit", "Each failure is traced back through the graph to the change most likely to have caused it.", 5000);
await scroll(700, 3000);

// 10 — ask an LLM, grounded in the graph
await go(`/r/${REPO}/ask`, "9 · Ask", `Natural-language questions answered by an LLM (${MODEL} via OpenRouter) using graph tools — with a trace of every query.`, 1500);
await page.locator("button").filter({ hasText: /model/i }).first().click().catch(() => {});
await wait(800);
await page.getByText(MODEL, { exact: true }).first().click().catch(() => {});
await wait(600);
await page.getByLabel("Question").pressSequentially("Which tests reach Money.times?", { delay: 18 });
await page.getByRole("button", { name: "Ask", exact: true }).click();
await wait(4000);
await page.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 120000 }).catch(() => {});
await wait(2500);
await scroll(900, 3000);
await scroll(900, 3000);

// 11 — cypher + settings
await go(`/r/${REPO}/cypher`, "10 · Cypher", "Raw read-only Cypher against FalkorDB, for anything the instruments don't cover.", 1200);
await page.getByLabel("Cypher query").fill("MATCH (t:Symbol)-[:CALLS*1..3]->(m:Symbol {name:'times'}) RETURN DISTINCT t.id LIMIT 15");
await page.getByRole("button", { name: /Run/ }).first().click();
await wait(4000);
await go("/settings/models", "Bring your own model", "Keys stay on the server and are never sent back to the browser.", 3500);
await go(`/r/${REPO}`, "Aftershock", "Know what breaks before you merge.", 3000);

await wait(500);
await cdp.send("Page.stopScreencast").catch(() => {});
const { mkdirSync, writeFileSync } = await import("node:fs");
const { execFileSync } = await import("node:child_process");
mkdirSync(`${OUT}/frames`, { recursive: true });
let list = "";
frames.forEach((f, i) => {
  const name = `${OUT}/frames/${String(i).padStart(6, "0")}.jpg`;
  writeFileSync(name, Buffer.from(f.data, "base64"));
  const next = frames[i + 1]?.t ?? f.t + 1;
  list += `file '${name}'\nduration ${Math.max(0.02, next - f.t).toFixed(3)}\n`;
});
writeFileSync(`${OUT}/frames.txt`, list);
const video = process.argv[3] ?? `${OUT}/demo.mp4`;
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${OUT}/frames.txt`, "-vf", "scale=1440:900:force_original_aspect_ratio=decrease,pad=1440:900:(ow-iw)/2:(oh-ih)/2,fps=25,format=yuv420p", "-c:v", "libx264", "-crf", "24", "-preset", "veryfast", "-movflags", "+faststart", video]);
await ctx.close();
await browser.close();
console.log(JSON.stringify({ video, errors: errs }));
