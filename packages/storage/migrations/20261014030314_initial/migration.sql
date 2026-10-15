CREATE TABLE `accounts` (
	`key` text PRIMARY KEY,
	`id` text NOT NULL UNIQUE,
	`settings_key` text NOT NULL,
	`object_key` text,
	`written` integer DEFAULT 0 NOT NULL,
	`settings_epoch` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`key` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`checked_at` integer
);
--> statement-breakpoint
CREATE INDEX `uploads_created_at_idx` ON `uploads` (`created_at`);