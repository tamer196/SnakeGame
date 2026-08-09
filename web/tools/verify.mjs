/**
 * Boot the built web game in a real browser and prove it renders.
 *
 * Checks, in order:
 *   - the page loads with no console errors and no failed requests
 *   - a WebGL canvas exists and is sized to the viewport
 *   - the frame is not blank (pixel variance, same idea as screenshot.py)
 *   - synthetic touch input reaches the game and moves the steering target
 *   - sustained frame rate over a measured window
 * Run at several viewport sizes, including a phone and an iPad.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import puppeteer from "puppeteer-core";

const CHROME =
  process.env.CHROME_PATH ??
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

const DIST = process.argv[2] ?? "E:/SnakeGame/web/dist";
const PORT = 5199;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".map": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
};

const DEVICES = [
  { name: "desktop 1920x1080", w: 1920, h: 1080, dpr: 1, touch: false },
  { name: "iPad landscape",    w: 1180, h: 820,  dpr: 2, touch: true },
  { name: "iPhone landscape",  w: 852,  h: 393,  dpr: 3, touch: true },
];

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

let failures = 0;
const ok = (m) => console.log(`  [ok]   ${m}`);
const bad = (m) => { failures++; console.log(`  [FAIL] ${m}`); };

async function run(browser, dev) {
  console.log(`\n=== ${dev.name} ===`);
  const page = await browser.newPage();
  const errors = [];
  const failed = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("requestfailed", (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));

  await page.setViewport({
    width: dev.w, height: dev.h, deviceScaleFactor: dev.dpr,
    hasTouch: dev.touch, isMobile: dev.touch,
  });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle2", timeout: 30000 });

  // Wait for the game object the entry point exposes.
  const booted = await page.waitForFunction("!!window.game && !!window.game.viewport", { timeout: 15000 })
    .then(() => true).catch(() => false);
  booted ? ok("game booted") : bad("game did not boot within 15s");
  if (!booted) { await page.close(); return; }

  errors.length ? bad(`console errors: ${errors.slice(0, 3).join(" | ")}`) : ok("no console errors");
  failed.length ? bad(`failed requests: ${failed.slice(0, 3).join(" | ")}`) : ok("no failed requests");

  const info = await page.evaluate(() => {
    const c = document.querySelector("#app canvas");
    const g = window.game;
    return {
      hasCanvas: !!c,
      cw: c?.width ?? 0, ch: c?.height ?? 0,
      scale: g.viewport.scale,
      overscanW: g.viewport.overscan.w,
      overscanH: g.viewport.overscan.h,
      scheme: g.input?.scheme ?? "?",
      tablet: g.viewport.isTabletOrLarger,
    };
  });
  info.hasCanvas ? ok(`canvas ${info.cw}x${info.ch}`) : bad("no canvas element");
  ok(`scale ${info.scale.toFixed(3)}  overscan ${info.overscanW.toFixed(0)}x${info.overscanH.toFixed(0)} design`);

  const wantScheme = dev.touch ? (info.tablet ? "offset" : "drag") : "mouse";
  info.scheme === wantScheme
    ? ok(`control scheme "${info.scheme}" matches device class`)
    : bad(`control scheme "${info.scheme}" but expected "${wantScheme}"`);

  // Non-blank frame: sample the screenshot and require real variance.
  const shot = await page.screenshot({ encoding: "base64" });
  const variance = await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });
    const cv = document.createElement("canvas");
    cv.width = Math.min(img.width, 400); cv.height = Math.min(img.height, 400);
    const cx = cv.getContext("2d");
    cx.drawImage(img, 0, 0, cv.width, cv.height);
    const d = cx.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0, s = 0, s2 = 0, colours = new Set();
    for (let i = 0; i < d.length; i += 16) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
      s += v; s2 += v * v; n++;
      colours.add((d[i] >> 3 << 10) | (d[i + 1] >> 3 << 5) | (d[i + 2] >> 3));
    }
    return { std: Math.sqrt(s2 / n - (s / n) ** 2), colours: colours.size };
  }, shot);
  variance.std >= 5
    ? ok(`frame is not blank (std ${variance.std.toFixed(1)}, ${variance.colours} colours)`)
    : bad(`frame looks blank (std ${variance.std.toFixed(1)})`);

  // Input: synthetic pointer must move the steering target.
  const before = await page.evaluate(() => ({ x: window.game.pointer.x, y: window.game.pointer.y }));
  if (dev.touch) {
    const t = await page.createCDPSession();
    await t.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: Math.round(dev.w * 0.3), y: Math.round(dev.h * 0.6) }],
    });
    await t.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: Math.round(dev.w * 0.45), y: Math.round(dev.h * 0.4) }],
    });
  } else {
    await page.mouse.move(dev.w * 0.7, dev.h * 0.35);
  }
  await new Promise((r) => setTimeout(r, 220));
  const after = await page.evaluate(() => ({
    x: window.game.pointer.x, y: window.game.pointer.y,
    steering: window.game.input?.steerActive ?? false,
  }));
  const moved = Math.hypot(after.x - before.x, after.y - before.y);
  moved > 20
    ? ok(`${dev.touch ? "touch" : "mouse"} input reached the game (moved ${moved.toFixed(0)} design px)`)
    : bad(`input did not reach the game (moved ${moved.toFixed(1)} px)`);

  // Steering target must resolve to something usable for the snake.
  const steer = await page.evaluate(() =>
    window.game.input ? window.game.input.getSteerTarget(640, 400) : null);
  steer && Number.isFinite(steer.x) && Number.isFinite(steer.y)
    ? ok(`steer target resolves to (${steer.x.toFixed(0)}, ${steer.y.toFixed(0)})`)
    : bad(`steer target unusable: ${JSON.stringify(steer)}`);

  // Sustained frame rate.
  const perf = await page.evaluate(async () => {
    const times = [];
    let last = performance.now();
    await new Promise((done) => {
      let n = 0;
      const loop = () => {
        const now = performance.now();
        times.push(now - last); last = now;
        if (++n >= 120) return done();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const s = times.slice(20).sort((a, b) => a - b);
    return { mean: s.reduce((a, b) => a + b, 0) / s.length, p95: s[Math.floor(s.length * 0.95)] };
  });
  const fps = 1000 / perf.mean;
  perf.p95 < 25
    ? ok(`frame ${perf.mean.toFixed(2)} ms mean / ${perf.p95.toFixed(2)} p95 (~${fps.toFixed(0)} fps)`)
    : bad(`frame too slow: ${perf.mean.toFixed(2)} ms mean / ${perf.p95.toFixed(2)} p95`);

  await page.close();
}

const server = await serve(DIST);
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
try {
  for (const d of DEVICES) await run(browser, d);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
