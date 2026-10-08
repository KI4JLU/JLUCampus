ALTER TABLE "component" ADD COLUMN "name_translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Built-in components the admin has not renamed get the English names new installations start with.
UPDATE "component" SET "name_translations" = '{"en":"Translator"}'::jsonb
WHERE "singleton" AND "type" = 'translator' AND "name" = 'Übersetzer';--> statement-breakpoint
UPDATE "component" SET "name_translations" = '{"en":"Transcription"}'::jsonb
WHERE "singleton" AND "type" = 'transcription' AND "name" = 'Transkription';--> statement-breakpoint
UPDATE "component" SET "name_translations" = '{"en":"Files & drives"}'::jsonb
WHERE "singleton" AND "type" = 'files' AND "name" = 'Dateien & Laufwerke';
