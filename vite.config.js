import { defineConfig } from "vite";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Recursively list every file under `dir`, returned as root-relative URLs
// (posix separators, leading '/'), excluding `exclude` (basenames).
function listDistFiles(dir, exclude) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        const rel = "/" + relative(dir, full).split(sep).join("/");
        if (!exclude.includes(rel.replace(/^\//, ""))) out.push(rel);
      }
    }
  };
  walk(dir);
  return out;
}

// Injects the precache manifest and a deterministic build version into the
// service worker after the rest of the bundle has been written.
function swInjectPlugin() {
  let resolvedConfig;
  return {
    name: "brx-sw-inject",
    apply: "build",
    configResolved(config) {
      resolvedConfig = config;
    },
    closeBundle() {
      const distDir = join(resolvedConfig.root, resolvedConfig.build.outDir);
      const swPath = join(distDir, "sw.js");
      let swSource;
      try {
        swSource = readFileSync(swPath, "utf8");
      } catch {
        // sw.js not emitted (e.g. public/sw.js missing) — nothing to do.
        return;
      }

      const files = listDistFiles(distDir, ["sw.js"]);
      // '/' (index.html at the root URL) alongside '/index.html' itself.
      if (files.includes("/index.html") && !files.includes("/")) {
        files.push("/");
      }
      files.sort();

      let indexHtml = "";
      try {
        indexHtml = readFileSync(join(distDir, "index.html"), "utf8");
      } catch {
        // no index.html — hash purely off the file list.
      }

      const version = createHash("sha256")
        .update(JSON.stringify(files))
        .update(indexHtml)
        .digest("hex")
        .slice(0, 12);

      swSource = swSource.replace(
        '["__PRECACHE__"]',
        JSON.stringify(files)
      );
      // Single (first-occurrence) replace only — the declaration
      // `const BUILD_VERSION = "__BUILD_VERSION__";` is the only place this
      // exact literal should be substituted. The later runtime comparison
      // against the same placeholder string must stay intact so unreplaced
      // (dev) service workers still fall back to VERSION = 'dev'.
      swSource = swSource.replace("__BUILD_VERSION__", version);

      writeFileSync(swPath, swSource);
    },
  };
}

export default defineConfig({
  plugins: [swInjectPlugin()],
  build: {
    rollupOptions: {
      output: {
        // Stable, unhashed asset names so the service worker precache list
        // doesn't need to be recomputed/reinstalled on every deploy where
        // content didn't actually change the entry points.
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name || assetInfo.names?.[0] || "";
          if (name.endsWith(".css")) return "assets/app.css";
          return "assets/[name][extname]";
        },
      },
    },
  },
});
