import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { args: "all", argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // The validation engine dispatches on `unknown` shapes and narrows
      // structurally; several marker interfaces are intentionally empty
      // type-position tags. These two rules fight the pattern without
      // catching anything real.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      // Prose-heavy pages quote copy with ordinary apostrophes ("30 days'
      // notice", "everyone else's"). React's rule wants every one escaped;
      // the copy reads worse for it and the escapes are not a security or
      // correctness issue in this app's JSX.
      "react/no-unescaped-entities": "off",
    },
  },
]);

export default eslintConfig;
