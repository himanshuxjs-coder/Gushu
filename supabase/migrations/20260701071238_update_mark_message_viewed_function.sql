-- Update mark_message_viewed function to remove view_count and view_limit references
CREATE OR REPLACE FUNCTION public.mark_message_viewed(_msg_id uuid, _viewer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  msg_rec RECORD;
BEGIN
  SELECT * INTO msg_rec FROM public.messages WHERE id = _msg_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Mark as viewed
  UPDATE public.messages
  SET viewed_at = COALESCE(viewed_at, NOW())
  WHERE id = _msg_id;

  -- If disappear_after_view flag is set and viewer is not sender, delete immediately
  IF msg_rec.disappear_after_view AND msg_rec.sender_id != _viewer_id THEN
    DELETE FROM public.message_reactions WHERE message_id = _msg_id;
    DELETE FROM public.message_deletions WHERE message_id = _msg_id;
    DELETE FROM public.messages WHERE id = _msg_id;
    RETURN;
  END IF;
END;
$function$;