import { Type } from "@earendil-works/pi-ai";
import type { PromptSection, ToolRegistration } from "@earendil-works/pi-durable";
import type { Store } from "../store";
import { errorText, text, type OnChange } from "./util";

/**
 * Long-term memory shared by every thread of a bot. Saved facts are also
 * rendered into the `memory` system prompt section, so the model sees them
 * without having to search.
 */

const Save = Type.Object({
  content: Type.String({
    description:
      "One self-contained fact about the user or their world, e.g. \"The user's dog is called Rex.\""
  })
});
const Search = Type.Object({
  query: Type.String({ description: "Words to look for. Empty lists everything." })
});
const Forget = Type.Object({
  id: Type.Number({ description: "The memory id, from memory_search." })
});

/** How many memories the system prompt shows; the rest are searchable. */
const PROMPT_MEMORIES = 50;

export function memoryTools(
  store: Store,
  onChange: OnChange
): ToolRegistration[] {
  const save: ToolRegistration<typeof Save> = {
    name: "memory_save",
    description:
      "Save a durable fact to long-term memory, shared across all conversations. Use when the user shares a preference, a personal detail, or asks you to remember something.",
    parameters: Save,
    // Saving the same text twice keeps one copy.
    replay: "safe",
    async execute({ content }) {
      try {
        const item = store.remember(content);
        onChange("memory");
        return text(`Saved memory #${item.id}: ${item.content}`);
      } catch (error) {
        return errorText(error);
      }
    }
  };

  const search: ToolRegistration<typeof Search> = {
    name: "memory_search",
    description: "Search long-term memory. Returns matching facts with their ids.",
    parameters: Search,
    replay: "safe",
    async execute({ query }) {
      const found = store.searchMemory(query);
      if (found.length === 0) return text("No matching memories.");
      return text(found.map((item) => `#${item.id}: ${item.content}`).join("\n"));
    }
  };

  const forget: ToolRegistration<typeof Forget> = {
    name: "memory_forget",
    description: "Delete one fact from long-term memory by id.",
    parameters: Forget,
    replay: "safe",
    async execute({ id }) {
      const removed = store.forget(id);
      if (removed) onChange("memory");
      return text(removed ? `Forgot memory #${id}.` : `No memory #${id}.`);
    }
  };

  return [save, search, forget];
}

export function memorySection(store: Store): PromptSection {
  return {
    key: "memory",
    render() {
      const items = store.memories().slice(-PROMPT_MEMORIES);
      if (items.length === 0) return undefined;
      return [
        "Things you remember about the user (from earlier conversations):",
        ...items.map((item) => `- ${item.content}`)
      ].join("\n");
    }
  };
}
