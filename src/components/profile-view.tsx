import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Avatar } from "@/components/avatar";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

interface ProfileViewProps {
  user: {
    id: string;
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    bio?: string | null;
    verified?: boolean;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProfileView({ user, open, onOpenChange }: ProfileViewProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[320px] overflow-hidden p-0 sm:rounded-3xl border-none bg-card shadow-2xl">
        <div className="relative flex flex-col p-6 items-center text-center gap-4">
          
          <div className="relative size-24 rounded-full border-4 border-muted">
            <Avatar
              name={user.display_name ?? user.username}
              url={user.avatar_url}
              size={96}
              className="size-full shadow-xl"
            />
          </div>

          <div className="space-y-1">
            <DialogTitle className="font-display text-2xl tracking-tight">
              {user.display_name ?? user.username}
            </DialogTitle>
            <DialogDescription className="text-xs uppercase tracking-widest text-muted-foreground">
              @{user.username}
            </DialogDescription>
          </div>

          <div className="w-full text-sm text-muted-foreground mt-2 opacity-100">
            {user.bio ? (
              <p className="px-2 leading-relaxed">{user.bio}</p>
            ) : (
              <p className="italic text-muted-foreground/50">No bio yet</p>
            )}
          </div>
          
          {/* Aesthetic Footer Decor */}
          <div className="mt-2 h-1 w-8 rounded-full bg-primary/20" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
