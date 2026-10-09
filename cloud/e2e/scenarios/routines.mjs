// Routines from chat (one-shot, recurring, list, cancel) and from the Routines pane.
import { sleep, waitFor } from "../lib.mjs";

export default {
  name: "routines",
  uis: ["shipped"],
  async run({ h, r }) {
    const bot = h.bot("routines");
    const api = h.api(bot);
    const tab = await h.open(bot);
    const { page } = tab;
    await tab.newBot("Planner", api);
    const id = (await api.agent("Planner")).id;
    const pane = page.locator("[class*=info-pane]").first();
    const runsOf = async (prompt) => (await api.entries(id)).filter((entry) => entry.content === `[routine] ${prompt}`).length;

    await r.step("chat: a one-shot reminder fires through the alarm", async () => {
      await tab.send("remind me in 2 seconds to drink water");
      await tab.see("Created routine");
      await tab.see("⏰ Scheduled task: Remind the user to drink water", 30_000);
    });
    await r.step("chat: a recurring routine runs repeatedly", async () => {
      await tab.send("every 0.1 minutes say tick");
      const created = await waitFor(async () => {
        const replies = (await api.entries(id)).filter((entry) => entry.message?.content?.includes("Created routine"));
        return replies.length >= 2 && replies.at(-1).message.content;
      }, "second routine created");
      if (!/every/i.test(created)) throw new Error(`not recurring: ${created}`);
      await waitFor(async () => (await runsOf("say tick")) >= 2, "two runs", 40_000);
    });
    let tickId = "";
    await r.step("chat: list schedules shows both routines", async () => {
      await tab.send("list schedules");
      const listing = await waitFor(async () => {
        const text = (await api.entries(id)).at(-1)?.message?.content;
        return text?.includes("say tick") && text;
      }, "listing");
      tickId = listing.split("\n").find((line) => line.includes("say tick") && line.includes("[on]"))?.trim().split(" ")[0] ?? "";
      if (!tickId || !listing.includes("drink water")) throw new Error(listing);
    });
    await r.step("chat: cancel stops the recurring routine", async () => {
      await tab.send(`cancel ${tickId}`);
      await waitFor(async () => (await api.entries(id)).at(-1)?.message?.content?.includes(tickId), "cancelled");
      await sleep(1_000);
      const runs = await runsOf("say tick");
      await sleep(9_000);
      if ((await runsOf("say tick")) !== runs) throw new Error("still firing after cancel");
    });
    await r.step("a routine created in chat appears live in the open Routines pane", async () => {
      await page.getByRole("button", { name: "View agent settings" }).click();
      await page.getByRole("button", { name: "Back to details" }).click();
      await page.getByRole("button", { name: "Create Routine" }).first().waitFor();
      await tab.send("every 5 minutes check the weather");
      await pane.getByText("check the weather").first().waitFor();
      await pane.getByText("Every 5 minutes").first().waitFor();
    });
    await r.step("pane: create a routine with the form", async () => {
      await page.getByRole("button", { name: "Create Routine" }).first().click();
      await page.getByPlaceholder("Name this routine").fill("Morning digest");
      await page.getByPlaceholder("What should this routine do each time it runs?").fill("Summarise my day");
      await page.getByRole("button", { name: "Add trigger" }).click();
      await page.getByRole("menuitem", { name: "On a schedule" }).click();
      await page.getByRole("menuitem", { name: "Every hour" }).click();
      // The form saves once it has a name, an instruction and a trigger.
      await waitFor(() => page.getByRole("button", { name: "Test run" }).isEnabled(), "routine saved");
      await page.getByRole("button", { name: "Back to Routines" }).click();
      await pane.getByText("Morning digest").first().waitFor();
    });
    await r.step("pane: Test run delivers the routine's prompt", async () => {
      await pane.getByText("Morning digest").first().click();
      await page.getByRole("button", { name: "Test run" }).click();
      await waitFor(async () => (await runsOf("Summarise my day")) === 1, "test run", 20_000);
      await tab.see("⏰ Scheduled task: Summarise my day");
    });
    await r.step("pane: pause, then delete", async () => {
      await page.getByRole("switch").first().click();
      await waitFor(() => {
        const latest = tab.events("agents-automation").filter((event) => event.agentId === id).at(-1);
        return latest?.automations.find((routine) => routine.name === "Morning digest")?.isEnabled === false;
      }, "routine paused", 8_000);
      await page.getByRole("button", { name: "Delete" }).first().click();
      await sleep(300);
      const confirm = page.getByRole("button", { name: /^Delete$/ }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => {});
      await waitFor(async () => (await pane.getByText("Morning digest").count()) === 0, "routine gone", 8_000);
      await pane.getByText("check the weather").first().waitFor();
    });
    await r.step("no unexpected browser errors", () => h.clean(tab));
  }
};
