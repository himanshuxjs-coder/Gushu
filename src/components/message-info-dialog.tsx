import { useState, useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import { formatTime, formatRelative } from "@/lib/format";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Clock, Check, CheckCheck, Send, Eye, Loader as Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface MessageInfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: {
    id: string;
    conversation_id: string;
    created_at: string;
    read_at: string | null;
    viewed_at?: string | null;
    first_read_at?: string | null;
    sender_id: string;
    is_optimistic?: boolean;
  } | null;
  meId: string;
}

export function MessageInfoDialog({ open, onOpenChange, message, meId }: MessageInfoDialogProps) {
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<{
    sentAt: Date;
    deliveredAt: Date | null;
    readAt: Date | null;
  } | null>(null);

  useEffect(() => {
    if (!message || !open) {
      setInfo(null);
      return;
    }

    setLoading(true);

    const sentAt = new Date(message.created_at);
    const readAt = message.read_at ? new Date(message.read_at) : null;
    const deliveredAt = message.first_read_at ? new Date(message.first_read_at) : null;

    setInfo({
      sentAt,
      deliveredAt,
      readAt,
    });
    setLoading(false);
  }, [message, open]);

  if (!message) return null;

  const isMine = message.sender_id === meId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-2xl bg-card border-border">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">Message Info</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : info ? (
            <>
              {/* Sent */}
              <div className="flex items-center gap-3">
                <div className="grid size-8 place-items-center rounded-full bg-muted">
                  <Send className="size-4 text-muted-foreground" />
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium">Sent</div>
                  <div className="text-xs text-muted-foreground">
                    {formatTime(info.sentAt.toISOString())} · {formatRelative(info.sentAt.toISOString())}
                  </div>
                </div>
                <Check className="size-4 text-muted-foreground" />
              </div>

              {/* Delivered */}
              <div className="flex items-center gap-3">
                <div className={cn(
                  "grid size-8 place-items-center rounded-full",
                  info.deliveredAt ? "bg-muted" : "bg-muted/50"
                )}>
                  <CheckCheck className={cn(
                    "size-4",
                    info.deliveredAt ? "text-muted-foreground" : "text-muted-foreground/50"
                  )} />
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium">Delivered</div>
                  {info.deliveredAt ? (
                    <div className="text-xs text-muted-foreground">
                      {formatTime(info.deliveredAt.toISOString())} · {formatRelative(info.deliveredAt.toISOString())}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground/60">Pending</div>
                  )}
                </div>
                {info.deliveredAt && <CheckCheck className="size-4 text-muted-foreground" />}
              </div>

              {/* Read */}
              {isMine && (
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "grid size-8 place-items-center rounded-full",
                    info.readAt ? "bg-primary/10" : "bg-muted/50"
                  )}>
                    <Eye className={cn(
                      "size-4",
                      info.readAt ? "text-primary" : "text-muted-foreground/50"
                    )} />
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium">Read</div>
                    {info.readAt ? (
                      <div className="text-xs text-muted-foreground">
                        {formatTime(info.readAt.toISOString())} · {formatRelative(info.readAt.toISOString())}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground/60">Not yet read</div>
                    )}
                  </div>
                  {info.readAt && <CheckCheck className="size-4 text-primary" />}
                </div>
              )}
            </>
          ) : null}
        </div>

        <div className="pt-2 border-t border-border/50">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="w-full"
          >
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
