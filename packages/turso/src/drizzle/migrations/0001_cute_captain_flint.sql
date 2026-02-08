CREATE TABLE `workflow_run_versions` (
	`run_id` text PRIMARY KEY NOT NULL,
	`spec_version` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stream_runs` (
	`run_id` text NOT NULL,
	`stream_name` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `stream_name`)
);
--> statement-breakpoint
CREATE INDEX `idx_stream_runs_run` ON `stream_runs` (`run_id`);