CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`track_id` integer NOT NULL,
	`stage` text NOT NULL,
	`phase` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "jobs_phase_known" CHECK("jobs"."phase" in ('compute', 'apply')),
	CONSTRAINT "jobs_status_known" CHECK("jobs"."status" in ('queued', 'running', 'done', 'failed', 'skipped')),
	CONSTRAINT "jobs_attempts_not_negative" CHECK("jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_batch_track_stage_idx` ON `jobs` (`batch_id`,`track_id`,`stage`);--> statement-breakpoint
CREATE INDEX `jobs_batch_status_idx` ON `jobs` (`batch_id`,`status`);--> statement-breakpoint
CREATE INDEX `jobs_track_id_idx` ON `jobs` (`track_id`);--> statement-breakpoint
ALTER TABLE `batches` ADD `pause_reason` text;