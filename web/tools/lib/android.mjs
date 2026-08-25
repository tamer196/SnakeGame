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
