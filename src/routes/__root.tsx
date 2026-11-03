import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { supabase } from "@/integrations/supabase/client";
import { Toaster } from "sonner";
import logoUrl from "@/assets/gushu-logo.png";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Gushu — Private conversations." },
      {
        name: "description",
        content: "Premium private messaging. Conversations disappear when both participants leave.",
      },
      { name: "author", content: "Gushu" },
      { property: "og:title", content: "Gushu — Private conversations. Zero clutter." },
      {
        property: "og:description",
        content: "Premium private messaging. Conversations disappear when both participants leave.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "preload", as: "image", href: logoUrl },
      { rel: "icon", type: "image/png", href: logoUrl },
      { rel: "apple-touch-icon", href: logoUrl },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400..600;1,400..600&family=Instrument+Serif:ital@0;1&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <style>{`
          #gushu-boot-splash {
            position: fixed; inset: 0; z-index: 99999;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 22px; background: #0b0b13; color: #f4f2ff;
          }
          html.gushu-app-ready #gushu-boot-splash {
            opacity: 0; visibility: hidden; pointer-events: none;
            transition: opacity 120ms ease, visibility 120ms ease;
          }
          #gushu-boot-progress {
            width: 128px; height: 2px; overflow: hidden; border-radius: 999px;
            background: rgba(255,255,255,.12);
          }
          #gushu-boot-progress::after {
            content: ""; display: block; width: 45%; height: 100%; border-radius: inherit;
            background: linear-gradient(135deg, #a855f7, #3b82f6);
            animation: gushu-boot-progress 1.25s ease-in-out infinite;
          }
          #gushu-boot-recovery { display: none; max-width: 280px; text-align: center; font: 13px/1.5 system-ui, sans-serif; color: #c8c4d8; }
          #gushu-boot-recovery button { margin-top: 12px; border: 1px solid rgba(255,255,255,.24); border-radius: 8px; padding: 9px 16px; color: white; background: rgba(255,255,255,.08); }
          @keyframes gushu-boot-progress {
            from { transform: translateX(-110%); }
            to { transform: translateX(290%); }
          }
          @media (prefers-reduced-motion: reduce) {
            #gushu-boot-progress::after { animation: none; }
          }
        `}</style>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('gushu-theme');var d=t==='dark'||(!t&&true);if(d)document.documentElement.classList.add('dark');else document.documentElement.classList.remove('dark');}catch(e){}`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
  try {
    if (${import.meta.env.PROD}) {
      window.addEventListener('contextmenu', function (event) {
        event.preventDefault();
      }, { passive: false });
      window.addEventListener('keydown', function (event) {
        const key = event.key?.toLowerCase();
        if (event.key === 'F12' || ((event.ctrlKey || event.metaKey) && ['i', 'j', 'u', 'c', 's'].includes(key))) {
          event.preventDefault();
          event.stopPropagation();
        }
      }, { passive: false });
    }
  } catch (reason) {
    // Swallow any safety initialization error so the app still loads.
  }
})();`,
          }}
        />
      </head>
      <body className="bg-textured min-h-screen">
        <div id="gushu-boot-splash" role="status" aria-label="Loading Gushu">
          <img src={logoUrl} alt="" width="80" height="80" fetchPriority="high" decoding="sync"
            style={{ display: "block", width: 80, height: 80, objectFit: "contain" }} />
          <span style={{ fontFamily: "Georgia, serif", fontSize: 28, letterSpacing: "-0.04em" }}>Gushu</span>
          <div id="gushu-boot-progress" aria-hidden="true" />
          <div id="gushu-boot-recovery">
            Gushu is taking longer than expected to start. Check your connection and reload the app.
            <br /><button type="button" onclick="window.location.reload()">Reload app</button>
          </div>
        </div>
        <script dangerouslySetInnerHTML={{ __html: `window.setTimeout(function(){if(!document.documentElement.classList.contains('gushu-app-ready')){var recovery=document.getElementById('gushu-boot-recovery');var progress=document.getElementById('gushu-boot-progress');if(recovery)recovery.style.display='block';if(progress)progress.style.display='none';}},10000);` }} />
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  useEffect(() => {
    document.documentElement.classList.add("gushu-app-ready");
  }, []);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => sub.subscription.unsubscribe();
  }, [router, queryClient]);

  useEffect(() => {
    let wasHidden = document.visibilityState === "hidden";
    let wasOffline = !navigator.onLine;
    let lastRefreshAt = 0;

    const refreshAppOnResume = () => {
      const now = Date.now();
      if (document.visibilityState !== "visible" || now - lastRefreshAt < 2000) return;
      lastRefreshAt = now;

      // Invalidate once. TanStack Query refetches active queries automatically;
      // explicitly refetching them again caused duplicate startup/resume requests.
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      void queryClient.invalidateQueries({ queryKey: ["conv-settings"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    };

    const handleVisibilityChange = () => {
      const becameVisible = wasHidden && document.visibilityState === "visible";
      wasHidden = document.visibilityState === "hidden";
      if (becameVisible) refreshAppOnResume();
    };

    const handleOnline = () => {
      const cameOnline = wasOffline && navigator.onLine;
      wasOffline = !navigator.onLine;
      if (cameOnline) refreshAppOnResume();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
    };
  }, [queryClient]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        // Refresh the worker promptly and remove the old cached HTML shell,
        // which could reference JavaScript chunks from a previous deployment.
        void registration.update();
        if ("caches" in window) void caches.delete("gushu-app-pages");
      })
      .catch((error) => {
        console.warn("Offline app shell could not be installed:", error);
      });
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <Toaster theme="dark" position="top-center" />
    </QueryClientProvider>
  );
}
