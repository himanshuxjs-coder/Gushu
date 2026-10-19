import { useEffect, useRef, useState, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useNavigate } from "@tanstack/react-router";
import { Search, Loader as Loader2, Lock, Eye, KeyRound } from "lucide-react";
import { searchUsers } from "@/lib/profiles.functions";
import { getOrCreateConversation, checkConversationAccess } from "@/lib/conversations.functions";
import { findHiddenChatByCode, verifyConversationSecretCode } from "@/lib/conversation-settings.functions";
import { Avatar } from "@/components/avatar";
import { ProfileView } from "@/components/profile-view";
import { VerifiedBadge } from "@/components/verified-badge";
import { Input } from "@/components/ui/input";
import { useHiddenStore } from "@/lib/hidden-store";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type R = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  verified: boolean;
};

export function UserSearch() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<R[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [open, setOpen] = useState(false);
  const [codeMatch, setCodeMatch] = useState<{ conversationId: string } | null>(null);
  const [secretCodePrompt, setSecretCodePrompt] = useState<{ user: R; conversationId: string } | null>(null);
  const [secretCodeInput, setSecretCodeInput] = useState("");
  const [verifying, setVerifying] = useState(false);
  const search = useServerFn(searchUsers);
  const create = useServerFn(getOrCreateConversation);
  const checkAccess = useServerFn(checkConversationAccess);
  const findHidden = useServerFn(findHiddenChatByCode);
  const verifySecret = useServerFn(verifyConversationSecretCode);
  const navigate = useNavigate();
  const unlockHidden = useHiddenStore((s: any) => s.unlock);
  const ref = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const searchCacheRef = useRef(new Map<string, { results: R[]; savedAt: number }>());
  const [profileOpen, setProfileOpen] = useState(false);
  const [fullProfile, setFullProfile] = useState<any>(null);

  const openProfile = useCallback(async (user: R) => {
    setProfileOpen(true);
    try {
      const { data } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url, bio, verified")
        .eq("id", user.id)
        .maybeSingle();
      if (data) setFullProfile(data);
    } catch {}
  }, []);

  useEffect(() => {
    const term = q.trim();
    const requestId = ++requestIdRef.current;

    setCodeMatch(null);
    setSearchError(false);
    if (!term) {
      setResults([]);
      setLoading(false);
      return;
    }

    // Keep recent username results in memory so revisiting a query feels instant.
    // Secret-code matches are deliberately never cached.
    const cached = searchCacheRef.current.get(term);
    const cacheIsFresh = !!cached && Date.now() - cached.savedAt < 30_000;
    if (cacheIsFresh) {
      setResults(cached.results);
      setLoading(false);
    }

    const timer = setTimeout(async () => {
      if (!cacheIsFresh) setLoading(true);
      setCodeMatch(null);

      const searchPromise = cacheIsFresh
        ? Promise.resolve(cached!.results)
        : search({ data: { q: term } });
      const hiddenPromise = term.length >= 4
        ? findHidden({ data: { code: term } }).catch(() => null)
        : Promise.resolve(null);

      const [searchResult, hidden] = await Promise.allSettled([searchPromise, hiddenPromise]);
      if (requestId !== requestIdRef.current) return;

      if (searchResult.status === "fulfilled") {
        const found = searchResult.value;
        setSearchError(false);
        setResults(found);
        searchCacheRef.current.set(term, { results: found, savedAt: Date.now() });
        if (searchCacheRef.current.size > 20) {
          const oldestKey = searchCacheRef.current.keys().next().value;
          if (oldestKey) searchCacheRef.current.delete(oldestKey);
        }
      } else {
        setSearchError(true);
      }

      if (hidden.status === "fulfilled" && hidden.value?.found && hidden.value.conversationId) {
        setCodeMatch({ conversationId: hidden.value.conversationId });
      }

      setLoading(false);
    }, 180);

    return () => clearTimeout(timer);
  }, [q, search, findHidden]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function start(user: R) {
    try {
      const { id } = await create({ data: { otherUserId: user.id } });

      // Check if this conversation requires a secret code
      const access = await checkAccess({ data: { conversationId: id } });

      if (access.requiresSecretCode) {
        // Block access - require secret code
        setSecretCodePrompt({ user, conversationId: id });
        setOpen(false);
        return;
      }

      setQ("");
      setOpen(false);
      navigate({ to: "/app/c/$conversationId", params: { conversationId: id } });
    } catch (e: any) {
      toast.error(e?.message ?? "Could not start chat");
    }
  }

  function openHiddenChat(conversationId: string) {
    setQ("");
    setOpen(false);
    setCodeMatch(null);
    unlockHidden(conversationId);
    navigate({ to: "/app/c/$conversationId", params: { conversationId } });
    toast.success("Hidden chat unlocked");
  }

  async function handleSecretCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!secretCodePrompt || !secretCodeInput.trim()) return;
    setVerifying(true);
    try {
      const { valid } = await verifySecret({
        data: { conversationId: secretCodePrompt.conversationId, code: secretCodeInput.trim() },
      });
      if (valid) {
        setSecretCodePrompt(null);
        setSecretCodeInput("");
        unlockHidden(secretCodePrompt.conversationId);
        navigate({ to: "/app/c/$conversationId", params: { conversationId: secretCodePrompt.conversationId } });
        toast.success("Hidden chat unlocked");
      } else {
        toast.error("Incorrect secret code");
      }
    } catch (err: any) {
      toast.error(err?.message ?? "Verification failed");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <>
      <div ref={ref} className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="..........😁"
          className="h-9 rounded-full bg-muted/40 pl-9 text-xs ring-1 ring-border focus-visible:ring-foreground/30"
        />
        {open && q.trim() && (
          <div className="animate-in-scale absolute left-0 right-0 top-full z-[100] mt-2 max-h-80 overflow-y-auto rounded-2xl border border-border/80 bg-popover/95 p-2 text-popover-foreground shadow-[0_20px_50px_-20px_color-mix(in_srgb,var(--foreground),transparent_35%)] backdrop-blur-xl">
            {loading && (
              <div className="flex items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                <span>Finding people</span>
              </div>
            )}
            {!loading && searchError && (
              <div className="p-5 text-center text-xs text-muted-foreground" role="status">
                <Search className="mx-auto mb-2 size-4 opacity-50" />
                Search is temporarily unavailable. Check your connection and try again.
              </div>
            )}
            {!loading && !searchError && results.length === 0 && !codeMatch && (
              <div className="p-5 text-center text-xs text-muted-foreground" role="status">
                <Search className="mx-auto mb-2 size-4 opacity-50" />
                No matching people found
              </div>
            )}
            {codeMatch && (
              <button
                onClick={() => openHiddenChat(codeMatch.conversationId)}
                className="interactive-row flex w-full items-center gap-3 rounded-xl bg-amber-500/10 p-2.5 text-left ring-1 ring-amber-500/30"
              >
                <div className="flex size-8 items-center justify-center rounded-full bg-amber-500/20">
                  <Lock className="size-4 text-amber-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Eye className="size-3 text-amber-500" />
                    <span className="truncate text-sm font-medium text-amber-600 dark:text-amber-400">
                      Unlock Hidden Chat
                    </span>
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    Secret code matched
                  </div>
                </div>
              </button>
            )}
            {results.map((u, idx) => (
              <div
                key={u.id}
                className={cn(
                  "interactive-row flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition-colors hover:bg-muted/70 group animate-in-fade",
                  idx < 5 && `stagger-${idx + 1}`,
                )}
              >
                <button
                  type="button"
                  className="shrink-0 rounded-full transition-transform duration-200 hover:scale-[1.04] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  onClick={() => openProfile(u)}
                  aria-label={`View ${u.display_name ?? u.username}'s profile`}
                >
                  <Avatar name={u.display_name ?? u.username} url={u.avatar_url} size={32} />
                </button>
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-lg px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => void start(u)}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {u.display_name ?? u.username}
                    </span>
                    {u.verified && <VerifiedBadge size={12} />}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground group-hover:text-primary transition-colors">@{u.username}</div>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {fullProfile && (
        <ProfileView
          user={fullProfile}
          open={profileOpen}
          onOpenChange={setProfileOpen}
        />
      )}

      {/* Secret Code Prompt Modal */}
      {secretCodePrompt && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl">
            <div className="mb-4 flex items-center gap-2">
              <KeyRound className="size-5 text-amber-400" />
              <h3 className="font-display text-lg text-foreground">Secret Code Required</h3>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              This chat is protected with a secret code. Enter it to access the conversation.
            </p>
            <form onSubmit={handleSecretCodeSubmit} className="space-y-3">
              <Input
                type="text"
                value={secretCodeInput}
                onChange={(e) => setSecretCodeInput(e.target.value)}
                placeholder="Enter secret code"
                className="h-10 bg-muted/40 border-border text-foreground"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setSecretCodePrompt(null); setSecretCodeInput(""); }}
                  className="flex-1 rounded-xl bg-muted py-2.5 text-sm text-muted-foreground hover:bg-muted/80 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={verifying || !secretCodeInput.trim()}
                  className="flex-1 rounded-xl bg-foreground py-2.5 text-sm font-medium text-background hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {verifying ? <Loader2 className="mx-auto size-4 animate-spin" /> : "Unlock"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
