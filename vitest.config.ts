import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    // e2e/ holds STATIC guards over the suite (fixedWaits), not the suite
    // itself: its cases are *.e2e.ts and run under WebdriverIO.
    include: ["src/**/*.test.ts", "e2e/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    // The setup file warms Intl, whose first call cost 19.7s on the Windows
    // runner (see src/test/setup.ts). The default 10s hook ceiling would just
    // move the failure there, so give the one-off room; per-test stays 5s.
    hookTimeout: 40_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
