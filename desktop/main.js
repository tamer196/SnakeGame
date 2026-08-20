/**
 * NEON SERPENT - the Electron desktop wrapper.
 *
 * Deliberately thin: one window, the built web bundle, and a preload that
 * exposes the one capability a browser tab cannot offer - a real quit().
 * Everything else (fullscreen, saves, input) is the web build's own code;
 * the game probes `window.neonSerpentShell` rather than sniffing Electron,
 * so this wrapper and the plain web build ship the same bundle.
 *
 * `npm start` runs against ../web/dist (build the web bundle first);
 * `npm run smoke` boots headless-ish, waits for the game to come up,
 * writes smoke.png and exits 0/2 - CI-friendly proof the wrap works.
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain } = require("electron");

const SMOKE = process.argv.includes("--smoke");

/** The built web bundle: packaged into resources, or ../web/dist in dev. */
function indexHtml() {
  if (app.isPackaged) return path.join(__dirname, "dist", "index.html");
  return path.join(__dirname, "..", "web", "dist", "index.html");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 360,
    backgroundColor: "#05070f",
    autoHideMenuBar: true,
    show: !SMOKE,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The game's own settings row drives fullscreen through the standard
  // Fullscreen API, which Electron maps onto window fullscreen - no IPC
  // needed for it.
  win.loadFile(indexHtml());
  return win;
}

ipcMain.on("shell:quit", () => app.quit());

app.whenReady().then(() => {
  const html = indexHtml();
  if (!fs.existsSync(html)) {
    console.error(`[desktop] web bundle not found at ${html} - run \`npm run build\` in web/ first`);
    app.exit(2);
    return;
  }
  const win = createWindow();

  if (SMOKE) {
    // Boot, give the renderer a moment to draw real frames, then capture.
    const bail = setTimeout(() => {
      console.error("[desktop] smoke: game did not load within 30s");
      app.exit(2);
    }, 30000);
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const probe = await win.webContents.executeJavaScript(
            `({
              booted: !!(window.game && window.game.viewport),
              shell: !!(window.neonSerpentShell && typeof window.neonSerpentShell.quit === "function"),
            })`,
          );
          const image = await win.webContents.capturePage();
          // Inside a packaged build __dirname is the read-only asar; write
          // where the smoke can actually land.
          const out = app.isPackaged
            ? path.join(app.getPath("temp"), "neon-serpent-smoke.png")
            : path.join(__dirname, "smoke.png");
          fs.writeFileSync(out, image.toPNG());
          const size = image.getSize();
          console.log(
            `[desktop] smoke: booted=${probe.booted} shell=${probe.shell} ` +
              `${size.width}x${size.height} -> ${out}`,
          );
          if (!probe.booted || !probe.shell) {
            clearTimeout(bail);
            app.exit(2);
            return;
          }
          // The end-to-end proof: the PAGE asks to quit, and the app obeys.
          // If the IPC path is broken the failsafe turns that into a failure.
          clearTimeout(bail);
          setTimeout(() => {
            console.error("[desktop] smoke: quit() did not close the app");
            app.exit(3);
          }, 5000).unref?.();
          console.log("[desktop] smoke: asking the page to quit()");
          await win.webContents.executeJavaScript("window.neonSerpentShell.quit()");
        } catch (err) {
          console.error("[desktop] smoke failed:", err);
          clearTimeout(bail);
          app.exit(2);
        }
      }, 4000);
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // No macOS lingering-app behaviour: closing the game closes the game.
  app.quit();
});
