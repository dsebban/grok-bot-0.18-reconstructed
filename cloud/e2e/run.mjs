// End to end: `vite build`, then `wrangler dev` (local workerd: real Durable
// Objects, SQLite and alarms) on the offline demo model, then headless
// Chromium driving the Grok Bot UI through every scenario in scenarios/.
//
//   node e2e/run.mjs [--no-build] [--headed] [--only core,unread]
//   GROKBOT_UI=reconstructed node e2e/run.mjs   # the frontend/ renderer instead
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Harness, Runner } from "./lib.mjs";
import { root } from "./server.mjs";

const argv = process.argv.slice(2);
const flags = new Set(argv);
const only = argv.includes("--only") ? new Set(argv[argv.indexOf("--only") + 1].split(",")) : null;
const ui = process.env.GROKBOT_UI === "reconstructed" ? "reconstructed" : "shipped";
const artifacts = path.join(root, "e2e", "artifacts");

const SCENARIOS = ["core", "bots", "manage", "routines", "restart", "tabs", "unread", "sections"];

fs.rmSync(artifacts, { recursive: true, force: true });
fs.mkdirSync(artifacts, { recursive: true });
if (!flags.has("--no-build")) execSync("npx vite build", { cwd: root, stdio: "inherit" });

// A shipped run must really serve the shipped renderer: the build falls back
// to the reconstruction when no verified DMG is available.
const shippedBuilt = fs.readdirSync(path.join(root, "dist/client/assets")).some((file) => /^index-UbX-y3il\.js$/.test(file));
if ((ui === "shipped") !== shippedBuilt) {
  console.error(`GROKBOT_UI=${ui} but the build ${shippedBuilt ? "contains" : "does not contain"} the shipped renderer (hydrate it with scripts/hydrate-renderer.mjs).`);
  process.exit(1);
}

const scenarios = [];
for (const name of SCENARIOS) {
  if (only && !only.has(name)) continue;
  const scenario = (await import(`./scenarios/${name}.mjs`)).default;
  if (scenario.uis.includes(ui)) scenarios.push(scenario);
}

const h = new Harness({ ui, port: 8799, artifacts, headed: flags.has("--headed") });
const r = new Runner(h);
const started = Date.now();
try {
  console.log(`› wrangler dev (${ui} UI)`);
  await h.start();
  for (const scenario of scenarios) {
    r.scenario = scenario.name;
    console.log(`› ${scenario.name}`);
    try {
      await scenario.run({ h, r });
    } catch (error) {
      // The failed step is recorded; a step that threw outside r.step is not.
      if (!r.results.some((result) => result.scenario === scenario.name && !result.ok)) {
        r.results.push({ scenario: scenario.name, name: "(setup)", ok: false, error: String(error?.stack ?? error) });
        console.log(`  ✗ (setup)\n    ${String(error?.message ?? error).split("\n")[0]}`);
      }
    } finally {
      for (const tab of [...h.tabs]) await tab.close();
    }
  }
} catch (error) {
  r.results.push({ scenario: "harness", name: "start", ok: false, error: String(error?.stack ?? error) });
  console.error(error);
} finally {
  await h.stop();
  fs.writeFileSync(path.join(artifacts, "results.json"), JSON.stringify(r.results, null, 2));
  const passed = r.results.filter((result) => result.ok).length;
  const failed = r.failed;
  console.log(`\n[${ui} UI] ${passed}/${r.results.length} e2e steps passed in ${scenarios.length} scenarios (${Math.round((Date.now() - started) / 1000)} s)`);
  for (const result of failed) console.log(`  ✗ ${result.scenario} › ${result.name}`);
  process.exitCode = failed.length ? 1 : 0;
}
