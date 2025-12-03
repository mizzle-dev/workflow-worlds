CREATE TABLE `workflow_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text,
	`type` text NOT NULL,
	`correlation_id` text,
	`payload` blob,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_run` ON `workflow_events` (`run_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `idx_events_correlation` ON `workflow_events` (`correlation_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `workflow_hooks` (
	`hook_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`token` text NOT NULL,
	`display_name` text,
	`metadata` blob,
	`owner_id` text NOT NULL,
	`project_id` text NOT NULL,
	`environment` text NOT NULL,
	`received_at` text,
	`disposed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_hooks_run` ON `workflow_hooks` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hooks_token` ON `workflow_hooks` (`token`);--> statement-breakpoint
CREATE TABLE `queue_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`queue_name` text NOT NULL,
	`payload` text NOT NULL,
	`idempotency_key` text,
	`status` text DEFAULT 'pending',
	`lock_token` text,
	`attempt` integer DEFAULT 0,
	`max_attempts` integer DEFAULT 3,
	`not_before` text,
	`created_at` text NOT NULL,
	`processed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_queue_pending` ON `queue_messages` (`queue_name`,`status`,`not_before`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`workflow_name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`input` blob,
	`output` blob,
	`error` blob,
	`execution_context` blob,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_runs_status` ON `workflow_runs` (`status`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_runs_workflow` ON `workflow_runs` (`workflow_name`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_runs_deployment` ON `workflow_runs` (`deployment_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `workflow_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`step_name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`input` blob,
	`output` blob,
	`error` blob,
	`attempt` integer DEFAULT 0,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_steps_run` ON `workflow_steps` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_steps_step_id` ON `workflow_steps` (`step_id`);--> statement-breakpoint
CREATE TABLE `stream_chunks` (
	`chunk_id` text PRIMARY KEY NOT NULL,
	`stream_name` text NOT NULL,
	`data` blob,
	`is_eof` integer DEFAULT 0,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_chunks_stream` ON `stream_chunks` (`stream_name`,`chunk_id`);