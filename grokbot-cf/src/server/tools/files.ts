import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { Store } from "../store";
import { errorText, text, type OnChange } from "./util";

/**
 * A small durable workspace: text files in the bot's SQLite database,
 * shared by every thread and browsable from the UI.
 */

const Write = Type.Object({
  path: Type.String({ description: "Absolute path, e.g. /notes/todo.md" }),
  content: Type.String({ description: "The whole new file content." })
});
const Read = Type.Object({
  path: Type.String(),
  offset: Type.Optional(
    Type.Number({ description: "First line to return, 1-based." })
  ),
  limit: Type.Optional(Type.Number({ description: "Most lines to return." }))
});
const List = Type.Object({
  dir: Type.Optional(Type.String({ description: "Directory; default /" }))
});
const Delete = Type.Object({ path: Type.String() });
const Edit = Type.Object({
  path: Type.String(),
  oldText: Type.String({ description: "Exact text to replace; must occur once." }),
  newText: Type.String()
});

export function fileTools(store: Store, onChange: OnChange): ToolRegistration[] {
  const write: ToolRegistration<typeof Write> = {
    name: "files_write",
    description:
      "Create or overwrite a text file in the bot's durable workspace.",
    parameters: Write,
    // Writing the whole file again gives the same result.
    replay: "safe",
    async execute({ path, content }) {
      try {
        const file = store.writeFile(path, content);
        onChange("files");
        return text(`Wrote ${file.path} (${file.size} characters).`);
      } catch (error) {
        return errorText(error);
      }
    }
  };

  const read: ToolRegistration<typeof Read> = {
    name: "files_read",
    description: "Read a text file from the workspace, optionally a line range.",
    parameters: Read,
    replay: "safe",
    async execute({ path, offset, limit }) {
      try {
        const content = store.readFile(path);
        if (content === undefined) return text(`No such file: ${path}`, true);
        if (offset === undefined && limit === undefined) {
          return text(content === "" ? "(empty file)" : content);
        }
        const lines = content.split("\n");
        const start = Math.max(1, Math.floor(offset ?? 1));
        const end = limit === undefined ? lines.length : start - 1 + Math.floor(limit);
        return text(lines.slice(start - 1, end).join("\n"));
      } catch (error) {
        return errorText(error);
      }
    }
  };

  const list: ToolRegistration<typeof List> = {
    name: "files_list",
    description: "List files in the workspace, with sizes.",
    parameters: List,
    replay: "safe",
    async execute({ dir }) {
      try {
        const files = store.files(dir ?? "/");
        if (files.length === 0) return text("The workspace has no files here.");
        return text(
          files.map((file) => `${file.path}\t${file.size} chars`).join("\n")
        );
      } catch (error) {
        return errorText(error);
      }
    }
  };

  const remove: ToolRegistration<typeof Delete> = {
    name: "files_delete",
    description: "Delete a file from the workspace.",
    parameters: Delete,
    // Deleting a missing file is reported, not an error.
    replay: "safe",
    async execute({ path }) {
      try {
        const removed = store.deleteFile(path);
        if (removed) onChange("files");
        return text(removed ? `Deleted ${path}.` : `${path} did not exist.`);
      } catch (error) {
        return errorText(error);
      }
    }
  };

  const edit: ToolRegistration<typeof Edit> = {
    name: "files_edit",
    description:
      "Replace one exact occurrence of oldText with newText in a workspace file.",
    parameters: Edit,
    // A second run would not find oldText again.
    replay: "unsafe",
    async execute({ path, oldText, newText }) {
      try {
        const content = store.readFile(path);
        if (content === undefined) return text(`No such file: ${path}`, true);
        const first = content.indexOf(oldText);
        if (first === -1 || oldText === "") {
          return text(`oldText was not found in ${path}.`, true);
        }
        if (content.indexOf(oldText, first + 1) !== -1) {
          return text(`oldText occurs more than once in ${path}; add context.`, true);
        }
        store.writeFile(
          path,
          content.slice(0, first) + newText + content.slice(first + oldText.length)
        );
        onChange("files");
        return text(`Edited ${path}.`);
      } catch (error) {
        return errorText(error);
      }
    }
  };

  return [write, read, list, remove, edit];
}
