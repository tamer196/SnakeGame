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
`android/app/build/outputs/apk/debug/app-debug.apk` (~5.8 MB) carrying
`assets/public/` — index.html plus the game and Pixi chunks.

### Before a release build

The debug APK ships ~4.3 MB of sourcemaps (vite's `sourcemap: true`, which is
deliberate for the web build since there is no device to debug on). Turn them
off for a store build and the payload drops to roughly 1.2 MB.

## Running it: the emulator (done) and the phone (not yet)

Building an APK is not the same as running it, and the first emulator run
proved the point — a device rotation froze the game permanently, because a
filter destroyed a texture that was still bound to it. That bug reproduces in a
desktop browser too (drag a window edge), and `npm run verify` now gates it.

So there is an on-device gate. It needs a debuggable build, one attached device,
and the app installed:

```sh
adb install -r -t android/app/build/outputs/apk/debug/app-debug.apk
cd ../web && npm run verify:device -- --shots ../captures/mobile
```

It reaches the running WebView over CDP (`adb forward` to the WebView's
devtools socket) and checks what only a device can answer: that four rotations
in both directions leave the game loop alive, that each orientation letterboxes
the right way round, that a real Android touch lands where the pillarbox maths
predicts, that drag steering resolves the right heading, and how much screen
the system bars are taking. `web/tools/device.mjs` is the one-shot version —
`shot.mjs` for a device.

### Creating an AVD (Windows)

The legacy `tools/bin/avdmanager.bat` throws `NoClassDefFoundError:
javax/xml/bind/annotation/XmlSchema` on JDK 17, so install modern
cmdline-tools. There is **no `commandlinetools-win-latest.zip`** — Google
publishes versioned names only; list them out of
`https://dl.google.com/android/repository/repository2-3.xml`. The zip's inner
folder is `cmdline-tools`, so its *contents* go in
`%LOCALAPPDATA%/Android/Sdk/cmdline-tools/latest/`.

```sh
echo no | avdmanager create avd -n ns-pixel5 -d pixel_5 \
  -k "system-images;android-33;google_apis;x86_64"
emulator -avd ns-pixel5 -gpu host -no-snapshot-load -no-boot-anim
```

The generated `config.ini` needs editing before it can run a WebGL game:
`hw.gpu.enabled=no` → `yes` with `hw.gpu.mode=host`, and `hw.lcd.depth=16` →
`32` (16-bit would fake colour banding in an additive-blend neon game and send
you hunting a renderer bug that isn't there). It also ships unfilled template
tokens — `avd.id=<build>`, `avd.name=<build>`, `disk.dataPartition.path=<temp>`.

### What an emulator cannot tell you

It answers correctness, not performance, and it misreports one capability that
changes the game rather than just a media query:

- **It is not fill-bound.** Cutting the pixels 4× (renderer resolution 2 → 1)
  moved the frame rate by +7%, +38%, +11% and −5% across four runs of the
  identical change; it sits at 30–35 fps whether every post pass is on or all
  of them are off. So it says nothing about the resolution cap or the bloom
  default. The gate detects this and reports "this proves nothing" rather than
  printing a number that reads like evidence.
- **`(pointer: coarse)` is false** on an emulator, which presents the host mouse
  as the pointing device — even though real touches still arrive as
  `pointerType: "touch"`. So the phone control scheme and the bloom-off default
  are unreachable there by detection. The gate forces the scheme for its
  steering checks and reports the detection separately.
- **WebGL 1 only** on the android-33 image, and its bundled WebView is Chrome
  103. A real phone gives WebGL 2 and a current WebView.

So the two shipping guesses — renderer resolution capped at 2, bloom off by
default on touch — are **still guesses**. Revisit them on a mid-range phone,
where the frame rate means something, and not before.

## Open item

`appId` in `capacitor.config.ts` is `com.placeholder.neonserpent` — a
**placeholder**, same open decision as `desktop/`'s electron-builder appId.
Pick the real identifier before any store upload; it cannot change afterwards.
