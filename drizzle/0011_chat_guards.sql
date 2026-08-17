-- ---------------------------------------------------------------------------
-- Syncrese — team chat guards.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'channels', 'channel_members', 'messages',
    'message_mentions', 'message_refs', 'notifications'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I
         USING (organization_id = public.current_org_id())
         WITH CHECK (organization_id = public.current_org_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO syncrese_app', t);
  END LOOP;
END $$;

-- ===========================================================================
-- A message must come from a MEMBER of its channel.
--
-- Tenant isolation already stops cross-organization messaging, but it says
-- nothing about a colleague posting into a private channel they were never
-- added to. Enforcing membership here means no code path — a future API
-- endpoint, a bulk import, an automation — can post somewhere it should not.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.assert_channel_membership() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- System messages ("Anna joined the channel") have no author.
  IF NEW.is_system OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM channel_members m
     WHERE m.channel_id = NEW.channel_id
       AND m.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'SYNC_NOT_A_MEMBER (user is not a member of this channel)'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS messages_require_membership ON public.messages;
CREATE TRIGGER messages_require_membership
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.assert_channel_membership();

-- ===========================================================================
-- Only the author may edit a message, and only its text.
--
-- Rewriting who said something, when, or in which channel would make the
-- conversation unciteable — which matters here precisely because these messages
-- link to financial records.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.block_message_rewrite() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SYNC_APPEND_ONLY: messages are soft-deleted, not removed'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.user_id     IS DISTINCT FROM OLD.user_id
     OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
  THEN
    RAISE EXCEPTION 'SYNC_MESSAGE_IMMUTABLE (only the body may be edited)'
      USING ERRCODE = 'check_violation';
  END IF;

  -- An edit must say it is an edit.
  IF NEW.body IS DISTINCT FROM OLD.body AND NEW.edited_at IS NOT DISTINCT FROM OLD.edited_at THEN
    NEW.edited_at := now();
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS messages_immutable ON public.messages;
CREATE TRIGGER messages_immutable
  BEFORE UPDATE OR DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.block_message_rewrite();

REVOKE DELETE ON public.messages FROM syncrese_app;

-- ===========================================================================
-- Keep the channel's recency stamp current.
--
-- Denormalised so the channel list can be ordered without joining every
-- message; maintained by trigger so no write path can forget it.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.touch_channel_activity() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE channels SET last_message_at = NEW.created_at WHERE id = NEW.channel_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS messages_touch_channel ON public.messages;
CREATE TRIGGER messages_touch_channel
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.touch_channel_activity();
