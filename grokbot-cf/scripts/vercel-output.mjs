// Turn `dist-web/` into Vercel's Build Output API layout (.vercel/output), so
// CI can run `vercel deploy --prebuilt` without Vercel rebuilding anything:
// static files, long-lived caching for hashed assets, and an SPA fallback.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "dist-web");
const output = path.join(root, ".vercel", "output");

if (!fs.existsSync(path.join(source, "index.html"))) {
  console.error("dist-web/index.html is missing; run `pnpm build:web` first.");
  process.exit(1);
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.cpSync(source, path.join(output, "static"), { recursive: true });
fs.writeFileSync(
  path.join(output, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        {
          src: "^/assets/(.*)$",
          headers: { "cache-control": "public, max-age=31536000, immutable" },
          continue: true
        },
        { handle: "filesystem" },
        { src: "^/(.*)$", dest: "/index.html" }
      ]
    },
    null,
    2
  )
);
console.log(`Wrote ${path.relative(root, output)} from ${path.relative(root, source)}`);
