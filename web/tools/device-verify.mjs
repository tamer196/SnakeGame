/**
 * The on-device gate: `verify.mjs`, but against the game running on a real
 * Android device or emulator instead of headless Chrome on this machine.
 *
 * `verify.mjs` proves the game is correct in a browser we control. This proves
 * the things only the device can answer: that the Android input stack lands
 * where the letterbox maths says it should, that a rotation does not kill the
 * loop, and how much of the screen the system bars are taking. Everything it
 * checks was found by something going wrong on the first emulator run.
 *
 *   node tools/device-verify.mjs
 *   node tools/device-verify.mjs --pkg com.example.app --shots ../captures/mobile
 *   node tools/device-verify.mjs --headroom     # + a resolution sweep, ~1 min more
 *
 * Requires a debuggable build (the Capacitor debug APK is one) and an attached
 * device: `adb devices` must list exactly one.
 *
 * Three traps this harness learned the hard way, all of which look like game
 * bugs and are not:
 *
 *   - The drag anchor recentres at TOUCH_ANCHOR_RECENTRE css px/s by design,
 *     so any dwell between moving the finger and reading the steer angle shows
 *     up as a steering error. Every direction gets a fresh press, sampled at
 *     once.
 *   - `steerActive` is cleared inside `getSteerTarget` (by holdHeading), so
 *     reading the flag before calling it returns the stale value from onMove.
 *     Read it after.
 *   - An emulator presents the host mouse as the pointing device, so
 *     `(pointer: coarse)` is FALSE there and the phone control scheme is never
 *     selected. The scheme is forced for the steering checks, and the detection
 *     is reported separately as a fact about the device, not a failure.
 */

import { launchAndAttach, screencap, setRotation, sleep, adb, displaySize, keepAwake, isLocked } from "./lib/android.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args[a.slice(2)] = next; i++; }
  else args[a.slice(2)] = true;
}

const PKG = args.pkg ?? "com.placeholder.neonserpent";
const ACTIVITY = args.activity ?? ".MainActivity";
const PORT = Number(args.port ?? 9222);
const SHOTS = args.shots ?? null;

let failures = 0;
const notes = [];
const ok = (m) => console.log(`  [ok]   ${m}`);
const bad = (m) => { failures++; console.log(`  [FAIL] ${m}`); };
/** Reported, never fatal: what the harness can measure but cannot judge. */
const note = (m) => { notes.push(m); console.log(`  [note] ${m}`); };
const shot = (name) => { if (SHOTS) { screencap(`${SHOTS}/${name}`); console.log(`  [shot] ${name}`); } };

const devices = adb("devices").stdout.split("\n").slice(1).filter((l) => /\tdevice$/.test(l.trim()));
if (devices.length !== 1) {
  console.log(`RESULT: FAIL (expected exactly one attached device, found ${devices.length})`);
  process.exit(1);
}

// Land in landscape - the orientation the game is authored for - and let the
// display finish turning before launching. Start the app mid-rotation and the
// WebView latches the pre-rotation metrics, which quietly makes every size
// reading below a portrait one.
setRotation(1);
// A sleeping display hides the page, which stops rAF, which freezes game.time -
// and that reads exactly like the rotation crash this harness exists to catch.
const wake = keepAwake();
await sleep(1200);
if (isLocked()) {
  wake();
  console.log(
    "\nRESULT: FAIL (the device is locked) - a lock screen leaves the page hidden, so " +
      "requestAnimationFrame never fires and game.time never moves, which looks exactly " +
      "like a dead game loop. Unlock the phone and re-run; the screen timeout is raised " +
      "for the duration so it will not re-lock.",
  );
  process.exit(1);
}
await sleep(2500);
const { browser, page, release } = await launchAndAttach({
  pkg: PKG,
  activity: ACTIVITY,
  port: PORT,
  ready: () => !!(window.game && window.game.time > 0.5),
});

