// Minimal Node globals used by the CI scripts. Declared locally rather than
// depending on `@types/node`, which would otherwise be pulled into this
// browser-targeted project solely for these scripts.
declare const process: {
  env: Record<string, string | undefined>;
  exitCode: number;
  exit(code?: number): never;
};
