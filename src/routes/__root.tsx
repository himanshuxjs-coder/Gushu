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
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      router.invalidate();
      if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
    });
    return () => sub.subscription.unsubscribe();
  }, [router, queryClient]);

  useEffect(() => {
    const refreshAppOnResume = async () => {
      if (document.visibilityState !== "visible") return;

      void router.invalidate();
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      void queryClient.invalidateQueries({ queryKey: ["conv-settings"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      void queryClient.invalidateQueries({ type: "active" });

      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["conversations"] }),
        queryClient.refetchQueries({ queryKey: ["messages"] }),
        queryClient.refetchQueries({ queryKey: ["conv-settings"] }),
        queryClient.refetchQueries({ queryKey: ["me"] }),
      ]);
    };

    document.addEventListener("visibilitychange", refreshAppOnResume);
    window.addEventListener("focus", refreshAppOnResume);
    window.addEventListener("online", refreshAppOnResume);

    return () => {
      document.removeEventListener("visibilitychange", refreshAppOnResume);
      window.removeEventListener("focus", refreshAppOnResume);
      window.removeEventListener("online", refreshAppOnResume);
    };
  }, [queryClient, router]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Some deployments may not publish the generated worker. Check first so
    // a missing optional offline worker does not create a registration failure.
    void fetch("/sw.js", { method: "HEAD", cache: "no-store" })
      .then((response) => {
        if (!response.ok) return;
        return navigator.serviceWorker.register("/sw.js", { scope: "/" });
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