await page.evaluate(() => {
  window.__errs = [];
  addEventListener("error", (e) =>
    window.__errs.push({ msg: e.message, at: e.error ? String(e.error.stack).split("\n")[1] : null }),
  );
  // Raw client coordinates, captured before the game sees them: the touch check
  // needs to know where the WebView thinks the finger landed, not only where
  // the game concluded it did.
  window.__raw = [];
  addEventListener(
    "pointerdown",
    (e) => window.__raw.push({ type: e.pointerType, cx: +e.clientX.toFixed(2), cy: +e.clientY.toFixed(2) }),
    true,
  );
});

const read = () =>
  page.evaluate(() => ({
    time: +game.time.toFixed(3),
    inner: [innerWidth, innerHeight],
    dpr: devicePixelRatio,
    screen: [screen.width, screen.height],
    vp: {
      sw: game.viewport.screenW, sh: game.viewport.screenH,
      scale: +game.viewport.scale.toFixed(4),
      ox: +game.viewport.offsetX.toFixed(1), oy: +game.viewport.offsetY.toFixed(1),
      pillar: game.viewport.hasPillarbox, letter: game.viewport.hasLetterbox,
    },
    safe: { ...game.viewport.safe },
    errs: window.__errs.length,
  }));

// Everything below assumes a visible, ticking page. Say so plainly rather than
// letting it surface as a dozen unrelated failures.
const live = await page.evaluate(() => ({ vis: document.visibilityState, t: window.game ? game.time : null }));
if (live.vis !== "visible" || !live.t) {
  console.log(
    `
RESULT: FAIL (page is ${live.vis}, game.time ${live.t}) - the game is not running in ` +
      `the foreground. Wake and unlock the device, put the app on screen, and re-run.`,
  );
  await browser.disconnect();
  release();
  wake();
  process.exit(1);
}

// ---------------------------------------------------------------------------
console.log(`\n=== device ===`);
const env = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const g = c.getContext("webgl2") ?? c.getContext("webgl");
  const dbg = g && g.getExtension("WEBGL_debug_renderer_info");
  return {
    ua: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? "?",
    android: navigator.userAgent.match(/Android [\d.]+/)?.[0] ?? "?",
    webgl: g ? g.getParameter(g.VERSION) : "none",
    renderer: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "?",
    coarse: matchMedia("(pointer: coarse)").matches,
    anyCoarse: matchMedia("(any-pointer: coarse)").matches,
    maxTouchPoints: navigator.maxTouchPoints,
    scheme: game.input.scheme,
    rendererRes: game.app.renderer.resolution,
  };
});
console.log(`  ${env.android}, WebView ${env.ua}`);
console.log(`  ${env.webgl} on ${env.renderer}`);
if (env.webgl.startsWith("WebGL 2")) ok("WebGL 2");
else note(`WebGL 1 only - the GLSL ES 3.00 filter sources fall back; a real phone gives WebGL 2`);

// Pointer capability picks the control scheme, so a device that misreports it
// plays differently, not just differently-styled. (It used to decide the bloom
// default too, until the A73 measurement retired that.)
if (env.coarse) ok(`pointer: coarse -> scheme "${env.scheme}"`);
else
  note(
    `pointer: coarse is FALSE (any-pointer: coarse ${env.anyCoarse}, maxTouchPoints ` +
      `${env.maxTouchPoints}) -> scheme "${env.scheme}". Emulators report a fine pointer; ` +
      `on this device the touch scheme is unreachable by detection.`,
  );

// ---------------------------------------------------------------------------
console.log(`\n=== rotation survival ===`);
shot("dv-01-landscape.png");
for (const [label, r] of [["portrait", 0], ["landscape", 1], ["portrait", 0], ["landscape", 1]]) {
  const before = (await read()).time;
  setRotation(r);
  await sleep(2600);
  const now = await read();
  if (now.time - before > 0.5) ok(`-> ${label.padEnd(9)} loop alive (+${(now.time - before).toFixed(2)}s), scale ${now.vp.scale} ox ${now.vp.ox} oy ${now.vp.oy}`);
  else bad(`-> ${label}: LOOP STOPPED (game.time stuck at ${now.time})`);
  const wantPillar = now.inner[0] / now.inner[1] > 1280 / 720;
  if (now.vp.pillar === wantPillar && now.vp.letter !== wantPillar)
    ok(`-> ${label.padEnd(9)} letterboxed the right way (${wantPillar ? "pillarbox" : "letterbox"})`);
  else bad(`-> ${label}: pillar ${now.vp.pillar} letter ${now.vp.letter} for a ${(now.inner[0] / now.inner[1]).toFixed(2)}:1 viewport`);
}
shot("dv-02-after-rotations.png");

