// The whole database schema. Every change here needs a new migration
// (`npx drizzle-kit generate`); an applied migration is never edited.
import { sql, type SQL } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core'

export const AUDIO_FORMATS = ['mp3', 'wav', 'aiff'] as const
export const COVER_STATUSES = ['unknown', 'missing', 'embedded', 'placeholder'] as const
export const ANALYSIS_TYPES = [
  'bpm_key',
  'energy_features',
  'stems',
  'structure',
  'loudness'
] as const
export const BATCH_MODES = ['in_place', 'clean_library'] as const
export const BATCH_STATUSES = [
  'computing',
  'preview',
  'applying',
  'applied',
  'undone',
  'failed',
  'cancelled'
] as const

export const PAUSE_REASONS = ['user', 'offline'] as const
export const JOB_PHASES = ['compute', 'apply'] as const
export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'skipped'] as const

// SQLite has no enum type. The CHECK keeps a value that TypeScript would reject
// out of the file as well. The values are the constants above, never user input.
function oneOf(column: AnySQLiteColumn, values: readonly string[]): SQL {
  const list = sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `
  )
  return sql`${column} in (${list})`
}

const createdAt = integer('created_at', { mode: 'timestamp_ms' })
  .notNull()
  .$defaultFn(() => new Date())
const updatedAt = integer('updated_at', { mode: 'timestamp_ms' })
  .notNull()
  .$defaultFn(() => new Date())

export const styles = sqliteTable('styles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  color: text('color').notNull(),
  isHouse: integer('is_house', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0)
})

export const tracks = sqliteTable(
  'tracks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    path: text('path').notNull().unique(),
    originalPath: text('original_path').notNull(),
    // Name under /Volumes for a track on an external drive; null on the startup disk.
    volumeName: text('volume_name'),
    format: text('format', { enum: AUDIO_FORMATS }).notNull(),
    durationMs: integer('duration_ms'),
    bitrateKbps: integer('bitrate_kbps'),
    sampleRateHz: integer('sample_rate_hz'),
    // What the file looked like when it was last scanned. A rescan skips a file whose
    // size and modification time are unchanged; null means it was never scanned.
    fileSizeBytes: integer('file_size_bytes'),
    fileMtimeMs: integer('file_mtime_ms'),
    // Set by a scan that no longer finds the file on a mounted volume. The row stays,
    // because batches and backups may refer to it.
    fileMissing: integer('file_missing', { mode: 'boolean' }).notNull().default(false),
    artist: text('artist'),
    title: text('title'),
    mix: text('mix'),
    album: text('album'),
    label: text('label'),
    year: integer('year'),
    bpm: real('bpm'),
    camelotKey: text('camelot_key'),
    musicalKey: text('musical_key'),
    energy: integer('energy'),
    primaryStyleId: integer('primary_style_id').references(() => styles.id, {
      onDelete: 'set null'
    }),
    secondaryStyleId: integer('secondary_style_id').references(() => styles.id, {
      onDelete: 'set null'
    }),
    coverStatus: text('cover_status', { enum: COVER_STATUSES }).notNull().default('unknown'),
    lufs: real('lufs'),
    truePeakDbtp: real('true_peak_dbtp'),
    acoustId: text('acoust_id'),
    musicbrainzRecordingId: text('musicbrainz_recording_id'),
    // Processing state per function, as { [stage]: status }. Validated when read.
    stageStatus: text('stage_status', { mode: 'json' }).$type<unknown>().notNull().default({}),
    // The names of the fields the user set by hand in a batch preview. No automatic
    // run writes over them. Validated when read.
    lockedFields: text('locked_fields', { mode: 'json' }).$type<unknown>().notNull().default([]),
    createdAt,
    updatedAt
  },
  (table) => [
    index('tracks_volume_name_idx').on(table.volumeName),
    index('tracks_primary_style_id_idx').on(table.primaryStyleId),
    index('tracks_acoust_id_idx').on(table.acoustId),
    check('tracks_energy_range', sql`${table.energy} is null or ${table.energy} between 1 and 10`),
    check('tracks_format_known', oneOf(table.format, AUDIO_FORMATS)),
    check('tracks_cover_status_known', oneOf(table.coverStatus, COVER_STATUSES))
  ]
)

export const analyses = sqliteTable(
  'analyses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    trackId: integer('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ANALYSIS_TYPES }).notNull(),
    result: text('result', { mode: 'json' }).$type<unknown>().notNull(),
    analyzerVersion: text('analyzer_version').notNull(),
    createdAt
  },
  (table) => [
    uniqueIndex('analyses_track_type_idx').on(table.trackId, table.type),
    check('analyses_type_known', oneOf(table.type, ANALYSIS_TYPES))
  ]
)

export const lookupCache = sqliteTable(
  'lookup_cache',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').notNull(),
    queryKey: text('query_key').notNull(),
    response: text('response', { mode: 'json' }).$type<unknown>().notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull()
  },
  (table) => [uniqueIndex('lookup_cache_source_key_idx').on(table.source, table.queryKey)]
)

export const batches = sqliteTable(
  'batches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    mode: text('mode', { enum: BATCH_MODES }).notNull(),
    status: text('status', { enum: BATCH_STATUSES }).notNull().default('computing'),
    // Null while the batch is not paused. A run the user paused stays paused when the
    // app is started again; one that paused itself because the drive was gone goes on.
    // No CHECK: adding one to this table would rebuild it, and the backups hang on it.
    pauseReason: text('pause_reason', { enum: PAUSE_REASONS }),
    createdAt,
    appliedAt: integer('applied_at', { mode: 'timestamp_ms' })
  },
  (table) => [
    check('batches_mode_known', oneOf(table.mode, BATCH_MODES)),
    check('batches_status_known', oneOf(table.status, BATCH_STATUSES))
  ]
)

// One row per track of a batch: what it looked like before and what was proposed.
// Undo reads these, so a track cannot be deleted while a batch still refers to it.
export const batchItems = sqliteTable(
  'batch_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    batchId: integer('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    trackId: integer('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'restrict' }),
    before: text('before', { mode: 'json' }).$type<unknown>().notNull(),
    after: text('after', { mode: 'json' }).$type<unknown>().notNull(),
    approved: integer('approved', { mode: 'boolean' }).notNull().default(false),
    excluded: integer('excluded', { mode: 'boolean' }).notNull().default(false),
    error: text('error', { mode: 'json' }).$type<unknown>()
  },
  (table) => [
    uniqueIndex('batch_items_batch_track_idx').on(table.batchId, table.trackId),
    index('batch_items_track_id_idx').on(table.trackId)
  ]
)

// One stage for one track of a batch. The rows are what a run is resumed from after
// the app was closed: `done` jobs are not run again, `running` ones go back to `queued`.
export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    batchId: integer('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'cascade' }),
    trackId: integer('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'restrict' }),
    stage: text('stage').notNull(),
    phase: text('phase', { enum: JOB_PHASES }).notNull(),
    status: text('status', { enum: JOB_STATUSES }).notNull().default('queued'),
    // How often the job was started. A job that keeps being interrupted is given up.
    attempts: integer('attempts').notNull().default(0),
    // The TrackError of a failed job. Validated when read.
    error: text('error', { mode: 'json' }).$type<unknown>(),
    createdAt,
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' })
  },
  (table) => [
    uniqueIndex('jobs_batch_track_stage_idx').on(table.batchId, table.trackId, table.stage),
    index('jobs_batch_status_idx').on(table.batchId, table.status),
    index('jobs_track_id_idx').on(table.trackId),
    check('jobs_phase_known', oneOf(table.phase, JOB_PHASES)),
    check('jobs_status_known', oneOf(table.status, JOB_STATUSES)),
    check('jobs_attempts_not_negative', sql`${table.attempts} >= 0`)
  ]
)

// The only record of where a backup file is. A row never disappears as a side effect:
// a batch with backups cannot be deleted, and deleting a track only clears the link.
export const backups = sqliteTable(
  'backups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    batchId: integer('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'restrict' }),
    trackId: integer('track_id').references(() => tracks.id, { onDelete: 'set null' }),
    originalPath: text('original_path').notNull(),
    backupPath: text('backup_path').notNull(),
    createdAt
  },
  (table) => [
    index('backups_batch_id_idx').on(table.batchId),
    index('backups_track_id_idx').on(table.trackId)
  ]
)

// The files a batch created: copies in the clean library, and files under a new name.
// A row is written before its file is, so that undo knows what to remove even if the
// app stopped between the two. Kept from disappearing like the backups are.
export const batchFiles = sqliteTable(
  'batch_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    batchId: integer('batch_id')
      .notNull()
      .references(() => batches.id, { onDelete: 'restrict' }),
    trackId: integer('track_id').references(() => tracks.id, { onDelete: 'set null' }),
    path: text('path').notNull(),
    /**
     * The sha256 of what the batch wrote into the file, once it changed its bytes.
     * Null for a file the batch only copied or moved: that one is known by holding
     * what its backup or its original holds. Undo removes a file only if it is the
     * batch's own by one of the two.
     */
    sha256: text('sha256'),
    createdAt
  },
  (table) => [
    uniqueIndex('batch_files_batch_path_idx').on(table.batchId, table.path),
    index('batch_files_track_id_idx').on(table.trackId)
  ]
)

export const cues = sqliteTable(
  'cues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    trackId: integer('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    slot: integer('slot').notNull(),
    positionMs: integer('position_ms').notNull(),
    name: text('name').notNull(),
    color: text('color').notNull()
  },
  (table) => [
    uniqueIndex('cues_track_slot_idx').on(table.trackId, table.slot),
    check('cues_slot_range', sql`${table.slot} between 1 and 8`),
    check('cues_position_not_negative', sql`${table.positionMs} >= 0`)
  ]
)

export const playlists = sqliteTable('playlists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdAt,
  updatedAt
})

export const playlistTracks = sqliteTable(
  'playlist_tracks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    playlistId: integer('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    trackId: integer('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    position: integer('position').notNull()
  },
  (table) => [
    // Not unique: reordering shifts many positions in one statement, and SQLite
    // checks uniqueness row by row.
    index('playlist_tracks_playlist_position_idx').on(table.playlistId, table.position),
    index('playlist_tracks_track_id_idx').on(table.trackId)
  ]
)

export const energyCalibration = sqliteTable(
  'energy_calibration',
  {
    trackId: integer('track_id')
      .primaryKey()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(),
    ratedAt: integer('rated_at', { mode: 'timestamp_ms' }).notNull()
  },
  (table) => [check('energy_calibration_rating_range', sql`${table.rating} between 1 and 10`)]
)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt
})
