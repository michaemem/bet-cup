// Runtime stub for the `astro:actions` virtual module, used only by Vitest
// (aliased in vitest.config.ts). `defineAction` is reduced to identity so tests
// can reach the config's `.handler`; `ActionError` is a real throwing class that
// carries `code`. Type-checking/ESLint still resolve the real virtual module via
// tsconfig + .astro/types, so this stub never affects types.
export class ActionError extends Error {
  code: string;
  constructor({ code, message }: { code: string; message?: string }) {
    super(message);
    this.code = code;
    this.name = "ActionError";
  }
}

export function defineAction<T>(config: T): T {
  return config;
}
