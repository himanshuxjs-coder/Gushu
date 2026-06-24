-- Add foreign key constraint for message attribution
ALTER TABLE public.messages
DROP CONSTRAINT IF EXISTS fk_messages_deleted_by;

ALTER TABLE public.messages
ADD CONSTRAINT fk_messages_deleted_by
FOREIGN KEY (deleted_by_id)
REFERENCES public.profiles(id)
ON DELETE SET NULL;
