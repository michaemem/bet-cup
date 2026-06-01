// Runtime stub for the `astro:middleware` virtual module, used only by Vitest
// (aliased in vitest.config.ts). Type-checking/ESLint still resolve the real
// virtual module via tsconfig + .astro/types, so this stub never affects types.
export function defineMiddleware<T>(handler: T): T {
  return handler;
}
