import { useState } from "react";
import type { BotState, ToolInfo } from "../shared/protocol";

type Call = <T = unknown>(command: never) => Promise<T>;

function ago(time: number): string {
  const seconds = Math.round((Date.now() - time) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(time).toLocaleDateString();
}

export function Panels({
  state,
  tools,
  call
}: {
  state: BotState;
  tools: readonly ToolInfo[];
  call: Call;
}) {
  const [tab, setTab] = useState<"memory" | "files" | "automations" | "tools">("memory");
  const [newMemory, setNewMemory] = useState("");
  const [open, setOpen] = useState<{ path: string; content: string } | null>(null);
  const send = call as unknown as <T>(command: object) => Promise<T>;

  return (
    <aside className="panels" data-testid="panels">
      <nav className="tabs">
        {(["memory", "files", "automations", "tools"] as const).map((name) => (
          <button
            key={name}
            className={tab === name ? "active" : ""}
            data-testid={`tab-${name}`}
            onClick={() => setTab(name)}
          >
            {name}
            <span className="count">
              {name === "memory"
                ? state.memory.length
                : name === "files"
                  ? state.files.length
                  : name === "automations"
                    ? state.automations.filter((a) => a.active).length
                    : tools.length}
            </span>
          </button>
        ))}
      </nav>

      {tab === "memory" && (
        <div className="panel" data-testid="memory-panel">
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!newMemory.trim()) return;
              void send({ type: "memory.add", content: newMemory }).then(() => setNewMemory(""));
            }}
          >
            <input value={newMemory} placeholder="Add a fact…" onChange={(event) => setNewMemory(event.target.value)} />
            <button type="submit">Add</button>
          </form>
          {state.memory.length === 0 && <p className="muted">Nothing remembered yet. Tell GrokBot about yourself.</p>}
          <ul className="list">
            {state.memory.map((item) => (
              <li key={item.id} data-testid="memory-item">
                <span>{item.content}</span>
                <button className="icon" title="Forget" onClick={() => void send({ type: "memory.delete", memoryId: item.id })}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === "files" && (
        <div className="panel" data-testid="files-panel">
          {state.files.length === 0 && <p className="muted">No files yet. Ask GrokBot to write one.</p>}
          <ul className="list">
            {state.files.map((file) => (
              <li key={file.path} data-testid="file-item">
                <button
                  className="link"
                  onClick={() =>
                    void send<{ path: string; content: string | null }>({ type: "file.read", path: file.path }).then((result) =>
                      setOpen({ path: result.path, content: result.content ?? "(deleted)" })
                    )
                  }
                >
                  {file.path}
                </button>
                <span className="muted small">{file.size} ch · {ago(file.updatedAt)}</span>
                <button className="icon" title="Delete" onClick={() => void send({ type: "file.delete", path: file.path })}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {open && (
            <div className="file-viewer" data-testid="file-viewer">
              <div className="file-viewer-head">
                <strong>{open.path}</strong>
                <button className="icon" onClick={() => setOpen(null)}>✕</button>
              </div>
              <pre>{open.content}</pre>
            </div>
          )}
        </div>
      )}

      {tab === "automations" && (
        <div className="panel" data-testid="automations-panel">
          {state.automations.length === 0 && (
            <p className="muted">No scheduled tasks. Try “remind me in 1 minute to stand up”.</p>
          )}
          <ul className="list">
            {state.automations.map((item) => (
              <li key={item.id} data-testid="automation-item" className={item.active ? "" : "inactive"}>
                <div>
                  <div>{item.prompt}</div>
                  <div className="muted small">
                    {item.active ? `next ${new Date(item.nextRun).toLocaleString()}` : "finished"}
                    {item.everyMinutes ? ` · every ${item.everyMinutes} min` : ""} · thread {item.thread} · {item.runs} run
                    {item.runs === 1 ? "" : "s"}
                  </div>
                </div>
                <button className="icon" title="Cancel" onClick={() => void send({ type: "automation.delete", automationId: item.id })}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === "tools" && (
        <div className="panel">
          <ul className="list tools-list">
            {tools.map((tool) => (
              <li key={tool.name}>
                <div>
                  <code>{tool.name}</code>
                  <div className="muted small">{tool.description}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
