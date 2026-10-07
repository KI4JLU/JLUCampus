-- Notify identifiers only; the listening server loads the current visible row.
CREATE FUNCTION notify_transcription_job() RETURNS trigger AS $$
DECLARE
  job transcription_job;
BEGIN
  IF TG_OP = 'UPDATE' AND
    (to_jsonb(NEW) - ARRAY['heartbeat_at', 'claimed_at', 'attempts']) =
    (to_jsonb(OLD) - ARRAY['heartbeat_at', 'claimed_at', 'attempts']) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN job := OLD; ELSE job := NEW; END IF;
  PERFORM pg_notify('transcription_events', json_build_object(
    'type', 'job', 'id', job.id, 'componentId', job.component_id, 'userId', job.user_id
  )::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER transcription_job_events
AFTER INSERT OR UPDATE OR DELETE ON transcription_job
FOR EACH ROW EXECUTE FUNCTION notify_transcription_job();
