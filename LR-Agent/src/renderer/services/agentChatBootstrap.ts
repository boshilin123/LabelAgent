/** Returns true when an async bootstrap result should be applied to state. */
export function shouldApplyBootstrapResult(
  generation: number,
  currentGeneration: number,
): boolean {
  return generation === currentGeneration;
}
