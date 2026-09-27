import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    // e2e/ holds STATIC guards over the suite (fixedWaits), not the suite
    // itself: its cases are *.e2e.ts and run under WebdriverIO.
    include: ["src/**/*.test.ts", "e2e/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
