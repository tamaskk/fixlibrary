CREATE TABLE `analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`track_id` integer NOT NULL,
	`type` text NOT NULL,
	`result` text NOT NULL,
	`analyzer_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "analyses_type_known" CHECK("analyses"."type" in ('bpm_key', 'energy_features', 'stems', 'structure', 'loudness'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analyses_track_type_idx` ON `analyses` (`track_id`,`type`);--> statement-breakpoint
CREATE TABLE `backups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`track_id` integer,
	`original_path` text NOT NULL,
	`backup_path` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `backups_batch_id_idx` ON `backups` (`batch_id`);--> statement-breakpoint
CREATE INDEX `backups_track_id_idx` ON `backups` (`track_id`);--> statement-breakpoint
CREATE TABLE `batch_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`track_id` integer NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`approved` integer DEFAULT false NOT NULL,
	`excluded` integer DEFAULT false NOT NULL,
	`error` text,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `batch_items_batch_track_idx` ON `batch_items` (`batch_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `batch_items_track_id_idx` ON `batch_items` (`track_id`);--> statement-breakpoint
CREATE TABLE `batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'computing' NOT NULL,
	`created_at` integer NOT NULL,
	`applied_at` integer,
	CONSTRAINT "batches_mode_known" CHECK("batches"."mode" in ('in_place', 'clean_library')),
	CONSTRAINT "batches_status_known" CHECK("batches"."status" in ('computing', 'preview', 'applying', 'applied', 'undone', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE `cues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`track_id` integer NOT NULL,
	`slot` integer NOT NULL,
	`position_ms` integer NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cues_slot_range" CHECK("cues"."slot" between 1 and 8),
	CONSTRAINT "cues_position_not_negative" CHECK("cues"."position_ms" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cues_track_slot_idx` ON `cues` (`track_id`,`slot`);--> statement-breakpoint
CREATE TABLE `energy_calibration` (
	`track_id` integer PRIMARY KEY NOT NULL,
	`rating` integer NOT NULL,
	`rated_at` integer NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "energy_calibration_rating_range" CHECK("energy_calibration"."rating" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE `lookup_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`query_key` text NOT NULL,
	`response` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lookup_cache_source_key_idx` ON `lookup_cache` (`source`,`query_key`);--> statement-breakpoint
CREATE TABLE `playlist_tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer NOT NULL,
	`track_id` integer NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playlist_tracks_playlist_position_idx` ON `playlist_tracks` (`playlist_id`,`position`);--> statement-breakpoint
CREATE INDEX `playlist_tracks_track_id_idx` ON `playlist_tracks` (`track_id`);--> statement-breakpoint
CREATE TABLE `playlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `styles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`is_house` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `styles_name_unique` ON `styles` (`name`);--> statement-breakpoint
CREATE TABLE `tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`original_path` text NOT NULL,
	`volume_name` text,
	`format` text NOT NULL,
	`duration_ms` integer,
	`bitrate_kbps` integer,
	`sample_rate_hz` integer,
	`artist` text,
	`title` text,
	`mix` text,
	`album` text,
	`label` text,
	`year` integer,
	`bpm` real,
	`camelot_key` text,
	`musical_key` text,
	`energy` integer,
	`primary_style_id` integer,
	`secondary_style_id` integer,
	`cover_status` text DEFAULT 'unknown' NOT NULL,
	`lufs` real,
	`true_peak_dbtp` real,
	`acoust_id` text,
	`musicbrainz_recording_id` text,
	`stage_status` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`primary_style_id`) REFERENCES `styles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`secondary_style_id`) REFERENCES `styles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tracks_energy_range" CHECK("tracks"."energy" is null or "tracks"."energy" between 1 and 10),
	CONSTRAINT "tracks_format_known" CHECK("tracks"."format" in ('mp3', 'wav', 'aiff')),
	CONSTRAINT "tracks_cover_status_known" CHECK("tracks"."cover_status" in ('unknown', 'missing', 'embedded', 'placeholder'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracks_path_unique` ON `tracks` (`path`);--> statement-breakpoint
CREATE INDEX `tracks_volume_name_idx` ON `tracks` (`volume_name`);--> statement-breakpoint
CREATE INDEX `tracks_primary_style_id_idx` ON `tracks` (`primary_style_id`);--> statement-breakpoint
CREATE INDEX `tracks_acoust_id_idx` ON `tracks` (`acoust_id`);