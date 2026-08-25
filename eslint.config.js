// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");
const globals = require("globals");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // The Gate is a Node service, not React Native. Without this it reported 60
    // bogus "'Buffer' is not defined" errors, and `expo lint` does not reach it
    // at all — so the component holding the shell endpoint, credential vault
    // and device tokens had no lint gate while `npm run verify` implied one.
    // scripts/__tests__ pins repo scripts (node:test) and needs the same node
    // globals — the RN tsconfig deliberately gives root .ts files no Node types.
    files: ["gate/**/*.mjs", "gate/**/*.js", "scripts/__tests__/**/*.mjs"],
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
