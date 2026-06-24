import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const srcDir = fileURLToPath(new URL("./src/", import.meta.url));
const astroMiddlewareStub = fileURLToPath(new URL("./test/stubs/astro-middleware.ts", import.meta.url));
const astroActionsStub = fileURLToPath(new URL("./test/stubs/astro-actions.ts", import.meta.url));
const astroEnvServerStub = fileURLToPath(new URL("./test/stubs/astro-env-server.ts", import.meta.url));

export default defineConfig({
  test: {
    environment: "happy-dom",
    // Playwright specs live in tests/e2e/*.spec.ts and are run by `npm run e2e`,
    // not Vitest. Without this they match Vitest's default `**/*.spec.ts` include
    // and crash it (`test.beforeEach() not expected here`). Keep Vitest's other
    // default excludes (node_modules, dist, .astro, …).
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
  resolve: {
    alias: [
      // Astro's virtual middleware module is unresolvable outside the Astro build;
      // point it at a tiny runtime stub so middleware.ts can be imported in tests.
      { find: "astro:middleware", replacement: astroMiddlewareStub },
      // Likewise for the actions + server-env virtual modules, so the real
      // `participants.create` handler can be imported and exercised in tests.
      { find: "astro:actions", replacement: astroActionsStub },
      { find: "astro:env/server", replacement: astroEnvServerStub },
      // Mirror the `@/*` -> `./src/*` alias from tsconfig.json.
      { find: /^@\//, replacement: srcDir },
    ],
  },
});
