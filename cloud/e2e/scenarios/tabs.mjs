// Two tabs on one bot space stay in sync; light theme and phone width render.
export default {
  name: "tabs",
  uis: ["shipped"],
  async run({ h, r }) {
    const bot = h.bot("tabs");
    const api = h.api(bot);
    const one = await h.open(bot);
    const two = await h.open(bot);
    await one.openBot("Grok Bot");
    await two.openBot("Grok Bot");

    await r.step("a message sent in one tab streams live into the other", async () => {
      await one.send("hello from tab one");
      await two.see("You said: “hello from tab one”");
    });
    await r.step("a bot created in one tab appears in the other", async () => {
      await two.newBot("Tab Two Bot", api);
      await one.row("Tab Two Bot").waitFor({ timeout: 10_000 });
    });
    await r.step("light theme at phone width renders without horizontal scroll", async () => {
      const phone = await h.open(bot, { scheme: "light", width: 390, height: 844, ready: "composer" });
      const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const background = await phone.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await phone.page.screenshot({ path: `${h.artifacts}/phone-light.png` });
      h.clean(phone);
      await phone.close();
      if (overflow > 0) throw new Error(`${overflow}px horizontal overflow`);
      return `background ${background}`;
    });
    await r.step("no unexpected browser errors", () => {
      h.clean(one);
      h.clean(two);
    });
  }
};
