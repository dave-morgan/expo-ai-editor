import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/build/**", "**/node_modules/**", "**/.expo/**", "apps/**/android/**", "apps/**/ios/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", require: "readonly", module: "writable", console: "readonly", __dirname: "readonly" },
    },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-require-imports": "off",
      // Flags fresh validation errors thrown inside unrelated try blocks; causes are attached where meaningful.
      "preserve-caught-error": "off",
    },
  },
);
