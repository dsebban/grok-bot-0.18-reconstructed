// Unread follows the chat each tab has on screen: switches (cached ones too),
// background updates, reloads, restarts and hidden tabs.
import { sleep, waitFor } from "../lib.mjs";

export default {
  name: "unread",
  uis: ["shipped", "reconstructed"],
  async run({ h, r }) {
    const bot = h.bot("unread");
    const api = h.api(bot);
    const tab = await h.open(bot);
    const { page } = tab;
    await tab.menu("Grok Bot", "Duplicate");
    const a = (await api.agent("Grok Bot")).id;
    const b = (await waitFor(() => api.agent("Grok Bot (copy)"), "copy")).id;
    await tab.row("Grok Bot (copy)").waitFor();
    const unread = async (id) => (await api.agents()).find((agent) => agent.id === id).hasUnread === true;
    /** A routine that fires in `id`'s chat a second from now, run to completion. */
    const routine = async (id, what) => {
      await api.prompt(id, `remind me in 1 second to ${what}`);
      await waitFor(async () => (await api.entries(id)).some((entry) => entry.message?.content?.includes(`Scheduled task: Remind the user to ${what}`)), `routine ${what}`, 20_000);
      await sleep(300);
    };
    const reported = (id, from = 0) => tab.viewing.slice(from).some((report) => report.agentId === id && report.status === 200);

    await r.step("every switch is reported, cached chats included", async () => {
      const from = tab.viewing.length;
      const opened = tab.requests().filter((request) => request.method === "openAgentTail").length;
      for (const name of ["Grok Bot", "Grok Bot (copy)", "Grok Bot"]) await tab.openBot(name);
      await waitFor(() => tab.viewing.length - from >= 3, "three reports", 10_000);
      const order = tab.viewing.slice(from).map((report) => report.agentId);
      if (order.slice(-3).join() !== [a, b, a].join()) throw new Error(`reported ${order.join()}`);
      const seqs = tab.viewing.map((report) => report.seq);
      if (seqs.some((seq, index) => index > 0 && seq <= seqs[index - 1])) throw new Error(`reports out of order: ${seqs.join()}`);
      return `${tab.requests().filter((request) => request.method === "openAgentTail").length - opened} openAgentTail for 3 switches`;
    });
    await r.step("a routine in the chat on screen does not mark it unread", async () => {
      await routine(a, "look at A");
      if (await unread(a)) throw new Error("the visible chat was marked unread");
    });
    await r.step("a routine in a background chat marks it unread, and selecting it clears that", async () => {
      await routine(b, "look at B");
      if (!(await unread(b))) throw new Error("the background chat is not unread");
      await tab.openBot("Grok Bot (copy)");
      await waitFor(async () => !(await unread(b)), "read on select", 8_000);
    });
    await r.step("after a reload the restored chat is reported without a click", async () => {
      const from = tab.viewing.length;
      await page.reload();
      await waitFor(() => reported(b, from), "restored selection reported", 20_000);
    });
    await r.step("after a server restart the tab reports again and its chat stays read", async () => {
      const from = tab.viewing.length;
      await h.restart("SIGTERM");
      await waitFor(() => reported(b, from), "report after restart", 30_000);
      await routine(b, "check after restart");
      if (await unread(b)) throw new Error("the open chat was marked unread after the restart");
    });
    await r.step("a hidden tab watches nothing", async () => {
      const from = tab.viewing.length;
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => tab.viewing.slice(from).some((report) => report.agentId === null && report.status === 200), "hidden report");
      await routine(b, "check while hidden");
      if (!(await unread(b))) throw new Error("a chat in a hidden tab was not marked unread");
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(async () => !(await unread(b)), "read again when visible", 8_000);
    });
    await r.step("no unexpected browser errors", () => h.clean(tab));
  }
};
