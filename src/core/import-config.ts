import type { IdentitiesConfig } from './config-store.ts'
import type { FolderScope } from './machine-config.ts'

import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

import { collapseHome } from './config-store.ts'
import { fileExists } from './fs.ts'
import { globalGitConfigPath } from './global-git-config.ts'
import { parseIdentityInput, uniqueIdentityId } from './identities.ts'
import { nextIdentityColor } from './identity-colors.ts'
import { pathKey } from './machine-config.ts'
import { expandHome, type Environment } from './paths.ts'

interface Author {
  email: string
  name: string
}

export interface ImportedFolder extends Author {
  displayPath: string
  path: string
  /** False when the included file sets other things too, so the `includeIf` block must stay. */
  removed: boolean
}

/** What importing would add to qcs and take out of the global git config. */
export interface ImportPlan {
  /** The global `[user]` block, when it becomes the Default Identity. */
  defaultIdentity: Author | null
  folders: ImportedFolder[]
}

interface Entry {
  key: string
  line: number
  value: string
}

interface Section {
  /** Last line that belongs to the section, ignoring trailing blank and comment lines. */
  end: number
  entries: Entry[]
  name: string
  start: number
  subsection: string | null
}

interface Candidate extends Author {
  path: string
  range: readonly [number, number]
  removable: boolean
}

interface Detected {
  /** Only folders listed after every rule that cannot be imported: the managed file is included last and would override those rules. */
  candidates: Candidate[]
  /** Rules that set the author but cannot be imported, so they must keep winning over the Default Identity. */
  foreignAuthorRules: number
  user: (Author & { lines: number[]; sectionHeaders: number[] }) | null
}

