import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import nodePlugin from "eslint-plugin-n";
import globals from "globals";
import tseslint from "typescript-eslint";

const typeScriptFiles = [
  "**/*.ts",
];

const typeScriptConfigs = tseslint.configs.recommended.map(config => ({
  ...config,
  files: typeScriptFiles,
}));

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "node_modules/**",
    ],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  js.configs.recommended,
  nodePlugin.configs["flat/recommended-module"],
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    settings: {
      node: {
        version: ">=24.3.0 <25.0.0",
      },
    },
    rules: {
      "n/file-extension-in-import": "off",
      "n/no-missing-import": "off",
      "n/no-process-exit": "off",
      "n/no-unpublished-import": "off",
      "no-console": "off",
    },
  },
  ...typeScriptConfigs,
  {
    files: typeScriptFiles,
    languageOptions: {
      parserOptions: {
        project: [
          "./tsconfig.json",
          "./tsconfig.test.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "inline-type-imports",
          prefer: "type-imports",
        },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-for-in-array": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: false,
        },
      ],
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-void": [
        "error",
        {
          allowAsStatement: true,
        },
      ],
    },
  },
  {
    files: [
      "**/*.test.ts",
      "modules/test-utils/**/*.ts",
    ],
    ...vitest.configs.recommended,
    languageOptions: {
      globals: {
        ...vitest.environments.env.globals,
      },
    },
    settings: {
      vitest: {
        typecheck: false,
      },
    },
    rules: {
      ...vitest.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
