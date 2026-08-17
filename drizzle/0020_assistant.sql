-- ---------------------------------------------------------------------------
-- Syncrese — AI assistant conversations (MUST DO #12).
--
-- THE POINT OF THIS SCHEMA IS THE AUDIT TRAIL.
--
-- `retrieved_query` stores the catalogue entry that ran and the parameters it
-- ran with; `result_row_count` stores what came back. Together they mean that
-- for any figure the assistant ever stated, you can reconstruct exactly which
-- rows of this tenant's data it was summarising.
--
-- In a finance product that is not a nice-to-have. An assistant that says
-- "you are owed 47,300" is either quoting the ledger or making it up, and from
-- the outside those look identical. This is what makes the difference
-- provable after the fact, and it is why the column is NOT NULL for any
-- assistant message that carries an answer.
--
-- The assistant runs every query AS THE ASKING USER, through the same tenant
-- transaction and the same permission checks as the UI. It has no privileged
-- data path, so RLS and RBAC are inherited rather than reimplemented — there is
-- no second place for a tenant-isolation bug to hide.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.assistant_conversations (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  /**
   * Whose conversation this is.
   *
   * Scoped per USER, not per organization: the assistant answers under the
   * asker's permissions, so one member's thread may contain figures a colleague
   * is not entitled to see. Sharing threads across a workspace would leak
   * exactly what the permission check was there to prevent.
   */
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  title           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz
);

CREATE INDEX IF NOT EXISTS assistant_conversations_org_user_idx
  ON public.assistant_conversations (organization_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.assistant_messages (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL
    REFERENCES public.assistant_conversations(id) ON DELETE CASCADE,

  /** 'user' or 'assistant'. */
  role            text NOT NULL,
  content         text NOT NULL,

  /**
   * Which catalogue entries ran, with what parameters.
   *
   * An array, because one question can need more than one lookup. Shape:
   *   [{ "query": "invoices.outstanding", "params": {...}, "rows": 12 }]
   *
   * There is no free-form SQL anywhere in this feature — the model chooses a
   * NAME from a closed catalogue and fills in typed parameters. So this column
   * records a decision, not a statement to be re-run, and it cannot contain
   * anything the application did not itself construct.
   */
  retrieved_query jsonb,

  /** Total rows across those retrievals. Denormalised from `retrieved_query`
   *  so "did this answer touch any data at all?" is an index scan, not a jsonb
   *  traversal over every message the workspace has ever sent. */
  result_row_count integer,

  /**
   * Whether the drafted answer passed the numeric grounding check — every
   * figure in it traced back to a retrieved row. False means it did not and the
   * user was shown a refusal instead of the draft.
   *
   * Recorded because a rising count here is the early warning that the model,
   * the catalogue or the prompt has drifted, and it is invisible otherwise.
   */
  grounded        boolean,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assistant_messages_role CHECK (role IN ('user', 'assistant'))
);

CREATE INDEX IF NOT EXISTS assistant_messages_conversation_idx
  ON public.assistant_messages (conversation_id, created_at);

-- Ungrounded answers, cheaply. This is the drift alarm, so it must stay cheap
-- enough that somebody actually runs it.
CREATE INDEX IF NOT EXISTS assistant_messages_ungrounded_idx
  ON public.assistant_messages (organization_id, created_at DESC)
  WHERE grounded = false;

ALTER TABLE public.assistant_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_conversations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.assistant_conversations;
CREATE POLICY tenant_isolation ON public.assistant_conversations
  USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

ALTER TABLE public.assistant_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.assistant_messages;
CREATE POLICY tenant_isolation ON public.assistant_messages
  USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_conversations TO syncrese_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assistant_messages      TO syncrese_app;

-- Migration 0019 gave the SECURITY DEFINER functions their own owner and each
-- policed table an exemption policy for it. These two tables were created
-- afterwards, so they need the same treatment or a definer function added later
-- would silently read nothing from them. Kept idempotent and driven from the
-- catalogue, exactly as 0019 does it.
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syncrese_definer') THEN
    FOR t IN SELECT unnest(ARRAY['assistant_conversations', 'assistant_messages']) LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO syncrese_definer', t);
      EXECUTE format('DROP POLICY IF EXISTS definer_access ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY definer_access ON public.%I TO syncrese_definer USING (true) WITH CHECK (true)',
        t);
    END LOOP;
  END IF;
END $$;
