// Several bots from the To: picker, tools, memory shared across bots, queued follow-ups.
import { waitFor } from "../lib.mjs";

const BOTS = ["Travel Agent", "Recipe Helper", "Code Buddy"];

export default {
  name: "bots",
  uis: ["shipped"],
  async run({ h, r }) {
    const bot = h.bot("bots");
    const api = h.api(bot);
    const tab = await h.open(bot);
    const last = async (name) => (await api.entries((await api.agent(name)).id)).at(-1);

    await tab.openBot("Grok Bot");
    await r.step("help lists the demo model's commands", async () => {
      await tab.send("help");
      await tab.see("remember");
    });
    await r.step("tools: memory, time, files, schedules", async () => {
      await tab.send("remember that I live in Lisbon");
      await tab.see("Saved memory #1");
      await tab.send("what time is it?");
      await waitFor(async () => (await last("Grok Bot"))?.message?.content?.includes("current_time"), "current_time answer");
      await tab.send("write /notes/todo.md: buy milk");
      await tab.see("Wrote /notes/todo.md");
      await tab.send("read /notes/todo.md");
      await waitFor(async () => (await last("Grok Bot"))?.message?.content?.includes("buy milk"), "file read back");
      await tab.send("list files");
      await waitFor(async () => (await last("Grok Bot"))?.message?.content?.includes("/notes/todo.md"), "file listed");
    });
    for (const name of BOTS) {
      await r.step(`creates "${name}" from the To: picker and chats`, async () => {
        await tab.newBot(name, api);
        await tab.send(`hi from ${name}`);
        await tab.see(`You said: “hi from ${name}”`);
      });
    }
    await r.step("memory is shared across bots", async () => {
      await tab.send("recall");
      await tab.see("Lisbon");
    });
    await r.step("each bot keeps its own transcript when switching", async () => {
      await tab.openBot("Travel Agent");
      await tab.see("hi from Travel Agent");
      if (await tab.count("hi from Code Buddy")) throw new Error("Code Buddy's transcript leaked into Travel Agent");
      await tab.openBot("Grok Bot");
      await tab.see("Saved memory #1");
    });
    await r.step("a follow-up sent while the bot is busy is queued and answered", async () => {
      await tab.send("slow");
      await waitFor(async () => (await api.agent("Grok Bot")).isRunning, "running");
      await tab.send("quick follow up");
      await tab.see("You said: “quick follow up”", 60_000);
      await waitFor(async () => !(await api.agents()).some((agent) => agent.isRunning), "idle", 60_000);
    });
    await r.step("the sidebar lists every bot", async () => {
      for (const name of ["Grok Bot", ...BOTS]) await tab.row(name).waitFor({ timeout: 5_000 });
      return (await api.agents()).map((agent) => agent.name).join(", ");
    });
    await r.step("no unexpected browser errors", () => h.clean(tab));
  }
};
