import ultraciteFmt from "ultracite/oxfmt";
import core from "ultracite/oxlint/core";
import { defineConfig } from "vite-plus";

// Vite+ owns lint (oxlint + type-aware type checking) and format (oxfmt) with
// Ultracite's presets; Bun stays the runtime, test runner and package manager.
export default defineConfig({
  fmt: { ...ultraciteFmt },
  lint: {
    extends: [core],
    ignorePatterns: core.ignorePatterns,
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    options: { typeAware: true, typeCheck: true },
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
  },
  staged: {
    "*": "vp check --fix",
  },
});
