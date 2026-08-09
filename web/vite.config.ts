import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  // Relative base so the same build works from a web server, from a
  // Capacitor WebView (capacitor:// scheme) and from Electron (file://).
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    // The game is one bundle plus PixiJS; splitting buys nothing and costs a
    // round trip on a mobile connection, where cold start is what matters.
    rollupOptions: {
      output: {
        manualChunks: {
          pixi: ["pixi.js"],
        },
      },
    },
  },
  server: {
    host: true, // expose on the LAN so a real phone can load it
    port: 5173,
  },
});
