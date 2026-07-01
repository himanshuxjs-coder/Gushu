import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Eye, EyeOff, Timer, X, Check } from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerTrigger,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-mobile";

export type PrivacyOption = {
  disappearAfterView: boolean;
};

interface PrivacyOptionsPickerProps {
  value: PrivacyOption;
  onChange: (option: PrivacyOption) => void;
}

export function PrivacyOptionsPicker({ value, onChange }: PrivacyOptionsPickerProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  const hasOptions = value.disappearAfterView;
  const label = hasOptions ? "After view" : "Privacy";

  const content = (
    <div className="space-y-3 p-3">
      {/* Disappear After View */}
      <button
        onClick={() => onChange({
          ...value,
          disappearAfterView: !value.disappearAfterView,
        })}
        className={cn(
          "flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs transition-colors",
          value.disappearAfterView
            ? "bg-orange-500/10 text-orange-400"
            : "text-muted-foreground hover:bg-muted",
        )}
      >
        <div className="flex items-center gap-2">
          <Timer className="size-4" />
          <div className="text-left">
            <div className="font-medium">After Viewing</div>
            <div className="text-[10px] opacity-70">Deletes when opened</div>
          </div>
        </div>
        {value.disappearAfterView && <Check className="size-4" />}
      </button>

      {/* Clear button */}
      {hasOptions && (
        <button
          onClick={() => onChange({ disappearAfterView: false })}
          className="mt-2 w-full rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-destructive hover:text-destructive"
        >
          Clear privacy setting
        </button>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(
              "gap-1 h-8 px-2",
              hasOptions ? "text-amber-400" : "text-muted-foreground",
            )}
          >
            {hasOptions ? (
              <>
                <EyeOff className="size-3.5" />
                <span className="text-[10px] font-semibold uppercase">{label}</span>
              </>
            ) : (
              <Eye className="size-4" />
            )}
          </Button>
        </DrawerTrigger>
        <DrawerContent className="px-2 pb-4">
          <DrawerHeader className="sr-only">
            <DrawerTitle>Message Privacy Options</DrawerTitle>
          </DrawerHeader>
          <h3 className="px-3 pt-2 text-sm font-semibold text-foreground">Message Privacy</h3>
          {content}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn(
            "gap-1 h-8 px-2",
            hasOptions ? "text-amber-400" : "text-muted-foreground",
          )}
        >
          {hasOptions ? (
            <>
              <EyeOff className="size-3.5" />
              <span className="text-[10px] font-semibold uppercase">{label}</span>
            </>
          ) : (
            <Eye className="size-4" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-64 rounded-xl border border-border bg-popover/95 p-0 shadow-2xl backdrop-blur-xl"
      >
        <div className="border-b border-border p-3">
          <h3 className="text-sm font-semibold text-foreground">Message Privacy</h3>
        </div>
        {content}
      </PopoverContent>
    </Popover>
  );
}
