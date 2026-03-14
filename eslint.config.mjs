import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "lib/**",
      "coverage/**",
      "node_modules/**",
      "doc-*/**",
      "**/book/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
