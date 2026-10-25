import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// The officials' console lives at /control/ — the same app, opened in its own mode. The API serves the build
// as static files, so the build also writes control/index.html (dev: Vite's SPA fallback already serves it).
const controlPage = (): Plugin => ({
  name: "monsoonwatch-control-page",
  apply: "build",
  writeBundle(options) {
    const dir = options.dir ?? "dist";
    mkdirSync(join(dir, "control"), { recursive: true });
    copyFileSync(join(dir, "index.html"), join(dir, "control", "index.html"));
  },
});

// Read the repo-root .env so web and api share one config file.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const apiPort = env.API_PORT || "8787";
  return {
    envDir: repoRoot,
    plugins: [controlPage()],
    server: {
      port: Number(env.WEB_PORT || 5173),
      // Browser calls /api/... on the Vite port; Vite forwards them to the API (incl. SSE).
      proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
    },
  };
});
