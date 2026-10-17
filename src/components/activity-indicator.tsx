import { memo } from "react";
import { cn } from "@/lib/utils";

interface ActivityIndicatorProps {
  active: boolean;
  name?: string | null;
  label?: string;
  className?: string;
}

export const ActivityIndicator = memo(function ActivityIndicator({ active, name, label, className }: ActivityIndicatorProps) {
  const displayLabel = label ?? "Lalalala 😙";

  return (
    <div
      className={cn(
        "grid w-max transition-[grid-template-rows,opacity,transform] duration-200 ease-out",
        active
          ? "grid-rows-[1fr] opacity-100"
          : "grid-rows-[0fr] opacity-0 pointer-events-none",
        className,
      )}
      aria-live="polite"
      aria-hidden={!active}
    >
      <div className="flex items-center justify-end overflow-hidden">
        <div
          className={cn(
            "pointer-events-none flex min-h-9 items-center gap-2.5 rounded-md border border-border/70 border-l-2 border-l-emerald-400/80 bg-background/80 px-3.5 py-2 text-foreground shadow-sm dark:bg-background/70",
            "transition-all duration-200 ease-out transform-gpu",
            active
              ? "translate-y-0 scale-100 opacity-100 blur-0"
              : "translate-y-2 scale-95 opacity-0 blur-[1px]",
          )}
        >
          {/* Animated Glowing Presence Radar Dot */}
          <span className="relative flex size-2.5 items-center justify-center">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400/45 duration-1000" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]" />
          </span>

          <span className="whitespace-nowrap text-[11px] font-medium tracking-wide text-foreground/85 select-none">
            {displayLabel}
          </span>
        </div>
      </div>
    </div>
  );
});


