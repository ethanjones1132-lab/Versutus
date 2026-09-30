// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");
const globals = require("globals");

module.exports = defineConfig([
  expoConfig,
  {
    // `dist/*` is build output. `.claude/**` and `.worktrees/**` are nested git
    // worktrees other agents check out INSIDE this repo: a second copy of every
    // source file, which the gate would otherwise lint, typecheck and run tests
    // from. On 2026-09-16 one such worktree added 549 stale suites and 52
    // failures to `npm run verify`, so every sprint iteration reset.
    ignores: ["dist/*", ".claude/**", ".worktrees/**"],
  },
  {
    // The Gate is a Node service, not React Native. Without this it reported 60
    // bogus "'Buffer' is not defined" errors, and `expo lint` does not reach it
    // at all — so the component holding the shell endpoint, credential vault
    // and device tokens had no lint gate while `npm run verify` implied one.
    // The repo's own scripts are Node too, and `expo lint` reaches them no more
    // than it reaches the Gate: without Node globals `scripts/` reported seven
    // more. The RN tsconfig deliberately gives root .ts files no Node types, so
    // nothing but this block can say so for a .mjs.
    files: ["gate/**/*.mjs", "gate/**/*.js", "scripts/**/*.mjs", "scripts/**/*.js"],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: "module",
      ecmaVersion: "latest",
    },
    rules: {
      // gate/ is a Node service with no React in it. `useCredentialBackend` is
      // a plain function whose name happens to match the hook convention.
      "react-hooks/rules-of-hooks": "off",
    },
  },
]);
