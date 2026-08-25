/**
 * Talking to an attached Android device, and to the game running inside it.
 *
 * Shared by `device.mjs` (one-shot eval / screengrab) and `device-verify.mjs`
 * (the on-device gate). Nothing here knows anything about NEON SERPENT.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

export const ADB =
  process.env.ADB_PATH ??
  `${process.env.LOCALAPPDATA}/Android/Sdk/platform-tools/adb.exe`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function adb(...args) {
  const r = spawnSync(ADB, args, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.error) throw r.error;
  return r;
}

export function adbBinary(...args) {
  const r = spawnSync(ADB, args, { maxBuffer: 1 << 28 });
  if (r.error) throw r.error;
  return r.stdout;
}

/** Whole-screen grab. Not a WebView capture - the letterbox bars are the point. */
export function screencap(path) {
  writeFileSync(path, adbBinary("exec-out", "screencap", "-p"));
}

/**
 * Find the WebView's devtools socket for a package.
 *
 * Android publishes it as an abstract unix socket named
 * `webview_devtools_remote_<pid>`, which shows up in /proc/net/unix with a
 * leading NUL printed as `@`. There is one per debuggable WebView process, so
 * the name alone is ambiguous when several apps are debuggable - match on the
 * pid of the package we actually want.
 */
export function findSocket(pkg) {
  const pids = adb("shell", `pidof ${pkg}`).stdout.trim().split(/\s+/).filter(Boolean);
  const names = [
    ...adb("shell", "cat /proc/net/unix").stdout.matchAll(/@(webview_devtools_remote_\d+)/g),
  ].map((m) => m[1]);
  if (names.length === 0) return null;
  for (const pid of pids) {
    const hit = names.find((n) => n.endsWith(`_${pid}`));
    if (hit) return hit;
  }
  // A WebView in its own process will not match the app pid; accept a lone one.
  return names.length === 1 ? names[0] : null;
}

/** Force-stop, relaunch, and attach to the page. Resolves once `ready` is true. */
export async function launchAndAttach({ pkg, activity, port, ready, timeoutMs = 45000 }) {
  adb("shell", "am", "force-stop", pkg);
  await sleep(1200);
  adb("shell", "am", "start", "-n", `${pkg}/${activity}`);

  let socket = null;
  const deadline = Date.now() + timeoutMs;
  while (!socket && Date.now() < deadline) {
    await sleep(1000);
    socket = findSocket(pkg);
  }
  if (!socket) throw new Error(`no devtools socket for ${pkg} - is this a debuggable build?`);

  adb("forward", `tcp:${port}`, `localabstract:${socket}`);
  await sleep(400);
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${port}`,
    defaultViewport: null,
  });
  const pages = await browser.pages();
  const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
  if (!page) throw new Error("connected, but the WebView exposes no page target");

  if (ready) {
    while (Date.now() < deadline) {
      if (await page.evaluate(ready).catch(() => false)) break;
      await sleep(700);
    }
  }
  return { browser, page, release: () => adb("forward", "--remove", `tcp:${port}`) };
}

/** Lock rotation and set it. 0 = natural (portrait on a phone), 1 = landscape. */
export function setRotation(r) {
  adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
  adb("shell", "settings", "put", "system", "user_rotation", String(r));
}

/**
 * The display's size in device px **in its current rotation**.
 *
 * Not `screen.width/height` from the page: those follow the rotation on an
 * emulator but revert to the natural orientation on a real phone whose display
 * has slept, so coordinates derived from them get injected into portrait space
 * on a landscape screen and land outside the window. `wm size` reports the
 * physical (natural) size for the same reason; `dumpsys window displays` is the
 * one that carries the rotated `cur=`.
 */
export function displaySize() {
  const cur = adb("shell", "dumpsys", "window", "displays").stdout.match(/cur=(\d+)x(\d+)/);
  if (cur) return [Number(cur[1]), Number(cur[2])];
  const phys = adb("shell", "wm", "size").stdout.match(/(\d+)x(\d+)/);
  return phys ? [Number(phys[1]), Number(phys[2])] : null;
}

/**
 * Wake the screen and hold it awake for the run.
 *
 * A sleeping display does not merely make screengrabs black: it sets the page
 * to `visibilityState: "hidden"`, which stops requestAnimationFrame, which
 * freezes `game.time` - indistinguishable from the rotation crash this harness
 * exists to catch unless you check. Returns a restore function; call it.
 */
export function keepAwake() {
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  adb("shell", "wm", "dismiss-keyguard");
  adb("shell", "svc", "power", "stayon", "true");
  // `stayon` only helps while the device counts as charging, and a 30 s screen
  // timeout will re-lock the phone in the middle of a run, so raise it too and
  // put it back afterwards.
  const previous = adb("shell", "settings", "get", "system", "screen_off_timeout").stdout.trim();
  adb("shell", "settings", "put", "system", "screen_off_timeout", "900000");
  return () => {
    adb("shell", "svc", "power", "stayon", "false");
    if (/^\d+$/.test(previous)) {
      adb("shell", "settings", "put", "system", "screen_off_timeout", previous);
    }
  };
}

/**
 * Is a lock screen in front of the app?
 *
 * This matters more than it sounds. A locked phone still reports the screen on,
 * awake, and the app as the top activity of its task - but the page is
 * `visibilityState: "hidden"`, so requestAnimationFrame never fires and
 * `game.time` never moves. That is indistinguishable from the rotation crash
 * unless you look. `wm dismiss-keyguard` cannot pass a PIN or pattern, so the
 * only fix is a human unlocking the device.
 */
export function isLocked() {
  const w = adb("shell", "dumpsys", "window").stdout;
  return /isKeyguardShowing=true/.test(w) || /mDreamingLockscreen=true/.test(w);
}
