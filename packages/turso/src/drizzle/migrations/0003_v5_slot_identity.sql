CREATE TABLE `workflow_waits` (
	`run_id` text NOT NULL,
	`wait_id` text NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`resume_at` text,
	`completed_at` text,
	`spec_version` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `wait_id`)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_events` (
	`run_id` text NOT NULL,
	`event_id` text NOT NULL,
	`step_id` text,
	`type` text NOT NULL,
	`correlation_id` text,
	`payload` blob,
	`spec_version` integer,
	`created_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `event_id`)
);
--> statement-breakpoint
INSERT INTO `__new_workflow_events`("run_id", "event_id", "step_id", "type", "correlation_id", "payload", "spec_version", "created_at") SELECT "run_id", "event_id", "step_id", "type", "correlation_id", "payload", NULL, "created_at" FROM `workflow_events`;--> statement-breakpoint
DROP TABLE `workflow_events`;--> statement-breakpoint
ALTER TABLE `__new_workflow_events` RENAME TO `workflow_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_events_correlation` ON `workflow_events` (`run_id`,`correlation_id`,`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_events_entity_creation` ON `workflow_events` (`run_id`,`correlation_id`,`type`) WHERE "workflow_events"."type" IN ('step_created', 'hook_created', 'wait_created', 'wait_completed') AND "workflow_events"."spec_version" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_hooks` ADD `spec_version` integer;--> statement-breakpoint
ALTER TABLE `workflow_hooks` ADD `is_webhook` integer;--> statement-breakpoint
ALTER TABLE `workflow_hooks` ADD `is_system` integer;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `error_code` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `attributes` blob;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `spec_version` integer;--> statement-breakpoint
ALTER TABLE `workflow_steps` ADD `spec_version` integer;--> statement-breakpoint
UPDATE `workflow_runs` SET `spec_version` = (SELECT `spec_version` FROM `workflow_run_versions` WHERE `workflow_run_versions`.`run_id` = `workflow_runs`.`run_id`);
