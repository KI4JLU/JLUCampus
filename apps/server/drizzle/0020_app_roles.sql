CREATE TABLE "app_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"built_in" text,
	"name" text NOT NULL,
	"keycloak_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"keycloak_groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_role_built_in_unique" UNIQUE("built_in")
);
--> statement-breakpoint
CREATE TABLE "app_role_component" (
	"role_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	CONSTRAINT "app_role_component_role_id_component_id_pk" PRIMARY KEY("role_id","component_id")
);
--> statement-breakpoint
CREATE TABLE "app_role_member" (
	"role_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_role_member_role_id_user_id_pk" PRIMARY KEY("role_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "app_role_component" ADD CONSTRAINT "app_role_component_role_id_app_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."app_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_role_component" ADD CONSTRAINT "app_role_component_component_id_component_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."component"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_role_member" ADD CONSTRAINT "app_role_member_role_id_app_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."app_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_role_member" ADD CONSTRAINT "app_role_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_role_component_component_id_idx" ON "app_role_component" USING btree ("component_id");--> statement-breakpoint
CREATE INDEX "app_role_member_user_id_idx" ON "app_role_member" USING btree ("user_id");--> statement-breakpoint
INSERT INTO "app_role" ("built_in", "name", "features") VALUES
  ('everyone', 'Alle Nutzenden', '["translator.documents","translator.rephrase","translator.compose","translator.glossaries","transcription.live","transcription.summaries"]'::jsonb),
  ('admin', 'Admin', '[]'::jsonb);
--> statement-breakpoint
INSERT INTO "app_role_component" ("role_id", "component_id")
SELECT r.id, c.id FROM "app_role" r CROSS JOIN "component" c WHERE r.built_in = 'everyone';
--> statement-breakpoint
INSERT INTO "app_role_member" ("role_id", "user_id")
SELECT r.id, u.id FROM "app_role" r CROSS JOIN "user" u WHERE r.built_in = 'admin' AND u.role = 'admin';
--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "role";