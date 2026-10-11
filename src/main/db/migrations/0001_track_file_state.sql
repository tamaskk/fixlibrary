ALTER TABLE `tracks` ADD `file_size_bytes` integer;--> statement-breakpoint
ALTER TABLE `tracks` ADD `file_mtime_ms` integer;--> statement-breakpoint
ALTER TABLE `tracks` ADD `file_missing` integer DEFAULT false NOT NULL;