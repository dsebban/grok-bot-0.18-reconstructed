// A fresh sidebar can create its first section; sections live in the bot.
import { sleep, waitFor } from "../lib.mjs";

export default {
  name: "sections",
  uis: ["shipped", "reconstructed"],
  async run({ h, r }) {
    const bot = h.bot("sections");
    const api = h.api(bot);
    const tab = await h.open(bot);
    const { page } = tab;
    await tab.menu("Grok Bot", "Duplicate");
    await waitFor(() => api.agent("Grok Bot (copy)"), "copy");
    await tab.row("Grok Bot (copy)").waitFor();

    await r.step("a fresh sidebar is an empty list, not unavailable", async () => {
      const sidebar = await api.sidebar();
      if (JSON.stringify(sidebar) !== JSON.stringify({ pinnedAgentIds: [], sections: [] })) throw new Error(JSON.stringify(sidebar));
    });
    await r.step("the bot menu offers Move to new section, and it creates the first section", async () => {
      const items = await tab.menuItems("Grok Bot");
      if (!items.some((item) => /new section/i.test(item))) throw new Error(`menu: ${items.join(", ")}`);
      await tab.row("Grok Bot").click({ button: "right" });
      await page.getByRole("menuitem", { name: /new section/i }).first().click();
      await sleep(500);
      if (await page.locator("input:focus").count()) {
        await page.keyboard.press("Control+A");
        await page.keyboard.type("Work");
        await page.keyboard.press("Enter");
      }
      const sections = await waitFor(async () => {
        const list = (await api.sidebar()).sections.filter((section) => section.id !== "__agents__");
        return list.length > 0 && list;
      }, "stored section", 8_000);
      return sections.map((section) => `${section.name}: ${section.agentIds.length}`).join(", ");
    });
    await r.step("every bot is still listed", async () => {
      for (const name of ["Grok Bot", "Grok Bot (copy)"]) await tab.row(name).waitFor({ timeout: 5_000 });
    });
    await r.step("a fresh browser shows the section", async () => {
      const [section] = (await api.sidebar()).sections.filter((item) => item.id !== "__agents__");
      const other = await h.open(bot);
      await other.page.getByText(section.name, { exact: true }).first().waitFor({ timeout: 10_000 });
      for (const name of ["Grok Bot", "Grok Bot (copy)"]) await other.row(name).waitFor({ timeout: 5_000 });
      h.clean(other);
      await other.close();
    });
    await r.step("no unexpected browser errors", () => h.clean(tab));
  }
};
