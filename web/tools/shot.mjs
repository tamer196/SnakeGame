/**
 * Screenshot and scripting harness for visual verification.
 *
 * Serves a built dist (or attaches to a running dev server), boots the game
 * in headless Chrome, optionally runs a script inside the page, waits for the
 * animation to settle, and writes a PNG. Console errors and page errors are
 * echoed to stdout so a caller can grep for them.
 *
 *   node tools/shot.mjs --out shot.png
 *   node tools/shot.mjs --url http://localhost:5173 --out shot.png
 *   node tools/shot.mjs --eval "game.switchScene('game',{level:4})" \
 *       --wait 2000 --out level5.png
 *
 * Flags:
 *   --dist <dir>    static root to serve (default web/dist; ignored with --url)
 *   --url <url>     attach to an already-running server instead of serving
 *   --out <png>     screenshot path (default shot.png)
 *   --eval <js>     JS to run once the game has booted; `game` is in scope,
 *                   awaited if it returns a promise
 *   --wait <ms>     settle time between eval and screenshot (default 1200)
 *   --w/--h/--dpr   viewport (default 1280x720 @1)
 *   --touch         emulate a touch device
 *   --strict        exit 1 if any console/page error was seen
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ??
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args[key] = true;
  else { args[key] = next; i++; }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = args.dist ?? join(HERE, "..", "dist");
const OUT = args.out ?? "shot.png";
const WAIT = Number(args.wait ?? 1200);
const W = Number(args.w ?? 1280);
const H = Number(args.h ?? 720);
const DPR = Number(args.dpr ?? 1);
const PORT = 5198;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".map": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
};

function serve(root) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
        let p = normalize(join(root, url === "/" ? "/index.html" : url));
        if (!p.startsWith(normalize(root))) { res.writeHead(403).end(); return; }
        const s = await stat(p).catch(() => null);
        if (!s || s.isDirectory()) p = join(root, "index.html");
        const body = await readFile(p);
        res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    server.listen(PORT, () => resolve(server));
  });
}

let errors = 0;
const server = args.url ? null : await serve(DIST);
const url = args.url ?? `http://localhost:${PORT}/`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") { errors++; console.log(`[console-error] ${m.text()}`); }
    else if (m.type() === "warning") console.log(`[console-warn] ${m.text()}`);
  });
  page.on("pageerror", (e) => { errors++; console.log(`[page-error] ${e}`); });
  page.on("requestfailed", (r) => {
    errors++;
    console.log(`[request-failed] ${r.url()} ${r.failure()?.errorText}`);
  });

  await page.setViewport({
    width: W, height: H, deviceScaleFactor: DPR,
    hasTouch: !!args.touch, isMobile: !!args.touch,
  });
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  const booted = await page
    .waitForFunction("!!window.game && !!window.game.viewport", { timeout: 15000 })
    .then(() => true).catch(() => false);
  if (!booted) { console.log("[fatal] game did not boot within 15s"); process.exit(2); }
  console.log("[ok] game booted");

  if (args.eval) {
    const result = await page.evaluate(
      `(async () => { const game = window.game; return await (async () => { ${args.eval} })(); })()`,
    );
    if (result !== undefined) console.log(`[eval] ${JSON.stringify(result)}`);
  }

  await new Promise((r) => setTimeout(r, WAIT));
  await page.screenshot({ path: OUT });
  console.log(`[ok] wrote ${OUT}`);
} finally {
  await browser.close();
  server?.close();
}

if (args.strict && errors > 0) {
  console.log(`RESULT: FAIL (${errors} errors)`);
  process.exit(1);
}
console.log(errors > 0 ? `RESULT: PASS with ${errors} errors logged` : "RESULT: PASS");
