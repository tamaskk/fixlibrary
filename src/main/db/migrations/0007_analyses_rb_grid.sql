PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`track_id` integer NOT NULL,
	`type` text NOT NULL,
	`result` text NOT NULL,
	`analyzer_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "analyses_type_known" CHECK("__new_analyses"."type" in ('bpm_key', 'energy_features', 'stems', 'structure', 'loudness', 'rb_grid'))
);
--> statement-breakpoint
INSERT INTO `__new_analyses`("id", "track_id", "type", "result", "analyzer_version", "created_at") SELECT "id", "track_id", "type", "result", "analyzer_version", "created_at" FROM `analyses`;--> statement-breakpoint
DROP TABLE `analyses`;--> statement-breakpoint
ALTER TABLE `__new_analyses` RENAME TO `analyses`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `analyses_track_type_idx` ON `analyses` (`track_id`,`type`);