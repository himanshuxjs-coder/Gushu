/*
# Fix Message Stability and Performance

## Problem
Messages were randomly disappearing during long conversations due to:
1. `tg_set_message_expiry` trigger fires on EVERY UPDATE to messages, forcing
   `expires_at = NULL`. This undoes the expiry set by `mark_conversation_read`
   when a message is marked as read — causing read messages to lose their
   expiry, then get incorrectly included/excluded by the expires_at filter.
2. Missing index on `messages(conversation_id, created_at DESC)` — the main
   query used by listMessages was doing a full scan + sort.
3. `mark_conversation_read` had a fragile interval construction
   `(v_expiry_seconds || ' seconds')::interval` that could fail.

## Changes

### 1. Fix `tg_set_message_expiry` trigger
- Only set `expires_at = NULL` on INSERT (new messages), NOT on UPDATE.
- On UPDATE, preserve the existing `expires_at` value so read-receipts and
  other updates don't wipe the disappearing-message timer.

### 2. Add performance indexes
- `messages_conversation_created_idx` on `(conversation_id, created_at DESC)`
  — speeds up the main message list query (now DESC + limit).
- `message_deletions_user_msg_idx` on `(user_id, message_id)` — speeds up
  the "deleted for me" lookup in listMessages.
- `message_saves_user_conv_idx` on `(user_id, conversation_id)` — speeds up
  saved-message filtering.

### 3. Fix `mark_conversation_read` interval construction
- Use `make_interval(secs => v_expiry_seconds)` instead of string concat
  to avoid any type-coercion edge cases.

### 4. Fix `mark_message_viewed` interval construction
- Same make_interval fix.

### 5. Add `last_message_at` trigger safety
- The `tg_bump_conversation` trigger already exists; ensure it only bumps
  on INSERT (not UPDATE/DELETE) to prevent conversation reordering.
*/

-- =========================================================
-- 1. Fix tg_set_message_expiry: only NULL on INSERT, preserve on UPDATE
-- =========================================================
CREATE OR REPLACE FUNCTION public.tg_set_message_expiry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- New messages start with no expiry; it's set later when read (if enabled)
    NEW.expires_at := NULL;
  ELSEIF TG_OP = 'UPDATE' THEN
    -- On UPDATE, preserve the existing expires_at so read-receipts / edits
    -- don't accidentally wipe a disappearing-message timer that was already set.
    NEW.expires_at := OLD.expires_at;
  END IF;
  RETURN NEW;
END;
$$;

-- =========================================================
-- 2. Performance indexes (idempotent via IF NOT EXISTS)
-- =========================================================
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON public.messages (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS message_deletions_user_msg_idx
  ON public.message_deletions (user_id, message_id);

CREATE INDEX IF NOT EXISTS message_saves_user_conv_idx
  ON public.message_saves (user_id, conversation_id);

CREATE INDEX IF NOT EXISTS messages_not_deleted_idx
  ON public.messages (conversation_id, created_at DESC)
  WHERE deleted_for_all = false;

CREATE INDEX IF NOT EXISTS messages_expires_at_idx
  ON public.messages (expires_at)
  WHERE expires_at IS NOT NULL;

-- =========================================================
-- 3. Fix mark_conversation_read interval construction
-- =========================================================
CREATE OR REPLACE FUNCTION public.mark_conversation_read(_conv_id uuid, _viewer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_expiry_seconds INT;
  v_now TIMESTAMPTZ := NOW();
  msg RECORD;
BEGIN
  SELECT expiry_seconds INTO v_expiry_seconds
  FROM public.conversations WHERE id = _conv_id;

  FOR msg IN
    SELECT id, sender_id, expires_at, first_read_at
    FROM public.messages
    WHERE conversation_id = _conv_id
      AND sender_id <> _viewer_id
      AND (read_at IS NULL OR viewed_at IS NULL)
  LOOP
    INSERT INTO public.message_user_views (message_id, user_id, viewed_at)
    VALUES (msg.id, _viewer_id, v_now)
    ON CONFLICT (message_id, user_id) DO UPDATE SET viewed_at = LEAST(message_user_views.viewed_at, EXCLUDED.viewed_at);

    UPDATE public.messages
    SET viewed_at = COALESCE(viewed_at, v_now),
        read_at = COALESCE(read_at, v_now),
        first_read_at = COALESCE(first_read_at, v_now)
    WHERE id = msg.id;

    IF v_expiry_seconds IS NOT NULL AND v_expiry_seconds > 0 AND msg.expires_at IS NULL THEN
      UPDATE public.messages
      SET expires_at = COALESCE(first_read_at, v_now) + make_interval(secs => v_expiry_seconds)
      WHERE id = msg.id AND expires_at IS NULL;
    END IF;
  END LOOP;
END;
$$;

-- =========================================================
-- 4. Fix mark_message_viewed interval construction
-- =========================================================
CREATE OR REPLACE FUNCTION public.mark_message_viewed(_msg_id uuid, _viewer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  msg_rec RECORD;
  v_expiry_seconds INT;
  v_now TIMESTAMPTZ := NOW();
  v_first_view TIMESTAMPTZ;
BEGIN
  SELECT * INTO msg_rec FROM public.messages WHERE id = _msg_id;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.message_user_views (message_id, user_id, viewed_at)
  VALUES (_msg_id, _viewer_id, v_now)
  ON CONFLICT (message_id, user_id) DO UPDATE SET viewed_at = LEAST(message_user_views.viewed_at, EXCLUDED.viewed_at);

  IF msg_rec.sender_id = _viewer_id THEN RETURN; END IF;

  UPDATE public.messages
  SET viewed_at = COALESCE(viewed_at, v_now),
      read_at = COALESCE(read_at, v_now),
      first_read_at = COALESCE(first_read_at, v_now)
  WHERE id = _msg_id AND (read_at IS NULL OR viewed_at IS NULL);

  SELECT expiry_seconds INTO v_expiry_seconds
  FROM public.conversations WHERE id = msg_rec.conversation_id;

  IF v_expiry_seconds IS NOT NULL AND v_expiry_seconds > 0 AND msg_rec.expires_at IS NULL THEN
    SELECT first_read_at INTO v_first_view FROM public.messages WHERE id = _msg_id;
    UPDATE public.messages
    SET expires_at = COALESCE(v_first_view, v_now) + make_interval(secs => v_expiry_seconds)
    WHERE id = _msg_id AND expires_at IS NULL;
  END IF;
END;
$$;

-- =========================================================
-- 5. Ensure tg_bump_conversation only fires on INSERT
-- =========================================================
CREATE OR REPLACE FUNCTION public.tg_bump_conversation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Only bump last_message_at on new message inserts, not on edits/deletes
  IF TG_OP = 'INSERT' THEN
    UPDATE public.conversations
    SET last_message_at = NEW.created_at
    WHERE id = NEW.conversation_id
      AND (last_message_at IS NULL OR last_message_at < NEW.created_at);
  END IF;
  RETURN NEW;
END;
$$;