// ---------------------------------------------------------------------------
console.log(`\n=== screen budget ===`);
let s = await read();
const full = Math.min(s.screen[0] / 1280, s.screen[1] / 720);
const lostY = s.screen[1] - s.inner[1];
const lostX = s.screen[0] - s.inner[0];
console.log(`  screen ${s.screen[0]}x${s.screen[1]} css @${s.dpr}x, webview ${s.inner[0]}x${s.inner[1]} css`);
console.log(`  safe-area insets in design px: t${s.safe.top.toFixed(0)} r${s.safe.right.toFixed(0)} b${s.safe.bottom.toFixed(0)} l${s.safe.left.toFixed(0)}`);
if (lostX <= 1 && lostY <= 1) ok("edge to edge: nothing between the game and the glass");
else {
  note(
    `${lostY} css px vertically and ${lostX} horizontally go to system chrome ` +
      `(${Math.round(lostY * s.dpr)}x${Math.round(lostX * s.dpr)} device px); scale ${s.vp.scale} ` +
      `where edge-to-edge would be ${full.toFixed(4)} (+${((full / s.vp.scale - 1) * 100).toFixed(1)}%)`,
  );
  // Horizontal chrome in landscape is the display cutout and the navigation
  // bar, which only appear beside the game because the app never declared it
  // handles them. That is a manifest decision, not a layout one.
  if (lostX > 1 && s.safe.left < 1 && s.safe.right < 1)
    note(
      `${lostX} css px sit beside the game with env(safe-area-inset-left/right) both 0 - the ` +
        `window is being letterboxed away from the cutout rather than drawing under it. ` +
        `viewport-fit=cover cannot reach it; it needs layoutInDisplayCutoutMode on the Android side.`,
    );
}


// ---------------------------------------------------------------------------
// The one thing only a device can prove: that a real Android touch, through
// the real input stack, lands where the pillarbox maths says it should.
console.log(`\n=== touch -> design space ===`);
s = await read();
// Where the WebView sits on the physical screen is NOT assumable, and assuming
// it is how this check first reported a 77 px error that was entirely its own:
// a Galaxy A73 in landscape puts 84 css px of display cutout and navigation bar
// BESIDE the game and all 30 px of its vertical chrome at the top, where an
// emulator has no cutout and splits its bars evenly. So solve the device-px ->
// css-px map out of the taps themselves, and then assert only what is actually
// a claim about the game: that the map is the device pixel ratio, and that each
// tap's design coordinate is its client coordinate put through the viewport's
// own pillarbox transform.
const taps = [];
const [DW, DH] = displaySize();
console.log(`  display is ${DW}x${DH} device px in its current rotation`);
for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.3], [0.8, 0.75]]) {
  const dx = Math.round(DW * fx);
  const dy = Math.round(DH * fy);
  await page.evaluate(() => { window.__raw.length = 0; });
  adb("shell", "input", "tap", String(dx), String(dy));
  await sleep(700);
  const got = await page.evaluate(() => ({
    raw: window.__raw[0] ?? null,
    x: game.pointer.x, y: game.pointer.y, touch: game.pointer.touch,
  }));
  if (!got.raw) { bad(`tap ${dx},${dy} never reached the page as a pointer event`); continue; }
  if (got.raw.type !== "touch") bad(`tap ${dx},${dy} arrived as pointerType "${got.raw.type}", not "touch"`);
  if (!got.touch) bad("game.pointer.touch is false after a real touch");
  taps.push({ dx, dy, ...got });
}

