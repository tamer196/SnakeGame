/**
 * The wrapper's whole bridge: one object, one method.
 *
 * `web/src/app/shell.ts` probes for this. Its presence is what makes the
 * menu's QUIT button exist at all - a plain browser tab never sees it.
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("neonSerpentShell", {
  quit: () => ipcRenderer.send("shell:quit"),
});
