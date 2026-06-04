import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcDir = fileURLToPath(new URL("./src/", import.meta.url));
const astroMiddlewareStub = fileURLToPath(new URL("./test/stubs/astro-middleware.ts", import.meta.url));
const astroActionsStub = fileURLToPath(new URL("./test/stubs/astro-actions.ts", import.meta.url));
const astroEnvServerStub = fileURLToPath(new URL("./test/stubs/astro-env-server.ts", import.meta.url));

export default defineConfig({
  test: {
    environment: "happy-dom",
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
