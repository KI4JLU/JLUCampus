ALTER TABLE "session" ADD COLUMN "keycloak_refresh_token" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "keycloak_checked_at" timestamp;