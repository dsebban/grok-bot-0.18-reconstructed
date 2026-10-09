// Restarts with the UI open: graceful and kill -9, persistence, routines across a crash.
import { sleep, waitFor } from "../lib.mjs";

export default {
  name: "restart",
  uis: ["shipped"],
  async run({ h, r }) {
    const bot = h.bot("restart");
    const api = h.api(bot);
    const tab = await h.open(bot);
    const { page } = tab;
    await tab.newBot("Keeper", api);
    await tab.send("remember that I like tea");
    await tab.see("Saved memory #1");
    await tab.newBot("Hidden One", api);
    await tab.menu("Hidden One", "Hide from sidebar");
    await tab.menu("Keeper", "Pin");
    const snapshot = async () => ({
      agents: (await api.agents()).map((agent) => `${agent.id}:${agent.name}:${agent.isHiddenFromSidebar}`).sort(),
      keeper: (await api.entries((await api.agent("Keeper")).id)).length,
      sidebar: await api.sidebar()
    });
    const before = await snapshot();

    await r.step("graceful restart with the browser open; a message typed right away is delivered", async () => {
      await tab.openBot("Keeper");
      await h.restart("SIGTERM");
      await tab.send("hello after restart");
      await tab.see("You said: “hello after restart”", 30_000);
    });
    await r.step("bots, hidden flags, transcripts, pins and memory persisted", async () => {
      const after = await snapshot();
      if (JSON.stringify(after.agents) !== JSON.stringify(before.agents)) throw new Error(JSON.stringify({ before: before.agents, after: after.agents }));
      if (after.keeper < before.keeper) throw new Error(`transcript shrank ${before.keeper} → ${after.keeper}`);
      if (JSON.stringify(after.sidebar.pinnedAgentIds) !== JSON.stringify(before.sidebar.pinnedAgentIds)) throw new Error("pins changed");
      await tab.send("recall");
      await tab.see("I like tea");
    });
    await r.step("kill -9 mid-answer: the answer completes in one bubble", async () => {
      await tab.send("slow");
      await waitFor(async () => (await api.agent("Keeper")).isRunning, "running");
      await sleep(400);
      await h.restart("SIGKILL");
      await waitFor(async () => !(await api.agent("Keeper")).isRunning, "finished", 60_000);
      const entries = await api.entries((await api.agent("Keeper")).id);
      const last = entries.at(-1);
      if (last.kind !== "send-message" || !last.message.content.endsWith("resumes from the last checkpoint.")) throw new Error(JSON.stringify(last).slice(0, 300));
      if (entries.at(-2).kind !== "message") throw new Error("the interrupted partial answer is still shown");
      await page.getByText("simply resumes from the last checkpoint.", { exact: false }).last().waitFor({ timeout: 30_000 });
    });
    await r.step("a recurring routine keeps firing across kill -9", async () => {
      const id = (await api.agent("Keeper")).id;
      const runs = async () => (await api.entries(id)).filter((entry) => entry.content === "[routine] say tock").length;
      await tab.send("every 0.1 minutes say tock");
      await tab.see("Created routine");
      await waitFor(async () => (await runs()) >= 1, "first run", 30_000);
      const n = await runs();
      await h.restart("SIGKILL");
      await waitFor(async () => (await runs()) > n, "a run after the restart", 60_000);
      await tab.send("list schedules");
      const listing = await waitFor(async () => {
        const text = (await api.entries(id)).at(-1)?.message?.content;
        return text?.includes("say tock") && text;
      }, "listing");
      const routine = listing.split("\n").find((line) => line.includes("say tock"))?.trim().split(" ")[0];
      await tab.send(`cancel ${routine}`);
      await waitFor(async () => (await api.entries(id)).at(-1)?.message?.content?.includes(routine), "cancelled");
    });
    await r.step("no unexpected browser errors", () => h.clean(tab));
  }
};
