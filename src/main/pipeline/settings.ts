// Reads and changes the app settings. Every rule about what a setting may be lives here.
import { realpathSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'path'
import type { z } from 'zod'
import { hasBackups } from '../db/backups'
import type { AppDatabase } from '../db/connection'
import { getSetting, setSetting } from '../db/settings'
import { listStyles, replaceStyles } from '../db/styles'
import { AppError, type Result } from '@shared/errors'
import {
  DEFAULT_SETTINGS,
  DEFAULT_STYLES,
  settingsPatchSchema,
  settingsSchema,
  styleListSchema,
  type EffectiveSettings,
  type FolderKind,
  type Settings,
  type SettingsSnapshot,
  type Style
} from '@shared/settings'
import { logger } from '../services/logger'

/** Facts about the machine that the defaults depend on. */
export interface SettingsEnvironment {
  homeDir: string
  cpuCount: number
}

const BACKUP_FOLDER_NAME = 'FixLibrary Backups'

// Each group is one row of the settings table.
function readGroup<T>(db: AppDatabase, group: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    return getSetting(db, group, schema) ?? fallback
  } catch (error) {
    // A stored value this version cannot read must not keep the Settings page from opening.
    logger.error(`Stored setting "${group}" is invalid; using its default`, error)
    return fallback
  }
}

export function readSettings(db: AppDatabase): Settings {
  const { shape } = settingsSchema
  return {
    library: readGroup(db, 'library', shape.library, DEFAULT_SETTINGS.library),
    rekordbox: readGroup(db, 'rekordbox', shape.rekordbox, DEFAULT_SETTINGS.rekordbox),
    loudness: readGroup(db, 'loudness', shape.loudness, DEFAULT_SETTINGS.loudness),
    hotCues: readGroup(db, 'hotCues', shape.hotCues, DEFAULT_SETTINGS.hotCues),
    performance: readGroup(db, 'performance', shape.performance, DEFAULT_SETTINGS.performance)
  }
}

// Folders in which the app cannot create a sibling of the library.
const PARENTS_WITHOUT_DEFAULT_BACKUP = [sep, join(sep, 'Volumes'), join(sep, 'Users')]

/**
 * Next to the library, never inside it, so a scan does not pick the backups up.
 * A library that is a whole drive or a home folder has no usable "next to": then
 * there is no default and the user has to choose a backup folder.
 */
function defaultBackupFolder(rootFolder: string | null): string | null {
  if (rootFolder === null) return null
  const parent = dirname(rootFolder)
  return PARENTS_WITHOUT_DEFAULT_BACKUP.includes(parent) ? null : join(parent, BACKUP_FOLDER_NAME)
}

export function resolveEffectiveSettings(
  settings: Settings,
  environment: SettingsEnvironment
): EffectiveSettings {
  const { rootFolder, backupFolder } = settings.library
  const rekordboxFolder = join(environment.homeDir, 'Documents', 'FixLibrary')
  const automaticWorkers = Math.max(1, environment.cpuCount - 1)
  return {
    backupFolder: backupFolder ?? defaultBackupFolder(rootFolder),
    generatedXmlFolder: settings.rekordbox.generatedXmlFolder ?? rekordboxFolder,
    exportedXmlFolder: settings.rekordbox.exportedXmlFolder ?? rekordboxFolder,
    // A stored count from another machine never asks for more than this one has.
    workerCount: Math.min(
      settings.performance.workerCount ?? automaticWorkers,
      Math.max(1, environment.cpuCount)
    )
  }
}

export function getSettingsSnapshot(
  db: AppDatabase,
  environment: SettingsEnvironment
): SettingsSnapshot {
  const settings = readSettings(db)
  return { settings, effective: resolveEffectiveSettings(settings, environment) }
}

function withoutUndefined<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined)
  ) as Partial<T>
}

/** Applies a change from the renderer. Folders cannot be changed this way. */
export function updateSettings(
  db: AppDatabase,
  patch: unknown,
  environment: SettingsEnvironment
): Result<SettingsSnapshot> {
  const parsed = settingsPatchSchema.safeParse(patch)
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }

  const current = readSettings(db)
  const { library, loudness, hotCues, performance } = parsed.data
  // The whole result is checked again before anything is written: a stored group
  // that does not fit its schema would silently fall back to the defaults on the next read.
  const next = settingsSchema.safeParse({
    ...current,
    library: { ...current.library, ...withoutUndefined(library ?? {}) },
    loudness: { ...current.loudness, ...withoutUndefined(loudness ?? {}) },
    hotCues: hotCues ?? current.hotCues,
    performance: performance ?? current.performance
  })
  if (!next.success) return { ok: false, code: 'INVALID_INPUT' }

  db.transaction((tx) => {
    if (library) setSetting(tx, 'library', next.data.library)
    if (loudness) setSetting(tx, 'loudness', next.data.loudness)
    if (hotCues) setSetting(tx, 'hotCues', next.data.hotCues)
    if (performance) setSetting(tx, 'performance', next.data.performance)
  })
  return { ok: true, value: getSettingsSnapshot(db, environment) }
}

function identityOf(path: string): string | null {
  try {
    // bigint: inode numbers on some volumes do not fit a JavaScript number.
    const { dev, ino } = statSync(path, { bigint: true })
    return `${dev}:${ino}`
  } catch {
    return null
  }
}

/**
 * The path with its existing part resolved through links. A folder that does not
 * exist yet (the default backup folder) keeps its missing tail as written.
 */
function canonicalPath(path: string): string {
  const missing: string[] = []
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(realpathSync.native(current), ...missing)
    } catch {
      if (current === dirname(current)) return path
      missing.unshift(basename(current))
    }
  }
}

