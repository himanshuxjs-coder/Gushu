import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/format";

interface ActivityIndicatorProps {
  active: boolean;
  lastSeen?: string | null;
}

export function ActivityIndicator({ active, lastSeen }: ActivityIndicatorProps) {
  const label = active ? "Online" : lastSeen ? `Last seen ${formatRelative(lastSeen)}` : "Offline";

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-end px-4 transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] sm:px-8",
        active || lastSeen ? "max-h-14 opacity-100 py-1.5" : "max-h-0 opacity-0 py-0 overflow-hidden",
      )}
      aria-hidden={!active && !lastSeen}
    >
      <div className="pointer-events-none flex items-center gap-2 rounded-md border border-border bg-card/90 px-4 py-2 shadow-[0_8px_30px_rgb(0,0,0,0.12)] backdrop-blur-xl">
        <div className="flex w-full items-center gap-2 whitespace-nowrap text-[11px] font-semibold tracking-wider">
          <div className="flex items-center gap-2 text-emerald-500">
            <span className="relative flex size-2">
              <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-75", active ? "animate-ping bg-emerald-400" : "bg-muted-foreground/50")} />
              <span className={cn("relative inline-flex size-2 rounded-full", active ? "bg-emerald-500" : "bg-muted-foreground")} />
            </span>
            <span className="text-foreground opacity-80">{label}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
