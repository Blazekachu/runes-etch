export function resolveRevealChangeAddress(
  commitChangeAddress: string | null | undefined,
  paymentAddress: string | null | undefined,
  taprootAddress: string,
): string {
  return commitChangeAddress || paymentAddress || taprootAddress;
}
