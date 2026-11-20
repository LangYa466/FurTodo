CREATE TABLE "entities" (
	"user_id" bigint,
	"kind" text,
	"id" text,
	"data" jsonb NOT NULL,
	"clock" jsonb NOT NULL,
	"rev" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_via" text,
	"list_id" text,
	"due_date" date,
	"my_day" date,
	"completed_at" timestamp with time zone,
	"priority" integer,
	"quadrant" integer,
	CONSTRAINT "entities_pkey" PRIMARY KEY("user_id","kind","id")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"user_id" bigint,
	"endpoint" text,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"device" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY("user_id","endpoint")
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reminders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"task_id" text NOT NULL,
	"reminder_id" text NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY,
	"user_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"status" text NOT NULL,
	"code_challenge" text,
	"redirect_uri" text,
	"user_agent" text,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_days" (
	"user_id" bigint,
	"day" date,
	"requests" integer DEFAULT 0 NOT NULL,
	"reads" integer DEFAULT 0 NOT NULL,
	"writes" integer DEFAULT 0 NOT NULL,
	"logins" integer DEFAULT 0 NOT NULL,
	"pushes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_days_pkey" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY,
	"profile" jsonb NOT NULL,
	"sealed_github_token" text NOT NULL,
	"settings" jsonb NOT NULL,
	"eligibility_checked_at" timestamp with time zone NOT NULL,
	"eligibility_failed_at" timestamp with time zone,
	"last_stamp" timestamp with time zone NOT NULL,
	"purged_through" timestamp with time zone,
	"live_entity_count" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "entities_sync_idx" ON "entities" ("user_id","updated_at","kind","id");--> statement-breakpoint
CREATE INDEX "entities_list_idx" ON "entities" ("user_id","list_id");--> statement-breakpoint
CREATE INDEX "entities_trash_idx" ON "entities" ("deleted_at") WHERE ("deleted_at" is not null);--> statement-breakpoint
CREATE INDEX "reminders_fire_at_idx" ON "reminders" ("fire_at");--> statement-breakpoint
CREATE INDEX "reminders_task_idx" ON "reminders" ("user_id","task_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" ("user_id","last_used_at");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" ("expires_at");--> statement-breakpoint
CREATE INDEX "usage_days_day_idx" ON "usage_days" ("day");--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "usage_days" ADD CONSTRAINT "usage_days_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;