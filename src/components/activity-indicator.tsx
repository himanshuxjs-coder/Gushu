import { cn } from "@/lib/utils";

interface ActivityIndicatorProps {
  active: boolean;
  name?: string | null;
}

export function ActivityIndicator({ active, name }: ActivityIndicatorProps) {
  const label = name ? `${name} is viewing` : "Other user is viewing";

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-end px-4 transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] sm:px-8",
        active ? "max-h-12 opacity-100 py-1" : "max-h-0 opacity-0 py-0 overflow-hidden",
      )}
      aria-hidden={!active}
    >
      <div className="pointer-events-none flex items-center gap-1.5 rounded-2xl border border-border bg-card/90 px-3 py-1.5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] backdrop-blur-xl">
        <div className="flex w-full items-center gap-2 whitespace-nowrap text-[10px] font-semibold tracking-wider">
          <div className="flex items-center gap-1.5 text-emerald-500">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
            </span>
            <span className="opacity-80">{label}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
