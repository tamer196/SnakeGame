/**
 * Capture every level background in one browser session.
 *
 * The twelve stages are the bulk of the renderer port, and the only way to
 * judge them is side by side with the Python screenshots in `captures/`. One
 * browser, one server, twelve deterministic captures:
 *
 *   node tools/shot-levels.mjs --out ../captures/web
 *
 * Each stage is advanced by a fixed number of simulated seconds before the
 * shot, so a capture is reproducible and two runs can be compared to each
 * other rather than to whenever the screenshot happened to land.
 *
 * Flags:
 *   --dist <dir>   static root (default web/dist)
 *   --out <dir>    output directory (created if missing)
 *   --levels <csv> 1-based level numbers (default all twelve)
 *   --seek <s>     simulated seconds to advance before capturing (default 6)
 *   --w/--h/--dpr  viewport (default 1280x720 @1, matching the Python captures)
 *   --strict       exit non-zero if any console or page error was seen
 */

import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

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
const OUT = args.out ?? join(HERE, "..", "..", "captures", "web");
const SEEK = Number(args.seek ?? 6);
const W = Number(args.w ?? 1280);
const H = Number(args.h ?? 720);
const DPR = Number(args.dpr ?? 1);
const PORT = Number(args.port ?? 5197);

const NAMES = [
  "neon-grid", "deep-nebula", "emerald-circuit", "solar-flare",
  "abyssal-tide", "violet-static", "frozen-vault", "toxic-bloom",
  "crimson-engine", "aurora-drift", "event-horizon", "prism-core",
];

const levels = args.levels
  ? String(args.levels).split(",").map((s) => parseInt(s, 10)).filter(Number.isFinite)
  : NAMES.map((_, i) => i + 1);

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

await mkdir(OUT, { recursive: true });
const server = await serve(DIST);
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});

let errors = 0;
const seen = new Set();

try {
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (seen.has(t)) return;
    seen.add(t);
    errors++;
    console.log(`[console-error] ${t}`);
  });
  page.on("pageerror", (e) => {
    const t = String(e);
    if (seen.has(t)) return;
    seen.add(t);
    errors++;
    console.log(`[page-error] ${t}`);
  });

  await page.setViewport({ width: W, height: H, deviceScaleFactor: DPR });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForFunction("!!window.game && !!window.game.viewport", { timeout: 15000 });
  console.log(`[ok] booted at ${W}x${H} @${DPR}x`);

  for (const n of levels) {
    const idx = n - 1;
    const name = NAMES[idx] ?? `level-${n}`;
    const label = `level-${String(n).padStart(2, "0")}-${name}`;
    const before = errors;

    // Rebuild the stage, then advance it deterministically with the animation
    // loop's own step size so the capture does not depend on wall-clock timing.
    const info = await page.evaluate(
      async (level, seek) => {
        const game = window.game;
        game.switchScene("preview", { level, animate: false });
        const scene = game.scene;
        if (scene && typeof scene.seek === "function") scene.seek(seek);
        return { style: game.scene ? game.scene.constructor.name : "?" };
      },
      idx,
      SEEK,
    );

    await new Promise((r) => setTimeout(r, 260));
    const file = join(OUT, `${label}.png`);
    await page.screenshot({ path: file });
    const flag = errors > before ? "  <-- ERRORS" : "";
    console.log(`[ok] ${label}  (${info.style})${flag}`);
  }
} finally {
  await browser.close();
  server.close();
}

console.log(errors ? `\nRESULT: ${errors} distinct error(s) logged` : "\nRESULT: clean");
process.exit(args.strict && errors ? 1 : 0);
