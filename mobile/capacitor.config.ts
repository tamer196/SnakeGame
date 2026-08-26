import type { CapacitorConfig } from "@capacitor/cli";

/**
 * NEON SERPENT - the mobile wrapper.
 *
 * The game is the web build, verbatim: `webDir` points at web/dist, which
 * vite already builds with `base: "./"` so it loads from the WebView's local
 * scheme unchanged. The web code detects touch by pointer capability and keeps
 * QUIT off the menu when no shell bridge exists (mobile apps do not quit from
 * a button) - so this wrapper needs no plugins and no branching.
 *
 * `appId` is a PLACEHOLDER - pick the real bundle identifier (shared with
 * desktop/'s electron-builder appId decision) before any store upload; it
 * cannot change afterwards.
 */
const config: CapacitorConfig = {
  appId: "com.placeholder.neonserpent",
  appName: "NEON SERPENT",
  webDir: "../web/dist",
  backgroundColor: "#05070f",
  android: {
    // The game paints its own letterbox; never show a WebView flash.
    backgroundColor: "#05070f",
  },
  ios: {
    // The page opts into the notch with viewport-fit=cover and insets itself
    // via env(safe-area-inset-*); the WebView must not double-inset it.
    contentInset: "never",
    backgroundColor: "#05070f",
  },
};

export default config;