const HEADER = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*]\s*(?:[#;].*)?$/
const ENTRY = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=(.*)$/
const IGNORABLE = /^\s*(?:[#;].*)?$/

function parseValue(raw: string): string {
  const value = raw.trim()
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(value)

  return quoted ? quoted[1]!.replaceAll(/\\(.)/g, '$1') : value.replace(/\s+[#;].*$/, '')
}

function parseSections(lines: string[]): Section[] {
  const sections: Section[] = []

  lines.forEach((text, line) => {
    const header = HEADER.exec(text)

    if (header || text.trimStart().startsWith('[')) {
      sections.push({
        name: header ? header[1]!.toLowerCase() : '?',
        subsection: header?.[2]?.replaceAll(/\\(.)/g, '$1') ?? null,
        start: line,
        end: line,
        entries: [],
      })

      return
    }

    const section = sections.at(-1)

    if (!section) return
    const entry = ENTRY.exec(text)

    if (entry) {
      section.entries.push({ key: entry[1]!.toLowerCase(), value: parseValue(entry[2]!), line })
    }

    if (!IGNORABLE.test(text)) section.end = line
  })

  return sections
}

function lastValue(entries: Entry[], key: string): string | undefined {
  return entries.findLast((entry) => entry.key === key)?.value
}

function authorOf(entries: Entry[]): Author | null {
  const name = lastValue(entries, 'name')
  const email = lastValue(entries, 'email')

  return name && email ? { name, email } : null
}

/** A `gitdir:` condition that names one literal folder, ending in `/`. */
function folderOf(environment: Environment, condition: string): string | null {
  const pattern = /^gitdir(?:\/i)?:(.*\/)$/.exec(condition)?.[1]

  if (pattern === undefined || /[*?[\\]/.test(pattern)) return null
  const expanded = expandHome(pattern, environment.home)

  return isAbsolute(expanded) ? resolve(expanded) : null
}

function detect(environment: Environment, content: string, configPath: string): Detected {
  const lines = content.split('\n')
  const sections = parseSections(lines)
  const userSections = sections.filter(({ name, subsection }) => name === 'user' && !subsection)
  const userEntries = userSections.flatMap(({ entries }) => entries)
  const userAuthor = authorOf(userEntries)

  const authorLines = userEntries.filter(({ key }) => isAuthorKey(key))

  const lastAuthorLine = Math.max(...authorLines.map(({ line }) => line))
  const candidates: Candidate[] = []

  // shortcut: git applies the last matching rule in file order, qcs the deepest folder; a shallower folder listed after a nested one would change author, handle it if that layout shows up.
  let foreignAuthorRules = 0
  let lastForeignRule = -1

  for (const section of sections) {
    if (section.name !== 'includeif' || section.subsection === null) continue
    // A `[user]` block further down overrides the included file, so the rule has no effect to preserve.
    if (userAuthor && section.start < lastAuthorLine) continue

    const paths = section.entries.filter(({ key }) => key === 'path')

    const includedEntries = paths.flatMap(({ value }) => {
      const included = resolve(dirname(configPath), expandHome(value, environment.home))

      return fileExists(included)
        ? parseSections(readFileSync(included, 'utf8').split('\n')).flatMap(
            ({ entries }) => entries,
          )
        : []
    })

    const author = authorOf(includedEntries.filter(({ key }) => isAuthorKey(key)))
    const folder = folderOf(environment, section.subsection)

    if (folder !== null && author && paths.length === 1 && section.entries.length === 1) {
      candidates.push({
        ...author,
        path: folder,
        range: [section.start, section.end],
        removable: includedEntries.every(({ key }) => isAuthorKey(key)),
      })
    } else if (includedEntries.some(({ key }) => isAuthorKey(key))) {
      foreignAuthorRules++
      lastForeignRule = section.start
    }
  }

  return {
    candidates: candidates.filter(({ range }) => range[0] > lastForeignRule),
    foreignAuthorRules,
    user: userAuthor && {
      ...userAuthor,
      lines: authorLines.map(({ line }) => line),
      sectionHeaders: userSections
        .filter(({ entries }) => entries.every(({ key }) => isAuthorKey(key)))
        .map(({ start }) => start),
    },
  }
}

function isAuthorKey(key: string): boolean {
  return key === 'name' || key === 'email'
}

function detectInGlobalConfig(environment: Environment, content: string): Detected {
  return detect(environment, content, globalGitConfigPath(environment))
}

export interface ImportBuild {
  config: IdentitiesConfig
  plan: ImportPlan
  scopes: Pick<FolderScope, 'identityId' | 'path'>[]
}

/**
 * Merges what the global git config holds into the current qcs configuration.
 * Anything that would change a repository's author, or clash with what qcs already has, is left out.
 */
export function buildImport(
  environment: Environment,
  existing: IdentitiesConfig,
  existingScopes: Pick<FolderScope, 'identityId' | 'path'>[],
): ImportBuild | null {
  const configPath = globalGitConfigPath(environment)

  if (!fileExists(configPath)) return null
  const detected = detectInGlobalConfig(environment, readFileSync(configPath, 'utf8'))

  const run = (importUser: boolean): ImportBuild & { skipped: number } => {
    let config = existing
    let skipped = detected.foreignAuthorRules
    const scopes = [...existingScopes]

    /** The Identity to use for the author: reused on the same email, new otherwise, null when it would change the name. */
    const identityFor = (author: Author, label: string): string | null => {
      const same = config.identities.find(
        ({ email }) => email.toLowerCase() === author.email.toLowerCase(),
      )

      if (same) return same.name === author.name ? same.id : null

      try {
        const parsed = parseIdentityInput({ ...author, label })

        const id = uniqueIdentityId(
          label,
          config.identities.map(({ id }) => id),
        )

        const color = nextIdentityColor(config.identities)

        config = {
          ...config,
          identities: [
            ...config.identities,
            { ...parsed, id, color, sshKey: null, signingKey: null },
          ],
        }

        return id
      } catch {
        return null
      }
    }

    let defaultIdentity: Author | null = null

    if (importUser && detected.user && config.defaultIdentityId === null) {
      const id = identityFor(detected.user, 'Default')

      if (id !== null) {
        config = { ...config, defaultIdentityId: id }
        defaultIdentity = { name: detected.user.name, email: detected.user.email }
      }
    }

    const folders: ImportedFolder[] = []

    for (const candidate of detected.candidates) {
      const id = scopes.some((scope) => pathKey(scope.path) === pathKey(candidate.path))
        ? null
        : identityFor(candidate, basename(candidate.path))

      if (id === null) {
        skipped++

        continue
      }

      scopes.push({ path: candidate.path, identityId: id })
      folders.push({
        path: candidate.path,
        displayPath: collapseHome(candidate.path, environment.home),
        name: candidate.name,
        email: candidate.email,
        removed: candidate.removable,
      })
    }

    return { config, scopes, skipped, plan: { defaultIdentity, folders } }
  }

  const withUser = run(true)
  const build = withUser.skipped > 0 && withUser.plan.defaultIdentity ? run(false) : withUser

  return build.plan.defaultIdentity === null && build.plan.folders.length === 0 ? null : build
}

/** The global git config content without the blocks that `plan` imported. */
export function removeImported(
  environment: Environment,
  content: string,
  plan: ImportPlan,
): string {
  const detected = detectInGlobalConfig(environment, content)
  const dropped = new Set<number>()

  if (plan.defaultIdentity && detected.user) {
    for (const line of [...detected.user.lines, ...detected.user.sectionHeaders]) dropped.add(line)
  }

  const removedPaths = new Set(
    plan.folders.filter(({ removed }) => removed).map(({ path }) => pathKey(path)),
  )

  for (const { path, range } of detected.candidates) {
    if (!removedPaths.has(pathKey(path))) continue
    for (let line = range[0]; line <= range[1]; line++) dropped.add(line)
  }

  return content
    .split('\n')
    .filter((_, line) => !dropped.has(line))
    .join('\n')
}
