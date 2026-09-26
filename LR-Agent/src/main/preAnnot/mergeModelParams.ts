import type { PretrainedModelParams } from '../../shared/pretrainedModelTypes';

/** An omitted override must not erase a persisted model threshold. */
export function mergeModelParams(
  base: PretrainedModelParams | undefined,
  overrides: Partial<PretrainedModelParams> | undefined,
): PretrainedModelParams {
  const definedOverrides = Object.fromEntries(
    Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined),
  );
  return { ...base, ...definedOverrides };
}
