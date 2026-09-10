import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

type Theme = "light" | "dark";

function getInitial(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem("gushu-theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitial);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    localStorage.setItem("gushu-theme", theme);
  }, [theme]);

  // Sync the preference to the signed-in account so it follows the user across devices.
  useEffect(() => {
    let cancelled = false;

    const loadAccountTheme = async () => {
      const { data } = await supabase.auth.getUser();
      const accountTheme = data.user?.user_metadata?.gushu_theme;
      if (!cancelled && (accountTheme === "light" || accountTheme === "dark")) {
        setTheme(accountTheme);
      }
    };

    void loadAccountTheme();
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" || event === "USER_UPDATED") {
        const accountTheme = session?.user.user_metadata?.gushu_theme;
        if (accountTheme === "light" || accountTheme === "dark") setTheme(accountTheme);
      }
      if (event === "SIGNED_OUT") setTheme(getInitial());
    });

    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
    };
  }, []);

  const setAccountTheme = (next: Theme) => {
    setTheme(next);
    void supabase.auth.updateUser({ data: { gushu_theme: next } });
  };

  return {
    theme,
    toggle: () => {
      const next = theme === "dark" ? "light" : "dark";
      
      // Use View Transitions API if supported for premium animation
      if (typeof document !== "undefined" && (document as any).startViewTransition) {
        (document as any).startViewTransition(() => setAccountTheme(next));
      } else {
        setAccountTheme(next);
      }
    },
    set: setAccountTheme,
  };
}
