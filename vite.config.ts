import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  nitro: true,
  tanstackStart: {
    server: { entry: "server" },
  },
  build: {
    target: "es2022",
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;

          if (id.includes("emoji-picker-react")) return "emoji-picker";
          if (id.includes("@tanstack/react-query") || id.includes("@tanstack/react-router") || id.includes("@tanstack/router-core")) return "tanstack-core";
          if (id.includes("@radix-ui")) return "radix-ui";
          if (id.includes("react") || id.includes("react-dom")) return "react-vendor";
          if (id.includes("@supabase")) return "supabase";
          if (id.includes("lucide-react")) return "icons";
          if (id.includes("sonner")) return "toast";
          if (id.includes("recharts") || id.includes("framer")) return "charts";

          return "vendor";
        },
      },
    },
  },
});