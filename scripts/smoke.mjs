// Visit each page, wait for it to settle, record console errors, page errors, failed requests,
// horizontal overflow at phone width, and a screenshot.
// Usage: node scripts/smoke.mjs <outdir> "/,/r/click,/r/click/impact?t=..."  (prints a JSON report)
// Env: SMOKE_BASE (default http://localhost:3101), PLAYWRIGHT_FROM (a node_modules dir with playwright-core),
//      CHROMIUM (default /usr/bin/chromium).
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL("../web/node_modules/", import.meta.url).pathname);
const { chromium } = require("playwright-core");

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3101";
const OUT = process.argv[2];
const pages = (process.argv[3] ?? "").split(",").filter(Boolean);
const widths = [
  ["desk", 1440, 900],
  ["phone", 390, 844],
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const report = [];
for (const [tag, w, h] of widths) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  for (const p of pages) {
    const page = await ctx.newPage();
    const errs = [];
    page.on("console", (m) => m.type() === "error" && errs.push("console: " + m.text().slice(0, 300)));
    page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 300)));
    page.on("response", (r) => r.status() >= 400 && errs.push(`http ${r.status()} ${r.url().replace(BASE, "")}`));
    try {
      await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 60000 });
    } catch (e) {
      errs.push("goto: " + String(e).slice(0, 200));
    }
    await page.waitForTimeout(2500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 400);
    const name = `${tag}-${p.replace(/[^a-z0-9]+/gi, "_")}.png`;
    await page.screenshot({ path: `${OUT}/${name}`, fullPage: true });
    report.push({ tag, p, overflow, errs, text, shot: name });
    await page.close();
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
