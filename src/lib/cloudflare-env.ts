import { env as workerEnv } from 'cloudflare:workers';

/** A normalized view of the Cloudflare bindings available to this request. */
type BindingEnvironment = {
  ADMIN_PASSWORD?: unknown;
  DB?: unknown;
  ASSETS?: unknown;
};

function asBindings(value: unknown): BindingEnvironment {
  return value && typeof value === 'object' ? value as BindingEnvironment : {};
}

export function getCloudflareBindings(locals?: unknown): BindingEnvironment {
  const runtimeEnv = asBindings((locals as any)?.runtime?.env);
  const directEnv = asBindings(workerEnv);
  return {
    ADMIN_PASSWORD: nonEmptyString(runtimeEnv.ADMIN_PASSWORD)
      ? runtimeEnv.ADMIN_PASSWORD
      : directEnv.ADMIN_PASSWORD,
    DB: runtimeEnv.DB ?? directEnv.DB,
    ASSETS: runtimeEnv.ASSETS ?? directEnv.ASSETS,
  };
}

export function hasNonEmptySecret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nonEmptyString(value: unknown): value is string {
  return hasNonEmptySecret(value);
}

/** Safe diagnostics: reports presence only, never secret contents. */
export function getBindingDiagnostics(locals?: unknown): string {
  const runtimeEnv = asBindings((locals as any)?.runtime?.env);
  const directEnv = asBindings(workerEnv);
  const runtimeExists = Boolean((locals as any)?.runtime);
  return [
    `runtime=${runtimeExists ? 'oui' : 'non'}`,
    `ADMIN_PASSWORD.locals=${hasNonEmptySecret(runtimeEnv.ADMIN_PASSWORD) ? 'oui' : 'non'}`,
    `ADMIN_PASSWORD.workers=${hasNonEmptySecret(directEnv.ADMIN_PASSWORD) ? 'oui' : 'non'}`,
    `DB=${Boolean(runtimeEnv.DB ?? directEnv.DB) ? 'oui' : 'non'}`,
    `ASSETS=${Boolean(runtimeEnv.ASSETS ?? directEnv.ASSETS) ? 'oui' : 'non'}`,
  ].join('; ');
}
