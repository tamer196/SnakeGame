/**
 * Boot the built web game in a real browser and prove it renders.
 *
 * Checks, in order:
 *   - the page loads with no console errors and no failed requests
 *   - a WebGL canvas exists and is sized to the viewport
 *   - the frame is not blank (pixel variance, same idea as screenshot.py)
 *   - synthetic touch input reaches the game and moves the steering target
 *   - sustained fill cost over a measured window, per megapixel
 * Run at several viewport sizes, including a phone and an iPad.
 *
 * WebGL here is SwiftShader, a software rasteriser, so absolute frame times are
 * a property of this machine and not of any device in the list. The perf check
 * is normalised per megapixel for that reason - see the comment at the check.
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
/** Reported, never fatal: things the harness can measure but cannot judge. */
const notes = [];
const note = (m) => { notes.push(m); console.log(`  [note] ${m}`); };

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
  // Judged per megapixel, not per frame.
  //
  // This browser runs WebGL on SwiftShader (see the launch args), so an
  // absolute frame time here is a fact about a software rasteriser on the build
  // machine, not about the phone in the device list. It scales with the pixel
  // count and nothing else: the three profiles differ by 1.9x in area and came
  // out at 8.05 / 8.03 / 7.93 ms per megapixel, which is the renderer's real
  // signature. Asserting on that number catches a regression in what we
  // control - a new full-screen pass, a filter that lost its cache - and does
  // not fail merely because a profile is 4 Mpx.
  //
  // A profile pinned at the 60 Hz requestAnimationFrame cap is not saturated,
  // so its cost per megapixel is an upper bound; it is marked with "<=".
  const fps = 1000 / perf.mean;
  const mpx = (info.cw * info.ch) / 1e6;
  const capped = perf.mean < 17.0;
  const perMpx = perf.mean / mpx;
  const shown = `${capped ? "<=" : ""}${perMpx.toFixed(2)} ms/Mpx`;
  // A capped profile always passes: its mean is the vsync floor, so per-Mpx is
  // an upper bound, not a measurement - dividing 16.67 ms by a small canvas
  // says nothing about fill cost. (Dropping the phone resolution cap from 3 to
  // 2 made the iPhone profile vsync-locked and tripped exactly this.)
  capped || perMpx < 12
    ? ok(`frame ${perf.mean.toFixed(2)} ms mean / ${perf.p95.toFixed(2)} p95 ` +
         `(~${fps.toFixed(0)} fps, ${mpx.toFixed(2)} Mpx, ${shown}, software GL)`)
    : bad(`fill cost regressed: ${shown} over ${mpx.toFixed(2)} Mpx ` +
          `(${perf.mean.toFixed(2)} ms mean / ${perf.p95.toFixed(2)} p95)`);
  // Real-device frame rate is not knowable from here; say so rather than imply
  // a pass means the game holds 60 fps on an iPad.
  if (!capped) {
    note(`${dev.name}: ${fps.toFixed(0)} fps in software GL at ${mpx.toFixed(2)} Mpx ` +
         `- indicative only, real GPU perf needs a real device`);
  }

  await page.close();
}

/**
 * Scene instances are cached and reused, so `onEnter` must reset every piece
 * of state the scene owns - the documented #1 bug source in this design, and
 * one that no screenshot catches because the leak only shows on the *second*
 * visit. So: enter a scene, poison its animation state the way a real visit
 * would, leave, come back, and require the zero state.
 *
 * Property-based rather than field-listed on purpose: it asserts the numbers
 * a leak would move, not an inventory that would rot as scenes change.
 */
