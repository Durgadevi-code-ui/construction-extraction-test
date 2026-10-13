/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs, which loads CommonJS packages such as xlsx. */
// Lets `node --test` load this app's TypeScript modules directly, with
// no extra dependency: .ts files are transpiled with the project's own
// `typescript` package, "@/..." resolves to the project root (as in
// tsconfig.json), and "server-only" — a build-time guard that throws
// outside a React Server Component bundle — is replaced by an empty
// module. Used by `npm test` only; never part of the app build.
const fs = require("fs");
const path = require("path");
const Module = require("module");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const EMPTY = path.join(__dirname, "empty-module.cjs");

const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "server-only") return EMPTY;
  const target = request.startsWith("@/") ? path.join(ROOT, request.slice(2)) : request;
  try {
    return resolve.call(this, target, parent, ...rest);
  } catch (err) {
    for (const ext of [".ts", ".tsx"]) {
      try {
        return resolve.call(this, target + ext, parent, ...rest);
      } catch {}
    }
    throw err;
  }
};

require.extensions[".ts"] = function (module, filename) {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

// Modules that build a Supabase client at import time only need these to
// exist; no test ever talks to Supabase (all use a mocked client).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://supabase.test.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
