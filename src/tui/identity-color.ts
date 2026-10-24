import { RGBA } from '@opentui/core'

/** The palette slot stored with the Identity, so it never changes and no two Identities share one while slots are free. */
export function identityColor({ color }: { color: number }): RGBA {
  return RGBA.fromIndex(color)
}
