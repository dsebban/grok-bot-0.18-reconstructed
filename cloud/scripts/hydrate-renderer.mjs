// Hydrates the UI the desktop package ships: the checksum-pinned Grok Bot
// 0.18.0 renderer, with main's Router settings patch applied — the same
// "polished renderer as UI authority" the macOS build uses
// (scripts/package-macos.mjs). Like the desktop bootstrap, the upstream
// renderer is a build input, never a committed file: it is read from the Git
// LFS preservation copy of the DMG (or GROK_BOT_018_DMG), verified against
// main's pinned SHA-256, and cached under cloud/.renderer/.
//
// Prints the cached renderer directory, or exits non-zero when no verified
// DMG is available (the build then falls back to frontend/).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as asar from "@electron/asar";
import { archivedDmg, dmgSha256 } from "../../scripts/lib/config.mjs";
import { applyOriginalRendererRouterPatch } from "../../scripts/lib/router-renderer-patch.mjs";

const cloudRoot = path.resolve(import.meta.dirname, "..");
const cacheRoot = path.join(cloudRoot, ".renderer");
const ready = path.join(cacheRoot, `${dmgSha256}.json`);
const output = path.join(cacheRoot, "renderer");

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function sevenZip() {
  for (const candidate of ["7zz", "7z"]) {
    try {
      execFileSync(candidate, ["i"], { stdio: "ignore" });
      return candidate;
    } catch {}
  }
  return null;
}

export async function hydrateRenderer() {
  if (existsSync(ready) && existsSync(path.join(output, "index.html"))) return output;

  const dmg = process.env.GROK_BOT_018_DMG || archivedDmg;
  if (!existsSync(dmg)) throw new Error(`No 0.18.0 DMG at ${dmg}. Run \`git lfs pull\` or set GROK_BOT_018_DMG.`);
  const digest = await sha256(dmg);
  if (digest !== dmgSha256) {
    throw new Error(`DMG checksum mismatch (expected ${dmgSha256}, got ${digest}). A Git LFS pointer means \`git lfs pull\` has not run.`);
  }
  const zip = sevenZip();
  if (!zip) throw new Error("7-Zip (7z or 7zz) is required to read the DMG on this platform.");

  const scratch = await mkdtemp(path.join(os.tmpdir(), "grokbot-renderer-"));
  try {
    execFileSync(zip, ["x", "-y", `-o${scratch}`, dmg, "Grok Bot.app/Contents/Resources/app.asar"], { stdio: "ignore" });
    const appAsar = path.join(scratch, "Grok Bot.app", "Contents", "Resources", "app.asar");
    // Stage only the renderer, in the layout main's patch expects (dist/renderer).
    const stage = path.join(scratch, "stage");
    for (const file of asar.listPackage(appAsar, { isPack: false })) {
      const relative = file.replace(/^[\\/]+/, "");
      if (!relative.startsWith("dist/renderer/") && relative !== "dist/renderer") continue;
      const target = path.join(stage, relative);
      const stat = asar.statFile(appAsar, relative, false);
      if ("files" in stat) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, asar.extractFile(appAsar, relative));
    }
    const patch = await applyOriginalRendererRouterPatch({ stageRoot: stage });
    await rm(output, { recursive: true, force: true });
    await mkdir(cacheRoot, { recursive: true });
    await cp(path.join(stage, "dist", "renderer"), output, { recursive: true });
    await writeFile(
      ready,
      JSON.stringify({ dmgSha256, routerPatch: { chunks: patch.chunks, features: patch.features } }, null, 2)
    );
    return output;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The renderer's module entry and stylesheets, from its index.html. */
export async function rendererManifest(dir) {
  const html = await readFile(path.join(dir, "index.html"), "utf8");
  const entry = /<script[^>]+type="module"[^>]+src="\.\/([^"]+)"/.exec(html)?.[1];
  const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\.\/([^"]+)"/g)].map((match) => match[1]);
  if (!entry) throw new Error("The shipped renderer index.html has no module entry");
  return { entry, styles };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(await hydrateRenderer());
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}
