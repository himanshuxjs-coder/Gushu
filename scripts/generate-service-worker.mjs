import { resolve } from "node:path";
import { generateSW } from "workbox-build";

const publicDirectory = resolve(".output/public");
const result = await generateSW({
  globDirectory: publicDirectory,
  globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
  globIgnores: ["sw.js", "workbox-*.js"],
  swDest: resolve(publicDirectory, "sw.js"),
  cleanupOutdatedCaches: true,
  clientsClaim: true,
  skipWaiting: true,
  navigateFallback: null,
  maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
  runtimeCaching: [
    {
      urlPattern: ({ request }) => request.mode === "navigate",
      handler: "NetworkFirst",
      options: {
        cacheName: "gushu-app-pages",
        networkTimeoutSeconds: 1,
        expiration: { maxEntries: 20 },
      },
    },
    {
      urlPattern: ({ url, request }) =>
        url.origin === self.location.origin &&
        ["script", "style", "font", "image"].includes(request.destination),
      handler: "CacheFirst",
      options: {
        cacheName: "gushu-static-assets",
        expiration: { maxEntries: 150, maxAgeSeconds: 60 * 60 * 24 * 30 },
      },
    },
  ],
});

console.info(`Generated service worker with ${result.count} precached files.`);