/**
 * True when `folder` is `parent` or lies inside it. Decided by what the folders are
 * on disk, not by how their paths are spelled: links, letter case and Unicode forms
 * all name the same folder. A path that does not exist yet is compared by its
 * spelling from its first existing ancestor on.
 */
export function isInsideOrSame(folder: string, parent: string): boolean {
  const canonicalFolder = canonicalPath(folder)
  const canonicalParent = canonicalPath(parent)
  const parentIdentity = identityOf(canonicalParent)
  if (parentIdentity === null) {
    const path = relative(
      canonicalParent.normalize('NFC').toLowerCase(),
      canonicalFolder.normalize('NFC').toLowerCase()
    )
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }
  for (let current = canonicalFolder; ; current = dirname(current)) {
    if (identityOf(current) === parentIdentity) return true
    if (current === dirname(current)) return false
  }
}

/** The folder as the file system names it, or null if it cannot be a settings folder. */
function resolvePickedFolder(folder: string): string | null {
  if (!isAbsolute(folder)) return null
  try {
    const resolved = realpathSync.native(folder)
    return resolved !== sep && statSync(resolved).isDirectory() ? resolved : null
  } catch {
    return null
  }
}

const LIBRARY_FOLDER_KINDS: readonly FolderKind[] = ['libraryRoot', 'cleanLibrary', 'backup']

/**
 * True for a folder that must not be scanned as the library: the home folder or
 * anything above it (`/`, `/Users`), and `/Volumes` itself. A scan of these would
 * take in every audio file of the machine or of every drive. A whole drive is fine.
 */
export function isUnsuitableLibraryRoot(folder: string, environment: SettingsEnvironment): boolean {
  const volumesRoot = join(sep, 'Volumes')
  // The data volume shows the home folder a second time, under a path that is not
  // above the first one.
  const homeOnDataVolume = join(sep, 'System', 'Volumes', 'Data', environment.homeDir)
  return (
    isInsideOrSame(environment.homeDir, folder) ||
    isInsideOrSame(homeOnDataVolume, folder) ||
    (isInsideOrSame(folder, volumesRoot) && isInsideOrSame(volumesRoot, folder))
  )
}

/**
 * True when the library, its clean copy and its backup folder contain one another.
 * Checked when a folder is chosen and again by whatever is about to use the folders,
 * because what a path points to can change in between.
 */
export function libraryFoldersOverlap(
  settings: Settings,
  environment: SettingsEnvironment
): boolean {
  const { rootFolder, cleanLibraryFolder } = settings.library
  const backup = resolveEffectiveSettings(settings, environment).backupFolder
  const folders = [rootFolder, cleanLibraryFolder, backup].filter(
    (path): path is string => path !== null
  )
  return folders.some((first, index) =>
    folders
      .slice(index + 1)
      .some((second) => isInsideOrSame(first, second) || isInsideOrSame(second, first))
  )
}

/**
 * Stores a folder the user picked in a dialog of the main process, or clears it with
 * null. The library, its clean copy and its backups must not contain one another:
 * otherwise a run would copy the library into itself, scan its own backups, or put
 * the clean copy where backups are thrown away.
 */
export function setFolder(
  db: AppDatabase,
  kind: FolderKind,
  pickedFolder: string | null,
  environment: SettingsEnvironment
): Result<SettingsSnapshot> {
  // Stored as the file system spells it. No Unicode normalization here: on a drive
  // that keeps names as written (exFAT), a re-spelled path would be a different folder.
  const folder = pickedFolder === null ? null : resolvePickedFolder(pickedFolder)
  if (pickedFolder !== null && folder === null) return { ok: false, code: 'INVALID_INPUT' }

  const current = readSettings(db)
  const library = { ...current.library }
  const rekordbox = { ...current.rekordbox }
  if (kind === 'libraryRoot') library.rootFolder = folder
  if (kind === 'cleanLibrary') library.cleanLibraryFolder = folder
  if (kind === 'backup') library.backupFolder = folder
  if (kind === 'generatedXml') rekordbox.generatedXmlFolder = folder
  if (kind === 'exportedXml') rekordbox.exportedXmlFolder = folder

  if (kind === 'libraryRoot' && folder !== null && isUnsuitableLibraryRoot(folder, environment)) {
    return { ok: false, code: 'LIBRARY_ROOT_UNSUITABLE' }
  }
  if (
    LIBRARY_FOLDER_KINDS.includes(kind) &&
    libraryFoldersOverlap({ ...current, library }, environment)
  ) {
    return { ok: false, code: 'INVALID_INPUT' }
  }
  // Undo reads the backups from the folder in use. That folder also moves with the
  // library while no backup folder is chosen.
  const backupFolderBefore = resolveEffectiveSettings(current, environment).backupFolder
  const backupFolderAfter = resolveEffectiveSettings(
    { ...current, library },
    environment
  ).backupFolder
  if (backupFolderBefore !== backupFolderAfter && hasBackups(db)) {
    return { ok: false, code: 'BACKUPS_IN_USE' }
  }

  db.transaction((tx) => {
    setSetting(tx, 'library', library)
    setSetting(tx, 'rekordbox', rekordbox)
  })
  return { ok: true, value: getSettingsSnapshot(db, environment) }
}

/** Fills an empty style list with the documented defaults. Run once at startup. */
export function ensureDefaultStyles(db: AppDatabase): void {
  if (listStyles(db).length === 0) replaceStyles(db, DEFAULT_STYLES)
}

export function saveStyles(db: AppDatabase, list: unknown): Result<Style[]> {
  const parsed = styleListSchema.safeParse(list)
  if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' }
  try {
    return { ok: true, value: replaceStyles(db, parsed.data) }
  } catch (error) {
    if (error instanceof AppError) return { ok: false, code: error.code }
    throw error
  }
}
