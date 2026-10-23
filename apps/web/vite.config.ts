import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// Read the repo-root .env so web and api share one config file.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const apiPort = env.API_PORT || "8787";
  return {
    envDir: repoRoot,
    server: {
      port: Number(env.WEB_PORT || 5173),
      // Browser calls /api/... on the Vite port; Vite forwards them to the API (incl. SSE).
      proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
    },
  };
});
