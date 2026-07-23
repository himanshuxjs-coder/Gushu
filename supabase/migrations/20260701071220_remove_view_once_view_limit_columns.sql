-- Remove view_once and view_limit columns from messages table
-- These features have been deprecated and removed from the UI/backend

ALTER TABLE public.messages DROP COLUMN IF EXISTS view_once;
ALTER TABLE public.messages DROP COLUMN IF EXISTS view_limit;
ALTER TABLE public.messages DROP COLUMN IF EXISTS view_count;