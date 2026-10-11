CREATE TABLE `batch_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`track_id` integer,
	`path` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `batch_files_batch_path_idx` ON `batch_files` (`batch_id`,`path`);--> statement-breakpoint
CREATE INDEX `batch_files_track_id_idx` ON `batch_files` (`track_id`);