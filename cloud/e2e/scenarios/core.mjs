// Onboarding, chat, tools, reload and crash recovery, the To: picker, Router.
import { sleep, waitFor } from "../lib.mjs";

export default {
  name: "core",
  uis: ["shipped", "reconstructed"],
  async run({ h, r }) {
    const bot = h.bot("core");
    const api = h.api(bot);
    const tab = await h.open(bot);
    const { page } = tab;
    const transcript = page.locator(h.ui === "shipped" ? "main, body" : "[role=log]").first();
    const grokBotId = async () => (await api.agent("Grok Bot")).id;

    await r.step("loads the Grok Bot UI with the onboarded agent", async () => {
      await page.getByRole("button", { name: /Plugins/ }).waitFor();
      return (await api.agents()).map((agent) => agent.name).join(", ");
    });

    await r.step("chats with the bot, without duplicating the sent message", async () => {
      await tab.openBot("Grok Bot");
      await tab.send("hello there");
      await transcript.getByText("You said: “hello there”.", { exact: false }).first().waitFor();
      await sleep(500);
      if ((await page.getByText("hello there", { exact: true }).count()) !== 1) throw new Error("user message shown more than once");
    });

    await r.step("tools: memory carries into later turns", async () => {
      await tab.send("remember that my favourite colour is teal");
      await tab.see("Saved memory #1: my favourite colour is teal");
      await tab.send("how are you?");
      await tab.see("I remember 1 thing about you");
    });

    await r.step("reload mid-answer resumes the streamed reply", async () => {
      await tab.send("slow");
      await tab.see("Durable Objects give each conversation");
      await page.reload();
      await waitFor(async () => (await api.agents()).every((agent) => !agent.isRunning), "run to finish");
      await tab.openBot("Grok Bot");
      await page.getByText("resumes from the last checkpoint. Durable Objects give", { exact: false }).last().waitFor();
    });

    await r.step("a reminder fires through the Durable Object alarm", async () => {
      await tab.send("remind me in 2 seconds to stretch");
      await tab.see("Created routine");
      await tab.see("⏰ Scheduled task: Remind the user to stretch");
    });

    if (h.ui === "shipped") {
      await r.step("creates a bot from the To: picker and talks to it", async () => {
        await tab.newBot("Picnic Planner", api);
        await tab.send("Plan a picnic for Saturday");
        await tab.see("You said: “Plan a picnic for Saturday”");
        await tab.row("Picnic Planner").waitFor();
      });

      await r.step("Settings → Router switches provider and stores an OpenRouter key", async () => {
        await page.getByRole("button", { name: "Open account menu" }).click();
        await page.getByRole("menuitem", { name: /settings/i }).first().click();
        await page.getByText("Router", { exact: true }).first().click();
        await page.getByText("Use your signed-in Cursor account.", { exact: false }).waitFor();
        await page.getByLabel("Routing provider").first().click();
        await page.getByRole("option", { name: "OpenRouter" }).click();
        await page.getByLabel("OPENROUTER_API_KEY").fill("sk-or-test");
        await page.getByRole("button", { name: "Save" }).click();
        await waitFor(async () => (await api.secrets()).keys.includes("OPENROUTER_API_KEY"), "stored key");
        const router = await api.router();
        if (router.provider !== "openrouter" || router.model !== "openrouter/x-ai/grok-4.3") throw new Error(JSON.stringify(router));
        await page.getByLabel("Routing provider").first().click();
        await page.getByRole("option", { name: "Cursor" }).click();
        await waitFor(async () => (await api.router()).provider === "cursor", "provider back to cursor");
        await page.keyboard.press("Escape");
      });
    } else {
      // frontend/'s reconstruction stops accepting composer input after a
      // chat switch (README); create the chat and check the roster only.
      await r.step("a new chat appears in the sidebar", async () => {
        await page.getByRole("button", { name: "New" }).click();
        await waitFor(async () => (await api.agents()).some((agent) => agent.name === "New chat"), "new agent");
        await tab.row("New chat").waitFor();
      });
    }

    await r.step("a server crash mid-answer resumes after restart, one answer per turn", async () => {
      const id = await grokBotId();
      const sent = api.prompt(id, "slow").catch(() => null);
      await waitFor(async () => (await api.agents()).some((agent) => agent.isRunning), "run to start");
      await sleep(300);
      await h.restart("SIGKILL");
      await sent;
      const entries = await waitFor(async () => {
        const list = await api.entries(id);
        const last = list.at(-1);
        return last?.kind === "send-message" && !last.streaming && last.message.content.includes("resumes from the last checkpoint") && list;
      }, "resumed answer", 60_000);
      const answers = entries.filter((entry) => entry.kind === "send-message" && entry.message.content.startsWith("Durable Objects"));
      if (answers.length !== 2) throw new Error(`expected one answer per slow turn, got ${answers.length}`);
    });

    await r.step("the UI reconnects on its own and a message typed right away is delivered", async () => {
      const ready = tab.readyCount();
      await h.restart("SIGKILL");
      if (h.ui === "shipped") {
        await tab.send("back online?");
      } else {
        // Over REST the prompt does not wait for the tab, so let it reconnect first.
        await waitFor(() => tab.readyCount() > ready, "the tab to reconnect", 30_000);
        await tab.openBot("Grok Bot");
        await api.prompt(await grokBotId(), "back online?");
      }
      // The reply reaches this tab live, over the reconnected socket.
      await waitFor(
        () => tab.events("transcript").some((event) => event.entry?.message?.content?.includes("You said: “back online?”")),
        "the reply as a live transcript event",
        30_000
      );
      if (h.ui === "shipped") await tab.see("You said: “back online?”");
    });

    await r.step("no unexpected browser errors", () => h.clean(tab));
  }
};
