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
    files: ["gate/**/*.mjs", "gate/**/*.js"],
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
