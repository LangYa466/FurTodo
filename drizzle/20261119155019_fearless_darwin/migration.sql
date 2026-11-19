CREATE TABLE `account` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`profile` text NOT NULL,
	`eligibility_checked_at` integer NOT NULL,
	`sealed_github_token` text NOT NULL,
	`settings` text NOT NULL,
	`committed_stamp` integer NOT NULL,
	`live_entity_count` integer NOT NULL,
	`pruned_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`type` text NOT NULL,
	`ref` text NOT NULL,
	`payload` text NOT NULL,
	`run_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`key` text PRIMARY KEY,
	`updated_at` integer NOT NULL,
	`metadata` text NOT NULL,
	`body` text NOT NULL,
	`written_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`endpoint` text PRIMARY KEY,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`device` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reminders` (
	`task_id` text NOT NULL,
	`reminder_id` text NOT NULL,
	`fire_at` integer NOT NULL,
	`payload` text,
	CONSTRAINT `reminders_pk` PRIMARY KEY(`task_id`, `reminder_id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`name` text,
	`status` text NOT NULL,
	`code_challenge` text,
	`redirect_uri` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_days` (
	`day` text PRIMARY KEY,
	`counts` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_run_at` ON `jobs` (`run_at`);--> statement-breakpoint
CREATE INDEX `journal_entries_updated_at` ON `journal_entries` (`updated_at`);--> statement-breakpoint
CREATE INDEX `journal_entries_written_at` ON `journal_entries` (`written_at`);--> statement-breakpoint
CREATE INDEX `reminders_fire_at` ON `reminders` (`fire_at`);