if (taps.length >= 2) {
  const a = taps[0];
  const b = taps[taps.length - 1];
  const kx = (b.dx - a.dx) / (b.raw.cx - a.raw.cx);
  const ky = (b.dy - a.dy) / (b.raw.cy - a.raw.cy);
  const ox = a.dx - a.raw.cx * kx;
  const oy = a.dy - a.raw.cy * ky;
  console.log(`  webview sits at ${ox.toFixed(0)},${oy.toFixed(0)} device px on a ${DW}x${DH} display`);
  if (Math.abs(kx / s.dpr - 1) < 0.01 && Math.abs(ky / s.dpr - 1) < 0.01)
    ok(`touch scales by the device pixel ratio (${kx.toFixed(3)}, ${ky.toFixed(3)} vs dpr ${s.dpr})`);
  else bad(`touch scales by ${kx.toFixed(3)}, ${ky.toFixed(3)} but devicePixelRatio is ${s.dpr}`);
}

for (const t of taps) {
  const want = { x: (t.raw.cx - s.vp.ox) / s.vp.scale, y: (t.raw.cy - s.vp.oy) / s.vp.scale };
  const err = Math.hypot(t.x - want.x, t.y - want.y);
  if (err < 1)
    ok(`tap ${t.dx},${t.dy} -> css (${t.raw.cx}, ${t.raw.cy}) -> design (${t.x.toFixed(1)}, ${t.y.toFixed(1)}), ${err.toFixed(2)} px off the pillarbox transform`);
  else
    bad(`tap ${t.dx},${t.dy}: game says design (${t.x.toFixed(1)}, ${t.y.toFixed(1)}), the pillarbox transform of css (${t.raw.cx}, ${t.raw.cy}) says (${want.x.toFixed(1)}, ${want.y.toFixed(1)}) - off by ${err.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
console.log(`\n=== drag steering (real touch, forced scheme) ===`);
await page.evaluate(() => game.switchScene("game", { level: 0 }));
await sleep(2200);
shot("dv-03-gameplay.png");
await page.evaluate(() => { game.input.scheme = "drag"; });

const AX = Math.round(DW * 0.3);
const AY = Math.round(DH * 0.6);
const TRAVEL = Math.round(80 * s.dpr); // 80 css px: well past the 12 px deadzone
for (const [dx, dy, label, want] of [
  [TRAVEL, 0, "right", 0],
  [0, -TRAVEL, "up", -90],
  [-TRAVEL, 0, "left", 180],
  [0, TRAVEL, "down", 90],
  [Math.round(TRAVEL * 0.707), -Math.round(TRAVEL * 0.707), "up-right", -45],
]) {
  adb("shell", "input", "motionevent", "DOWN", String(AX), String(AY));
  await sleep(200);
  adb("shell", "input", "motionevent", "MOVE", String(AX + dx), String(AY + dy));
  const r = await page.evaluate(() => {
    const t = game.input.getSteerTarget(640, 360);
    return t
      ? { active: game.input.steerActive, ang: (Math.atan2(t.y - 360, t.x - 640) * 180) / Math.PI, dist: Math.hypot(t.x - 640, t.y - 360) }
      : { active: game.input.steerActive, ang: null, dist: null };
  });
  adb("shell", "input", "motionevent", "UP", String(AX + dx), String(AY + dy));
  await sleep(240);
  if (r.ang === null) { bad(`steer ${label}: no target (deadzone swallowed a ${TRAVEL}px drag)`); continue; }
  const off = Math.abs(((r.ang - want + 540) % 360) - 180);
  if (off < 6 && r.active) ok(`steer ${label.padEnd(9)} ${r.ang.toFixed(1)} deg (want ${want}), aim distance ${r.dist.toFixed(0)}`);
  else bad(`steer ${label}: ${r.ang.toFixed(1)} deg, want ${want} (off by ${off.toFixed(1)}), steerActive ${r.active}`);
}

// Inside the deadzone the aim must be the HELD heading, and steerActive false.
adb("shell", "input", "motionevent", "DOWN", String(AX), String(AY));
await sleep(200);
adb("shell", "input", "motionevent", "MOVE", String(AX + Math.round(8 * s.dpr)), String(AY));
const dz = await page.evaluate(() => {
  game.input.getSteerTarget(640, 360);
  return { active: game.input.steerActive };
});
adb("shell", "input", "motionevent", "UP", String(AX), String(AY));
await sleep(240);
if (!dz.active) ok("an 8 css px nudge stays inside the deadzone (holds heading)");
else bad("an 8 css px nudge steered - the deadzone is not holding");

// Boost is a second simultaneous finger. `adb input` injects gestures one at a
// time, so this goes in as WebView touch points: the Android stack is proven
// above, what is under test here is the game's two-finger rule.
const cdp = await page.createCDPSession();
// CDP touch points are css px inside the page, so they need no screen geometry
// at all - place them relative to the viewport directly.
const P1 = { x: s.inner[0] * 0.3, y: s.inner[1] * 0.6, id: 1 };
const P2 = { x: s.inner[0] * 0.7, y: s.inner[1] * 0.3, id: 2 };
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [P1] });
await sleep(180);
const b1 = await page.evaluate(() => game.input.boost);
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [P1, P2] });
await sleep(180);
const b2 = await page.evaluate(() => game.input.boost);
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [P1] });
await sleep(180);
const b3 = await page.evaluate(() => game.input.boost);
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await sleep(180);
if (!b1 && b2 && !b3) ok("boost follows the second finger (off, on, off)");
else bad(`boost sequence was ${b1}, ${b2}, ${b3} - expected false, true, false`);
await cdp.detach();

// ---------------------------------------------------------------------------
// Frame rate, and whether this device can say anything about it at all. A
// device that returns the same rate at a quarter of the pixels is not
// fill-bound, so its numbers carry no information about the resolution cap or
// the bloom default - which is exactly the trap an emulator sets.
console.log(`\n=== frame rate ===`);
const measure = async (ms = 3500) =>
  page.evaluate(async (dur) => {
    await new Promise((r) => setTimeout(r, 350));
    const t0 = performance.now();
    const g0 = game.time;
    const gaps = [];
    let last = t0;
    let frames = 0;
    await new Promise((res) => {
      const step = () => {
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        frames++;
        if (now - t0 < dur) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });
    const wall = (performance.now() - t0) / 1000;
    gaps.sort((a, b) => a - b);
    return {
      fps: +(frames / wall).toFixed(1),
      p50: +gaps[Math.floor(gaps.length * 0.5)].toFixed(1),
      p95: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1),
      sim: +((game.time - g0) / wall).toFixed(3),
      mpx: +((game.app.canvas.width * game.app.canvas.height) / 1e6).toFixed(2),
    };
  }, ms);

const setRes = (r) =>
  page.evaluate((res) => {
    if (game.app.renderer.resolution !== res) game.app.renderer.resize(innerWidth, innerHeight, res);
  }, r);

// Interleaved and repeated. A single A-then-B pair on an emulator has a spread
// wide enough to invent a fill-cost difference that is not there: three
// consecutive runs of the identical 4x pixel cut read +7%, +38% and +11%.
const runs = { shipped: [], quarter: [] };
for (let i = 0; i < 2; i++) {
  await setRes(env.rendererRes);
  await sleep(600);
  runs.shipped.push(await measure(2500));
  await setRes(1);
  await sleep(600);
  runs.quarter.push(await measure(2500));
}
await setRes(env.rendererRes);
const best = (rs) => rs.reduce((a, b) => (a.fps > b.fps ? a : b));
const shipped = best(runs.shipped);
const quarter = best(runs.quarter);
const spread = (rs) => rs.map((r) => r.fps.toFixed(1)).join(" / ");
console.log(`  as shipped (resolution ${env.rendererRes}): ${spread(runs.shipped)} fps, p95 ${shipped.p95} ms, ${shipped.mpx} Mpx, sim ${shipped.sim}x realtime`);
console.log(`  at resolution 1:              ${spread(runs.quarter)} fps, p95 ${quarter.p95} ms, ${quarter.mpx} Mpx`);

const gain = quarter.fps / shipped.fps - 1;
const noisy =
  runs.shipped.some((r) => Math.abs(r.fps / shipped.fps - 1) > 0.15) ||
  runs.quarter.some((r) => Math.abs(r.fps / quarter.fps - 1) > 0.15);
// Two very different reasons a pixel cut can change nothing, and they point
// opposite ways. Pinned at the panel's refresh rate in both configs means there
// is headroom and `--headroom` can go and size it. The same rate well BELOW the
// refresh rate means something other than pixels is the ceiling - an emulator's
// per-call overhead - and the run carries no information about fill cost at all.
const capped = shipped.fps > 55 && quarter.fps > 55;
if (noisy) {
  note(
    `identical samples differed by more than 15% - this device is too noisy to attribute ` +
      `anything to fill cost. Do not relax the resolution cap on it.`,
  );
} else if (capped) {
  ok(`vsync-capped at ${shipped.fps} fps in both configs, so there is headroom above the shipped settings`);
  if (!args.headroom) note(`re-run with --headroom to find where 60 fps actually breaks and size that margin`);
} else if (Math.abs(gain) < 0.12) {
  note(
    `a ${(shipped.mpx / quarter.mpx).toFixed(1)}x pixel cut moved the frame rate by ` +
      `${(gain * 100).toFixed(0)}% while never reaching the refresh rate - this device is ` +
      `bound by something other than pixels, so it can say nothing about the resolution ` +
      `cap. Do not relax it on this evidence.`,
  );
} else {
  note(`resolution 1 is ${(gain * 100).toFixed(0)}% faster than resolution ${env.rendererRes} - fill cost is real here`);
}
if (shipped.sim < 0.95) note(`sim ran at ${shipped.sim}x realtime: frames past MAX_DT (50 ms) show as slow motion, not skipped time`);

// ---------------------------------------------------------------------------
// Optional, because it takes a minute and pushes the GPU hard: raise the
// renderer resolution with every post pass on until 60 fps breaks. The break
// point IS the margin, and it is the only honest basis for moving a shipping
// default. On a Galaxy A73 5G it held 60 fps to 4.73 Mpx and broke by 7.4 -
// four times what the game actually spends - which is what retired the
// bloom-off-on-touch default and raised the resolution cap from 2 to 3.
if (args.headroom) {
  console.log(`\n=== headroom (every post pass on, bloom 1.25) ===`);
  const ALL = { vignette: true, scanlines: true, aberration: true, curvature: true, grain: true, flare: true, bloom: 1.25 };
  // Capture the STRENGTH, not just the on/off. `setPostFlags({bloom: true})`
  // sets `bloomEnabled` and leaves `bloomStrength` alone, so restoring with a
  // boolean would leave the app running the sweep's 1.25 gain instead of the
  // shipped 0.72 until the next launch.
  const before = await page.evaluate(() => ({
    bloom: game.post.fx.bloomEnabled ? game.post.fx.bloomStrength : false,
    res: game.app.renderer.resolution,
  }));
  console.log("  resolution    Mpx    fps   p50ms  p95ms");
  let broke = null;
  for (const res of [2, +s.dpr.toFixed(4), 3.5, 4, 5, 6]) {
    await page.evaluate(
      (f, r) => {
        game.post.fx.setPostFlags(f);
        if (game.app.renderer.resolution !== r) game.app.renderer.resize(innerWidth, innerHeight, r);
      },
      ALL, res,
    );
    await sleep(900);
    const r = await measure(3200);
    if (r.fps < 55 && broke === null) broke = { res, mpx: r.mpx };
    console.log(
      `  ${String(res).padEnd(10)} ${String(r.mpx).padStart(6)} ${String(r.fps).padStart(6)} ` +
        `${String(r.p50 ?? "-").padStart(7)} ${String(r.p95).padStart(6)}${r.fps < 55 ? "  <- below 60" : ""}`,
    );
  }
  if (broke) note(`60 fps survives the whole post chain up to just under ${broke.mpx} Mpx (broke at resolution ${broke.res})`);
  else note(`60 fps survived every resolution tried - the margin is larger than this sweep can reach`);
  await page.evaluate(
    (b) => {
      game.post.fx.setPostFlags({ bloom: b.bloom });
      if (game.app.renderer.resolution !== b.res) game.app.renderer.resize(innerWidth, innerHeight, b.res);
    },
    before,
  );
}

const errs = await page.evaluate(() => window.__errs);
if (errs.length === 0) ok("no uncaught page errors for the whole run");
else bad(`${errs.length} uncaught error(s): ${errs.slice(0, 3).map((e) => e.msg).join(" | ")}`);

await browser.disconnect();
release();
wake();

if (notes.length) console.log(`\n${notes.length} note(s) above are informational, not failures.`);
console.log(`\n${failures === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
