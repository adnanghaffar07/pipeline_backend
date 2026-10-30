ALTER TABLE "profiles" ADD COLUMN "avatar_path" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "company" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "job_title" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "linkedin_url" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "facebook_url" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "instagram_url" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "website_url" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "expertise_areas" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "notifications_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "theme_preference" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "share_contact_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "share_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "share_phone" boolean DEFAULT false NOT NULL;