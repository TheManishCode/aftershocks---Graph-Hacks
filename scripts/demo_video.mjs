// Record a short walkthrough of the running UI to a .webm, then convert with ffmpeg:
//   node scripts/demo_video.mjs <outdir>  &&  ffmpeg -i <outdir>/*.webm -c:v libx264 -pix_fmt yuv420p -crf 23 demo.mp4
// Env: DEMO_BASE (default http://localhost:3101), DEMO_REPO (default flask), DEMO_SYMBOL (a symbol id in that repo),
//      PLAYWRIGHT_FROM (a node_modules dir with playwright-core), CHROMIUM (default /usr/bin/chromium).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? fileURLToPath(new URL("../web/node_modules/", import.meta.url)));
const { chromium } = require("playwright-core");

const BASE = process.env.DEMO_BASE ?? "http://localhost:3101";
const REPO = process.env.DEMO_REPO ?? "flask";
const SYM = process.env.DEMO_SYMBOL ?? "src/flask/sansio/app.py::App.register_blueprint";
const OUT = process.argv[2];
const enc = encodeURIComponent;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: OUT, size: { width: 1440, height: 900 } } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));

const visit = async (path, hold = 3500) => {
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(hold);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(1500);
};

await visit("/", 2500);
await visit(`/r/${REPO}`);
await visit(`/r/${REPO}/explore?ref=${enc(SYM)}`);
await visit(`/r/${REPO}/impact?t=${enc(SYM)}&change=signature&depth=4`, 6000);
await visit(`/r/${REPO}/diff`);
await visit(`/r/${REPO}/culprit`);
await page.close();
const video = await page.video().path();
await ctx.close();
await browser.close();
console.log(JSON.stringify({ video, errors: errs }));
