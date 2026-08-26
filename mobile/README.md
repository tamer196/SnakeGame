# NEON SERPENT — mobile wrapper

A Capacitor shell around the web build. The game is `web/dist`, verbatim:
vite builds with `base: "./"` so it loads from the WebView's local scheme
unchanged, and the web code already adapts by capability — touch controls by
pointer class, QUIT absent because no shell bridge exists here (mobile apps do
not quit from a button). No plugins, no user-agent branching.

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

So on an emulator the two shipping guesses stay guesses. They were settled on a
phone instead — see below.

## What a real phone said

Galaxy A73 5G (Snapdragon 778G / Adreno 642L, Android 16, WebView 151, 60 Hz),
`verify:device` PASS: WebGL 2, `pointer: coarse` true so the drag scheme engages
by detection, four rotations with the loop alive, real taps landing within
**0.06 design px** of the pillarbox transform, steering exact to **0.0°**.

`--headroom` then pushed the renderer resolution with every post pass on and
bloom at 1.25:

| resolution | Mpx | fps |
|---|---|---|
| 2 | 1.18 | 60.3 |
| 2.8125 (native) | 2.34 | 59.9 |
| 3.5 | 3.62 | 60.2 |
| **4** | **4.73** | **60.2** |
| 5 | 7.39 | 41.8 |
| 6 | 10.64 | 27.4 |

60 fps survives the whole chain to ~4.7 Mpx and breaks by 7.4 — **four times
what the game was actually spending** — with `p50` pinned at 16.4 ms (vsync)
right up to the break, and no thermal decay over a sustained minute.

So both guesses are retired. **Bloom now defaults ON everywhere** (the
coarse-pointer special case is gone) and the **renderer resolution cap moves
from 2 to 3**, which lets this phone render at its native 2.8125. Both remain
player-toggleable, and the quality presets are still there for something
slower.

The caveat that stands: this is **one** device, a 2022 upper-mid-range on a
60 Hz panel. A budget phone could be 3–5× slower and eat the whole margin; a
120 Hz panel needs double the throughput for the same smoothness. Run
`verify:device --headroom` on the cheapest phone you can find before treating
these as settled for the fleet.

## What this wrapper does that the web build cannot

Three things the page has no way to do for itself, all found by running on a
phone, all in `AndroidManifest.xml` and `MainActivity.java`:

- **`android:screenOrientation="sensorLandscape"`.** The game is authored in a
  1280×720 landscape space. Free-rotating, it booted into portrait and the
  player met the page's ROTATE YOUR DEVICE card instead of the game. The page
  keeps that card, because in a mobile browser it is the only option.
- **Hiding the system bars** — `setDecorFitsSystemWindows(false)` plus
  `WindowInsetsControllerCompat.hide`, with `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`
  so a swipe still reaches navigation, re-applied in `onWindowFocusChanged` or
  the notification shade quietly costs it back.
- **`LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES`.** Distinct from the above and
  easy to conflate. Without it the window is *letterboxed away* from the display
  cutout rather than drawing under it, so `env(safe-area-inset-*)` reports 0 on a
  phone that visibly has a notch — `viewport-fit=cover` cannot help, because the
  window never reaches the cutout in the first place.

Together those took the WebView from 770×354 to 853×384 css and the game's
scale from 0.4917 to 0.5333 — **+8.5%** — on the A73, where in landscape the
cutout and the 3-button nav bar sit *beside* the game rather than above and
below it.

That makes the safe-area insets real, and `Viewport.resize` treats them as
load-bearing: the 1280×720 box is fitted inside the **safe rect**, not the raw
screen. On a 19.5:9 phone the pillarbox bars happen to be wide enough to swallow
the cutout anyway; on a 16:9 one the fit is height-limited, there are no bars,
and the cutout would land squarely on the HUD. `overscan` is still the whole
screen, so backgrounds and the post chain keep painting under it.

The page also teaches the right controls now: `HelpScene` and level 1's hint
both pick on `game.input.scheme`, so a phone player is no longer told to hold
the right mouse button.

## Open item

`appId` in `capacitor.config.ts` is `com.placeholder.neonserpent` — a
**placeholder**, same open decision as `desktop/`'s electron-builder appId.
Pick the real identifier before any store upload; it cannot change afterwards.
