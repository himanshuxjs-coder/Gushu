import { cn } from "@/lib/utils";

interface ActivityIndicatorProps {
  active: boolean;
  name?: string | null;
}

export function ActivityIndicator({ active }: ActivityIndicatorProps) {
  const label = "Lalalala😙";

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-end px-4 transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] sm:px-8",
        active ? "max-h-14 opacity-100 py-1.5" : "max-h-0 opacity-0 py-0 overflow-hidden",
      )}
      aria-hidden={!active}
    >   
      <div className="pointer-events-none flex items-center gap-2 rounded-md border border-border bg-card/90 px-4 py-2 shadow-[0_8px_30px_rgb(0,0,0,0.12)] backdrop-blur-xl">
        <div className="flex w-full items-center gap-2 whitespace-nowrap text-[11px] font-semibold tracking-wider">
          <div className="flex items-center gap-2 text-emerald-500">
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            <span className="opacity-80">{label}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
