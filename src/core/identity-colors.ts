/**
 * ANSI palette indexes for Identities: cyan, magenta, blue and their bright variants.
 * Red, green and yellow are left out because they mean error, success and warning.
 */
export const IDENTITY_COLORS = [6, 5, 4, 14, 13, 12] as const

/** The first color no Identity uses yet, or the least used one once all are taken. */
export function nextIdentityColor(identities: readonly { color: number }[]): number {
  const uses = (color: number) => identities.filter((identity) => identity.color === color).length

  return IDENTITY_COLORS.reduce((best, color) => (uses(color) < uses(best) ? color : best))
}
