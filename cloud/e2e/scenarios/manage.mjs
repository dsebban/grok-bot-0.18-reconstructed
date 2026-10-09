// The sidebar's bot menu: pin, unread, profile, duplicate, hide, delete; search.
import { sleep, waitFor } from "../lib.mjs";

export default {
  name: "manage",
  uis: ["shipped"],
  async run({ h, r }) {
    const bot = h.bot("manage");
    const api = h.api(bot);
    const tab = await h.open(bot);
    const { page } = tab;
    for (const name of ["Travel Agent", "Recipe Helper", "Code Buddy"]) {
      await tab.newBot(name, api);
      await tab.send(`hi from ${name}`);
      await tab.see(`You said: “hi from ${name}”`);
    }

    await r.step("Pin, stored in the bot", async () => {
      await tab.menu("Travel Agent", "Pin");
      await waitFor(async () => (await api.sidebar()).pinnedAgentIds.includes((await api.agent("Travel Agent")).id), "stored pin");
      if (!(await tab.menuItems("Travel Agent")).includes("Unpin")) throw new Error("menu does not offer Unpin");
    });
    await r.step("Mark as Unread, and opening the bot marks it read", async () => {
      await tab.menu("Recipe Helper", "Mark as Unread");
      await waitFor(async () => (await api.agent("Recipe Helper")).hasUnread, "unread");
      if (!(await tab.menuItems("Recipe Helper")).includes("Mark as Read")) throw new Error("menu does not offer Mark as Read");
      await tab.openBot("Recipe Helper");
      await waitFor(async () => !(await api.agent("Recipe Helper")).hasUnread, "read on open", 8_000);
    });
    await r.step("Edit Profile: name, description and notifications", async () => {
      await tab.menu("Code Buddy", "Edit Profile");
      await page.getByLabel("Name").fill("Code Pal");
      await page.getByPlaceholder("What this agent is for").click();
      await page.keyboard.type("Helps with code");
      await page.locator("[role=switch], input[type=checkbox]").last().click();
      await waitFor(async () => {
        const agent = await api.agent("Code Pal");
        return agent?.description === "Helps with code" && agent.notifyOnUpdates;
      }, "profile saved", 8_000);
      await tab.row("Code Pal").waitFor({ timeout: 5_000 });
      await page.getByRole("button", { name: "Close details" }).first().click().catch(() => {});
    });
    await r.step("Duplicate copies the transcript and the copy chats", async () => {
      await tab.menu("Travel Agent", "Duplicate");
      const copy = await waitFor(() => api.agent("Travel Agent (copy)"), "copy");
      if (!(await api.entries(copy.id)).some((entry) => entry.content === "hi from Travel Agent")) throw new Error("no history in the copy");
      await tab.openBot("Travel Agent (copy)");
      await tab.send("hello duplicate");
      await tab.see("You said: “hello duplicate”");
    });
    await r.step("Hide from sidebar", async () => {
      await tab.menu("Recipe Helper", "Hide from sidebar");
      await waitFor(async () => (await api.agent("Recipe Helper")).isHiddenFromSidebar, "hidden flag");
      await waitFor(async () => (await page.getByText("Recipe Helper", { exact: true }).count()) === 0, "row gone", 5_000);
      await page.getByText("Hidden Bots", { exact: false }).first().waitFor({ timeout: 5_000 });
    });
    await r.step("Delete, after confirming", async () => {
      const copy = await api.agent("Travel Agent (copy)");
      await tab.menu("Travel Agent (copy)", "Delete");
      await page.getByRole("button", { name: /^Delete$/ }).last().click();
      await waitFor(async () => !(await api.agents()).some((agent) => agent.id === copy.id), "deleted");
      await waitFor(async () => (await page.getByText("Travel Agent (copy)", { exact: true }).count()) === 0, "row gone", 5_000);
    });
    await r.step("Search finds a bot by name", async () => {
      await page.getByText("Search", { exact: true }).first().click();
      await sleep(400);
      await page.keyboard.type("Code");
      await page.locator("[role=dialog], [role=listbox]").getByText("Code Pal").first().waitFor({ timeout: 5_000 });
      await page.keyboard.press("Escape");
    });
    await r.step("a fresh browser shows the same sidebar (pins, names, hidden, deleted)", async () => {
      const other = await h.open(bot);
      await other.row("Code Pal").waitFor();
      if (await other.page.getByText("Recipe Helper", { exact: true }).count()) throw new Error("hidden bot is visible");
      if (!(await other.menuItems("Travel Agent")).includes("Unpin")) throw new Error("the pin did not follow");
      await other.close();
    });
    await r.step("Unpin", async () => {
      await tab.menu("Travel Agent", "Unpin");
      await waitFor(async () => (await api.sidebar()).pinnedAgentIds.length === 0, "pin removed");
    });
    await r.step("no unexpected browser errors", () => h.clean(tab));
  }
};
