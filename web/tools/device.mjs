/**
 * On-device harness: the mobile counterpart to `shot.mjs`.
 *
 * `shot.mjs` boots the game in headless Chrome and evaluates JS in it. This
 * does the same thing to the game already running inside the Capacitor
 * WebView on an attached Android device or emulator, so the numbers come from
 * the real WebView, the real GPU path and the real screen metrics rather than
 * from a desktop browser told to pretend.
 *
 * It is deliberately thin. Two capabilities, and nothing else:
 *
 *   --eval <js>   run JS in the page and print what it returns as JSON.
 *                 `game`, `save`, `sound` and `story` are in scope exactly as
 *                 in shot.mjs, because main.ts puts them on `window`.
 *   --shot <png>  write a device screengrab. This goes through `adb screencap`,
 *                 NOT the WebView, on purpose: a WebView capture shows only
 *                 the page, and the whole point on mobile is to see the
 *                 letterbox bars, the status bar and the system insets around
 *                 it.
 *
 * Touch is not simulated here. `adb shell input tap/swipe/motionevent` drives
 * the real Android input stack, which is the thing worth testing; synthesising
 * a PointerEvent inside the page would skip everything that can actually go
 * wrong (hit-test offsets, the WebView's own touch-slop, insets).
 *
 * Requires a debuggable build (the debug APK is one) - Capacitor enables
 * WebView contents debugging there, which is what exposes the CDP socket.
 *
 *   node tools/device.mjs --eval "game.scene"
 *   node tools/device.mjs --eval "({s: game.input.scheme})" --shot dev.png
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const ADB =
  process.env.ADB_PATH ??
  `${process.env.LOCALAPPDATA}/Android/Sdk/platform-tools/adb.exe`;
const PORT = Number(process.env.DEVTOOLS_PORT ?? 9222);

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args[key] = next;
    i++;
  } else {
    args[key] = true;
  }
}

function adb(...rest) {
  const r = spawnSync(ADB, rest, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.error) throw r.error;
  return r;
}

function adbBinary(...rest) {
  const r = spawnSync(ADB, rest, { maxBuffer: 1 << 28 });
  if (r.error) throw r.error;
  return r.stdout;
}

/**
 * Find the WebView's devtools socket.
 *
 * Android exposes it as an abstract unix socket named
 * `webview_devtools_remote_<pid>`, listed in /proc/net/unix with a leading NUL
 * that prints as `@`. There is one per debuggable WebView process, so when
 * several apps are debuggable the name alone is ambiguous - we take the pid of
 * our own package and match on it.
 */
function findSocket(pkg) {
  const pids = adb("shell", `pidof ${pkg}`).stdout.trim().split(/\s+/).filter(Boolean);
  const unix = adb("shell", "cat /proc/net/unix").stdout;
  const names = [...unix.matchAll(/@(webview_devtools_remote_\d+)/g)].map((m) => m[1]);
  if (names.length === 0) return null;
  for (const pid of pids) {
    const hit = names.find((n) => n.endsWith(`_${pid}`));
    if (hit) return hit;
  }
  // Single candidate and no pid match: the WebView may run in its own process.
  return names.length === 1 ? names[0] : null;
}

const pkg = args.pkg ?? "com.placeholder.neonserpent";

const socket = findSocket(pkg);
if (!socket) {
  console.error(
    `no webview_devtools_remote socket found for ${pkg}. ` +
      `Is the app running, and is this a debuggable build?`
  );
  process.exit(1);
}

adb("forward", `tcp:${PORT}`, `localabstract:${socket}`);

let browser;
try {
  browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${PORT}`,
    defaultViewport: null,
  });

  const pages = await browser.pages();
  const page = pages.find((p) => !p.url().startsWith("devtools://")) ?? pages[0];
  if (!page) {
    console.error("connected, but the WebView exposes no page target");
    process.exit(1);
  }

  if (args.eval) {
    const value = await page.evaluate(
      // eslint-disable-next-line no-new-func
      new Function(`return (async () => { return (${args.eval}); })();`)
    );
    console.log(JSON.stringify(value, null, 2));
  }

  if (typeof args.shot === "string") {
    writeFileSync(args.shot, adbBinary("exec-out", "screencap", "-p"));
    console.error(`wrote ${args.shot}`);
  }
} finally {
  if (browser) await browser.disconnect();
  adb("forward", "--remove", `tcp:${PORT}`);
}
