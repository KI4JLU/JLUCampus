CREATE TABLE "transcription_format" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"speakers" boolean NOT NULL,
	"timestamps" boolean NOT NULL,
	"avatars" boolean NOT NULL,
	"bubbles" boolean NOT NULL,
	"anonymize" boolean NOT NULL,
	"order" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcription_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"group_id" uuid,
	"group_order" integer DEFAULT 0 NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text DEFAULT '' NOT NULL,
	"size" bigint NOT NULL,
	"duration" double precision,
	"object_key" text NOT NULL,
	"normalized_key" text,
	"status" text DEFAULT 'uploading' NOT NULL,
	"settings" jsonb NOT NULL,
	"speakers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snippets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"colors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress" jsonb,
	"result" jsonb,
	"error" jsonb,
	"upstream_job_id" text,
	"transcript_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp,
	"heartbeat_at" timestamp,
	"cancel_requested_at" timestamp,
	"uploaded_at" timestamp,
	"completed_at" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "transcription_summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"transcript_id" uuid NOT NULL,
	"kind" text DEFAULT 'summary' NOT NULL,
	"template_id" text NOT NULL,
	"template_version" integer NOT NULL,
	"transcript_revision" integer NOT NULL,
	"model" text,
	"settings_hash" text NOT NULL,
	"markdown" text,
	"sections" jsonb,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "transcription_template" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"component_id" uuid NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"structure" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"output_format_hints" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcription_transcript" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"subtitle_source" text,
	"language" text,
	"duration" double precision,
	"model" text,
	"provider" text,
	"original_filename" text,
	"file_size" bigint,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"source_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"speaker_colors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary_template_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"user_locale" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "transcription_format" ADD CONSTRAINT "transcription_format_component_id_component_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."component"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_format" ADD CONSTRAINT "transcription_format_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_job" ADD CONSTRAINT "transcription_job_component_id_component_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."component"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_job" ADD CONSTRAINT "transcription_job_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_job" ADD CONSTRAINT "transcription_job_transcript_id_transcription_transcript_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcription_transcript"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_summary" ADD CONSTRAINT "transcription_summary_component_id_component_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."component"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_summary" ADD CONSTRAINT "transcription_summary_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_summary" ADD CONSTRAINT "transcription_summary_transcript_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcription_transcript"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_template" ADD CONSTRAINT "transcription_template_component_id_component_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."component"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_template" ADD CONSTRAINT "transcription_template_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_transcript" ADD CONSTRAINT "transcription_transcript_component_id_component_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."component"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_transcript" ADD CONSTRAINT "transcription_transcript_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcription_format_user_idx" ON "transcription_format" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transcription_job_user_created_idx" ON "transcription_job" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "transcription_job_status_claimed_idx" ON "transcription_job" USING btree ("status","claimed_at");--> statement-breakpoint
CREATE INDEX "transcription_job_expires_idx" ON "transcription_job" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "transcription_job_transcript_idx" ON "transcription_job" USING btree ("transcript_id");--> statement-breakpoint
CREATE INDEX "transcription_summary_transcript_template_idx" ON "transcription_summary" USING btree ("transcript_id","template_id","kind");--> statement-breakpoint
CREATE INDEX "transcription_summary_expires_idx" ON "transcription_summary" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "transcription_template_component_user_idx" ON "transcription_template" USING btree ("component_id","user_id");--> statement-breakpoint
CREATE INDEX "transcription_transcript_user_updated_idx" ON "transcription_transcript" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "transcription_transcript_expires_idx" ON "transcription_transcript" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transcription_transcript_user_idempotency_uidx" ON "transcription_transcript" USING btree ("user_id","idempotency_key");