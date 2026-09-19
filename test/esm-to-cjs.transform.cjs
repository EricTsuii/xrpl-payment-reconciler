// NestJS 12 and the noble/scure cryptography packages used by xrpl.js are
// published as ES modules only. Node.js 22 loads them from CommonJS through
// require(esm), but Jest 29 resolves modules with its own CommonJS runtime and
// cannot. This transformer rewrites those files to CommonJS with the pinned
// TypeScript compiler, so the test toolchain needs no extra dependency.
//
// The only `import.meta` usage in these packages is `import.meta.url`, which
// has an exact CommonJS equivalent. Any other `import.meta` usage fails loudly
// instead of being silently miscompiled.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const ts = require('typescript');

const IMPORT_META_URL = /\bimport\.meta\.url\b/g;
const IMPORT_META = /\bimport\.meta\b/;
const BLOCK_COMMENTS = /\/\*[\s\S]*?\*\//g;
const SELF = fs.readFileSync(__filename);

module.exports = {
  getCacheKey(sourceText, sourcePath) {
    return createHash('sha256')
      .update(SELF)
      .update(ts.version)
      .update(sourcePath)
      .update(sourceText)
      .digest('hex');
  },

  process(sourceText, sourcePath) {
    const source = sourceText.replace(
      IMPORT_META_URL,
      'require("node:url").pathToFileURL(__filename).href',
    );
    if (IMPORT_META.test(source.replace(BLOCK_COMMENTS, ''))) {
      throw new Error(`unsupported import.meta usage in ${sourcePath}`);
    }
    const output = ts.transpileModule(source, {
      fileName: sourcePath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2023,
        allowJs: true,
        esModuleInterop: true,
      },
    });
    return { code: output.outputText };
  },
};
