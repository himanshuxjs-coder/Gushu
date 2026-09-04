import logoUrl from "@/assets/gushu-logo.png";
import { cn } from "@/lib/utils";

export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <img
      src={logoUrl}
      alt="Gushu"
      width={size}
      height={size}
      className={cn("select-none object-contain", className)}
      draggable={false}
      style={{ imageRendering: "auto" }}
    />
  );
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={cn("font-display tracking-tight", className)}>Gushu</span>;
}
