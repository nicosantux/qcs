import type { IdentitiesConfig, Identity } from './config-store.ts'

import { ConfigError } from './config-store.ts'
import { nextIdentityColor } from './identity-colors.ts'

export interface IdentityInput {
  email: string
  label: string
  name: string
  /** `SIGN_WITH_SSH_KEY` or a key path; omitted on edit keeps the current one, `null` stops signing. */
  signingKey?: string | null
  /** Omitted on edit keeps the current key; `null` clears it. */
  sshKey?: string | null
}

export const DELETE_DEFAULT_IDENTITY_MESSAGE =
  'Choose another Default Identity before deleting this one'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')

  return slug.length > 0 ? slug : 'identity'
}

export function uniqueIdentityId(label: string, existingIds: readonly string[]): string {
  const base = slugify(label)
  let candidate = base

  for (let suffix = 2; existingIds.includes(candidate); suffix++) candidate = `${base}-${suffix}`

  return candidate
}

export function parseIdentityInput(
  input: IdentityInput,
): Omit<IdentityInput, 'signingKey' | 'sshKey'> {
  const parsed = {
    label: input.label.trim(),
    name: input.name.trim(),
    email: input.email.trim(),
  }

  if (parsed.label.length === 0) throw new ConfigError('Label cannot be empty')
  if (parsed.name.length === 0) throw new ConfigError('Name cannot be empty')
  if (!EMAIL_PATTERN.test(parsed.email))
    throw new ConfigError(`"${parsed.email}" is not a valid email`)

  return parsed
}

export function requireIdentity(config: IdentitiesConfig, id: string): Identity {
  const identity = config.identities.find((candidate) => candidate.id === id)

  if (!identity) throw new ConfigError(`Identity "${id}" does not exist`)

  return identity
}

export function addIdentity(config: IdentitiesConfig, input: IdentityInput): IdentitiesConfig {
  const parsed = parseIdentityInput(input)

  const id = uniqueIdentityId(
    parsed.label,
    config.identities.map((identity) => identity.id),
  )

  return {
    defaultIdentityId: config.defaultIdentityId ?? id,
    identities: [
      ...config.identities,
      {
        ...parsed,
        id,
        color: nextIdentityColor(config.identities),
        sshKey: input.sshKey ?? null,
        signingKey: input.signingKey ?? null,
      },
    ],
  }
}

export function changeIdentity(
  config: IdentitiesConfig,
  id: string,
  input: IdentityInput,
): IdentitiesConfig {
  requireIdentity(config, id)
  const parsed = parseIdentityInput(input)

  return {
    ...config,
    identities: config.identities.map((identity) =>
      identity.id === id
        ? {
            ...identity,
            ...parsed,
            sshKey: input.sshKey === undefined ? identity.sshKey : input.sshKey,
            signingKey: input.signingKey === undefined ? identity.signingKey : input.signingKey,
          }
        : identity,
    ),
  }
}

export function removeIdentity(config: IdentitiesConfig, id: string): IdentitiesConfig {
  requireIdentity(config, id)

  if (config.defaultIdentityId === id) {
    throw new ConfigError(DELETE_DEFAULT_IDENTITY_MESSAGE)
  }

  return { ...config, identities: config.identities.filter((identity) => identity.id !== id) }
}

export function chooseDefaultIdentity(config: IdentitiesConfig, id: string): IdentitiesConfig {
  requireIdentity(config, id)

  return { ...config, defaultIdentityId: id }
}