async function checkSceneReuse(browser) {
  console.log(`\n=== scene reuse (cached instances must reset) ===`);
  const page = await browser.newPage();
  page.on("pageerror", (e) => bad(`page error during reuse check: ${e}`));
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle2", timeout: 30000 });
  const booted = await page
    .waitForFunction("!!window.game && !!window.game.viewport", { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!booted) {
    bad("game did not boot for the reuse check");
    await page.close();
    return;
  }

  // Snapshot every own numeric field of the live scene. Field NAMES are
  // meaningless in a minified build, but their VALUES still move, and that is
  // all this needs: the animation state is whatever changed between an early
  // frame and a settled one.
  const snapshot = async (key, args, settleMs) => {
    await page.evaluate(
      (k, a) => {
        window.game.lastResult = {
          score: 486, levelIndex: 3, levelName: "Solar Flare", foodEaten: 14,
          goalFood: 14, stars: 3, newBest: true, won: true, elapsed: 48.9,
          maxCombo: 8, deaths: 0, mode: "free", story: false, nextIndex: 4,
          finalLevel: false, difficulty: "normal",
        };
        window.game.switchScene(k, a ?? undefined);
      },
      key,
      args ?? null,
    );
    await new Promise((r) => setTimeout(r, settleMs));
    return page.evaluate(() => {
      const s = window.game.scene;
      const out = {};
      for (const k of Object.keys(s)) {
        const v = s[k];
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
        else if (typeof v === "boolean") out[k] = v ? 1 : 0;
      }
      return out;
    });
  };

  const SCENES = [
    ["victory", null],
    ["gameover", null],
    ["settings", { back: "menu" }],
    ["menu", null],
    ["levels", null],
    ["mode", null],
    ["help", null],
  ];
  const registered = await page.evaluate(() => window.game.registeredScenes());

  for (const [key, args] of SCENES) {
    if (!registered.includes(key)) continue;
    const fresh = await snapshot(key, args, 90);
    const settled = await snapshot(key, args, 2200);
    // A second settled reading, so a field's own ongoing wobble can be told
    // from the distance it travelled. Without this, a sawtooth like the
    // preview well's grain phase is a coin flip and the check goes flaky.
    const jitter = await page.evaluate(() => {
      const s = window.game.scene;
      const out = {};
      for (const k of Object.keys(s)) {
        const v = s[k];
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
        else if (typeof v === "boolean") out[k] = v ? 1 : 0;
      }
      return out;
    });
    await new Promise((r) => setTimeout(r, 150));
    const jitter2 = await page.evaluate(() => {
      const s = window.game.scene;
      const out = {};
      for (const k of Object.keys(s)) {
        const v = s[k];
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
        else if (typeof v === "boolean") out[k] = v ? 1 : 0;
      }
      return out;
    });
    await page.evaluate(() => window.game.switchScene("menu"));
    await new Promise((r) => setTimeout(r, 150));
    const reentry = await snapshot(key, args, 90);

    // Only fields that actually moved while the scene played are animation
    // state; anything identical in both (levelIndex, goalFood, ...) is
    // parsed-per-entry data and says nothing about resetting.
    //
    // Two filters keep this from flapping. A field must out-travel its own
    // ongoing wobble, and it must have moved by at least 1 - which excludes
    // the fractional accumulators (the confetti emitter's fill level, the
    // grain phase) whose value is a sawtooth in [0, 1) and therefore
    // meaningless to compare against a single sample. That is not a fudge: a
    // leaked accumulator costs one particle's timing, while the leaks worth
    // failing a build over - scene clocks, counters, flags, card indices -
    // all travel by 1 or more.
    const animated = Object.keys(fresh).filter((k) => {
      if (!(k in settled)) return false;
      const moved = Math.abs(settled[k] - fresh[k]);
      if (moved < 1) return false;
      const wobble = Math.abs((jitter2[k] ?? settled[k]) - (jitter[k] ?? settled[k]));
      return moved > 5 * wobble;
    });
    if (animated.length === 0) {
      note(`${key}: nothing animates over 2 s, so there is no reset to prove`);
      continue;
    }
    // Self-calibrating, per field: a reset scene is nearer its fresh value
    // than its settled one. No tuned threshold anywhere.
    const stale = animated.filter((k) => {
      if (!(k in reentry)) return false;
      return Math.abs(reentry[k] - fresh[k]) > Math.abs(reentry[k] - settled[k]);
    });
    stale.length === 0
      ? ok(`${key}: reused instance replays from the start (${animated.length} animated field(s) reset)`)
      : bad(
          `${key}: state survived re-entry - ` +
            stale
              .map((k) => `${k} ${reentry[k].toFixed(2)} (fresh ${fresh[k].toFixed(2)}, settled ${settled[k].toFixed(2)})`)
              .join("; "),
        );
  }
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
  await checkSceneReuse(browser);
} finally {
  await browser.close();
  server.close();
}

if (notes.length) console.log(`\n${notes.length} note(s) above are informational, not failures.`);
console.log(`\n${failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
