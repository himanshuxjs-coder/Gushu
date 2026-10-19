import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full min-w-0 rounded-xl border border-input bg-background/70 px-3 py-2 text-base shadow-sm shadow-black/[0.02] transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-muted-foreground/80 focus-visible:outline-none focus-visible:border-ring/70 focus-visible:ring-4 focus-visible:ring-ring/10 disabled:cursor-not-allowed disabled:opacity-50 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
