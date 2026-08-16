# NEON SERPENT — mobile wrapper

A Capacitor shell around the web build. The game is `web/dist`, verbatim:
vite builds with `base: "./"` so it loads from the WebView's local scheme
unchanged, and the web code already adapts by capability — touch controls by
pointer class, bloom defaulting off on coarse pointers, QUIT absent because
no shell bridge exists here (mobile apps do not quit from a button). No
plugins, no user-agent branching.

## Workflow

```sh
cd web && npm run build        # the wrapper syncs web/dist
cd ../mobile && npm install
npx cap sync android           # copy the fresh bundle into the android project
npx cap open android           # or: npx cap run android
```

The `android/` project is generated (`npx cap add android`) and committed;
the synced web assets inside it are **not** — they are rebuilt by `cap sync`
and gitignored at the repo root.

## Build requirements (not met on the porting machine — untested on device)

- **JDK 17** (this machine has 11; AGP 8 refuses it)
- **Android SDK platform 34** (this machine has 33)
- No iOS platform has been added yet (`npx cap add ios` needs a Mac).

The port was written with **no mobile test device available**, assuming the
worst (renderer resolution capped at 2, bloom off by default on touch). The
first run on real hardware should check frame rate on a mid-range phone and
revisit both if it holds 60 fps.

## Open item

`appId` in `capacitor.config.ts` is `com.placeholder.neonserpent` — a
**placeholder**, same open decision as `desktop/`'s electron-builder appId.
Pick the real identifier before any store upload; it cannot change afterwards.
