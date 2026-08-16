# NEON SERPENT — desktop wrapper

A deliberately thin Electron shell around the web build. The game itself is
`web/dist`; this directory adds one window and one capability a browser tab
cannot offer — a real QUIT. The web code probes `window.neonSerpentShell`
(see `web/src/app/shell.ts`), so the same bundle runs in a tab, in this
wrapper, and in the Capacitor app without branching on user agents.

## Running

```sh
cd web && npm run build       # the wrapper loads web/dist
cd ../desktop && npm install
npm start                     # run windowed
npm run smoke                 # boot invisibly, write smoke.png, exit 0/2
npm run dist                  # package with electron-builder into dist-app/
```

## Open item

`build.appId` is `com.placeholder.neonserpent` — a **placeholder**. Pick a
real bundle identifier (and the matching one for Capacitor) before shipping;
it is baked into installers and cannot change without orphaning user installs.
