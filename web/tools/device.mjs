/**
 * On-device harness: the mobile counterpart to `shot.mjs`.
 *
 * `shot.mjs` boots the game in headless Chrome and evaluates JS in it. This
 * does the same to the game already running inside the Capacitor WebView on an
 * attached Android device or emulator, so the numbers come from the real
 * WebView, the real GPU path and the real screen metrics rather than from a
 * desktop browser told to pretend.
 *
 * Deliberately thin - two capabilities and nothing else:
 *
 *   --eval <js>   run JS in the page and print what it returns as JSON.
 *                 `game`, `save`, `sound` and `story` are in scope exactly as
 *                 in shot.mjs, because main.ts puts them on `window`.
 *   --shot <png>  write a device screengrab. This goes through `adb screencap`,
 *                 NOT the WebView, on purpose: a WebView capture shows only the
 *                 page, and on mobile the letterbox bars and the system insets
 *                 around it are most of the question.
 *
 * Touch is not simulated here. `adb shell input tap/swipe/motionevent` drives
 * the real Android input stack, which is the thing worth testing; synthesising
 * a PointerEvent inside the page would skip everything that can actually go
 * wrong. `device-verify.mjs` does that, and is the gate.
 *
 * Requires a debuggable build - the debug APK is one, which is what exposes
 * the CDP socket.
 *
 *   node tools/device.mjs --eval "game.scene"
 *   node tools/device.mjs --eval "({s: game.input.scheme})" --shot dev.png
 */

import { adb, findSocket, screencap } from "./lib/android.mjs";
import puppeteer from "puppeteer-core";

const PORT = Number(process.env.DEVTOOLS_PORT ?? 9222);

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args[a.slice(2)] = next; i++; }
  else args[a.slice(2)] = true;
}

const pkg = args.pkg ?? "com.placeholder.neonserpent";
const socket = findSocket(pkg);
if (!socket) {
  console.error(
    `no webview_devtools_remote socket found for ${pkg}. ` +
      `Is the app running, and is this a debuggable build?`,
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
      new Function(`return (async () => { return (${args.eval}); })();`),
    );
    console.log(JSON.stringify(value, null, 2));
  }

  if (typeof args.shot === "string") {
    screencap(args.shot);
    console.error(`wrote ${args.shot}`);
  }
} finally {
  if (browser) await browser.disconnect();
  adb("forward", "--remove", `tcp:${PORT}`);
}
