import { defineConfig } from "vitest/config";

// Tauri expects a fixed dev port and reads the built files from dist/.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  worker: { format: "es" },
  build: {
    target: "es2022",
    outDir: "dist",
    // Source maps for browser builds; the desktop app (built by Tauri, which
    // sets TAURI_ENV_PLATFORM) ships without them to stay small.
    sourcemap: !process.env.TAURI_ENV_PLATFORM,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
