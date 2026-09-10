import { cn } from "@/lib/utils";

/**
 * Shows an animated typing indicator (three dots)
 */
export function TypingIndicator({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-1", className)}>

      <div className="flex gap-0.5">
        <span className="inline-block size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "0ms" }} />
        <span className="inline-block size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "100ms" }} />
        <span className="inline-block size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "200ms" }} />
      </div>
    </div>
  );
}

/**
 * Shows a chat bubble indicator when user is typing (appears above message input)
 */
export function TypingBubble() {
  return (
    <div className="flex items-end gap-2 px-4 py-2">
      <div className="flex h-8 w-12 items-center justify-center rounded-full bg-muted">
        <div className="flex gap-1">
          <span className="inline-block size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "0ms" }} />
          <span className="inline-block size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "100ms" }} />
          <span className="inline-block size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "200ms" }} />
        </div>
      </div>
    </div>
  );
}

/**
 * Ghost bubble showing the other user's draft text in real-time.
 * Renders at reduced opacity without timestamp or read receipts.
 * Only shown when at least one conversation participant is verified.
 */
export function DraftBubble({ text }: { text: string }) {
  if (!text) return null;

  return (
    <div
      className="flex items-end gap-2 py-1 animate-in fade-in duration-200"
      aria-label="Draft preview"
    >
      <div className="max-w-[75%] md:max-w-[70%]">
        <div
          className={cn(
            "relative inline-block rounded-2xl rounded-tl-md px-4 py-2.5 text-sm leading-relaxed shadow-sm ring-1",
            "bg-muted text-foreground ring-border",
            "opacity-50",
          )}
        >
          <p className="whitespace-pre-wrap break-all italic" style={{ overflowWrap: "anywhere" }}>
            {text}
          </p>
          {/* Small pulsing dot to indicate it's a live draft */}
          <span className="absolute -right-1.5 -top-1.5 flex size-3 items-center justify-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/50 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-primary/70" />
          </span>
        </div>
      </div>
    </div>
  );
}
