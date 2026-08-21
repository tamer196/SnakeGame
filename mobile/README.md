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

## Build requirements

- **JDK 17.** AGP 8.2.1 refuses 11. Gradle picks it up from `JAVA_HOME`:
  ```sh
  JAVA_HOME=~/.jdks/temurin-17 ./gradlew assembleDebug   # from mobile/android
  ```
- **Android SDK**, located by `android/local.properties` (gitignored). Write
  `sdk.dir` with **forward slashes** — a Java properties file treats `\` as an
  escape, so `C:\Users\…` silently parses as `C:Users…` and AGP fails with
  "The filename, directory name, or volume label syntax is incorrect":
  ```properties
  sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk
  ```
  Gradle downloads platform 34 / build-tools 34 itself if the licences are
  already accepted.
- No iOS platform yet (`npx cap add ios` needs a Mac).

`assembleDebug` is **verified working**: it produces
`android/app/build/outputs/apk/debug/app-debug.apk` (~5.5 MB) carrying
`assets/public/` — index.html plus the game and Pixi chunks.

### Before a release build

The debug APK ships ~4.3 MB of sourcemaps (vite's `sourcemap: true`, which is
deliberate for the web build since there is no device to debug on). Turn them
off for a store build and the payload drops to roughly 1.2 MB.

## Untested on real hardware

The port was written with **no mobile test device available**, assuming the
worst (renderer resolution capped at 2, bloom off by default on touch). The
first run on real hardware should check frame rate on a mid-range phone and
revisit both if it holds 60 fps. Building an APK is not the same as running it.

## Open item

`appId` in `capacitor.config.ts` is `com.placeholder.neonserpent` — a
**placeholder**, same open decision as `desktop/`'s electron-builder appId.
Pick the real identifier before any store upload; it cannot change afterwards.
