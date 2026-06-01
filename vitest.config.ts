import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcDir = fileURLToPath(new URL("./src/", import.meta.url));
const astroMiddlewareStub = fileURLToPath(new URL("./test/stubs/astro-middleware.ts", import.meta.url));

export default defineConfig({
  test: {
    environment: "happy-dom",
  },
  resolve: {
    alias: [
      // Astro's virtual middleware module is unresolvable outside the Astro build;
      // point it at a tiny runtime stub so middleware.ts can be imported in tests.
      { find: "astro:middleware", replacement: astroMiddlewareStub },
      // Mirror the `@/*` -> `./src/*` alias from tsconfig.json.
      { find: /^@\//, replacement: srcDir },
    ],
  },
});
