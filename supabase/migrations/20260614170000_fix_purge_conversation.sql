-- Fix purge/conversation cleanup to avoid direct Storage table deletion.
-- If an older database function still deletes storage.objects directly, this migration
-- replaces it with the safe application-side Storage API cleanup path.

CREATE OR REPLACE FUNCTION public.purge_conversation(_conv UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.messages WHERE conversation_id = _conv;
  DELETE FROM public.conversation_status WHERE conversation_id = _conv;
  DELETE FROM public.conversations WHERE id = _conv;
END $$;

CREATE OR REPLACE FUNCTION public.leave_conversation(_conv UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_both_left BOOLEAN;
BEGIN
  IF NOT public.is_conversation_participant(_conv, auth.uid()) THEN
    RAISE EXCEPTION 'not a participant';
  END IF;
  UPDATE public.conversation_status SET has_left = true, left_at = now()
    WHERE conversation_id = _conv AND user_id = auth.uid();
  SELECT bool_and(has_left) INTO v_both_left FROM public.conversation_status WHERE conversation_id = _conv;
  IF v_both_left THEN
    PERFORM public.purge_conversation(_conv);
    RETURN true;
  END IF;
  RETURN false;
END $$;
