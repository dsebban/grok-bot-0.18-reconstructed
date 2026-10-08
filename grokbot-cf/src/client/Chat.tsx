import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, Part, RunningTool, ThreadView, ToolResult } from "../shared/view";
import { renderMarkdown } from "./markdown";

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function formatArgs(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function ToolCard({
  part,
  result,
  running
}: {
  part: Extract<Part, { type: "tool-call" }>;
  result?: ToolResult;
  running?: RunningTool;
}) {
  const state = result ? (result.error ? "error" : "done") : running ? "running" : "pending";
  return (
    <details className={`tool tool-${state}`} data-testid="tool-card" data-tool={part.name}>
      <summary>
        <span className="tool-icon">{state === "error" ? "✕" : state === "done" ? "✓" : "◌"}</span>
        <span className="tool-name">{part.name}</span>
        <span className="tool-state">{state}</span>
      </summary>
      <div className="tool-body">
        <div className="tool-label">Arguments</div>
        <pre>{formatArgs(part.args)}</pre>
        {(result || running?.output) && (
          <>
            <div className="tool-label">Result</div>
            <pre data-testid="tool-result">{result ? result.text : running?.output}</pre>
          </>
        )}
      </div>
    </details>
  );
}

function MessageView({
  message,
  view,
  live
}: {
  message: ChatMessage;
  view: ThreadView;
  live?: boolean;
}) {
  if (message.role === "notice") {
    return <div className="notice">{message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}</div>;
  }
  return (
    <div
      className={`message message-${message.role}${live ? " message-live" : ""}`}
      data-testid={live ? "message-live" : `message-${message.role}`}
    >
      <div className="avatar">{message.role === "user" ? "You" : "G"}</div>
      <div className="bubble">
        {message.parts.map((part, index) => {
          switch (part.type) {
            case "text":
              return message.role === "user" ? (
                <div key={index} className="plain">{part.text}</div>
              ) : (
                <Markdown key={index} text={part.text} />
              );
            case "thinking":
              return (
                <details key={index} className="thinking">
                  <summary>Thinking</summary>
                  <div>{part.text}</div>
                </details>
              );
            case "image":
              return <img key={index} alt="" src={`data:${part.mimeType};base64,${part.data}`} />;
            case "tool-call":
              return (
                <ToolCard
                  key={part.callId || index}
                  part={part}
                  result={view.results[part.callId]}
                  running={view.tools.find((tool) => tool.callId === part.callId)}
                />
              );
          }
        })}
        {message.interrupted && <div className="badge">interrupted</div>}
        {message.error && !message.interrupted && <div className="message-error">{message.error}</div>}
      </div>
    </div>
  );
}

export function Chat({
  view,
  disabled,
  onSend,
  onAbort
}: {
  view: ThreadView;
  disabled: boolean;
  onSend: (text: string, whenBusy?: "steer") => Promise<void>;
  onAbort: () => void;
}) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [view]);

  const submit = async (whenBusy?: "steer") => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      await onSend(text, whenBusy);
    } catch {
      setDraft(text);
    }
  };

  const empty = view.messages.length === 0 && !view.live;

  return (
    <div className="chat">
      <div
        className="messages"
        ref={scroller}
        data-testid="messages"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {empty && (
          <div className="empty">
            <h2>What can I do for you?</h2>
            <p>GrokBot remembers things, keeps files, reads the web and runs scheduled tasks — durably, on Cloudflare.</p>
            <div className="suggestions">
              {["help", "remember that I prefer short answers", "write /notes/ideas.md: durable agents", "what time is it?"].map(
                (suggestion) => (
                  <button key={suggestion} onClick={() => setDraft(suggestion)}>
                    {suggestion}
                  </button>
                )
              )}
            </div>
          </div>
        )}
        {view.messages.map((message) => (
          <MessageView key={message.id} message={message} view={view} />
        ))}
        {view.live && <MessageView message={view.live} view={view} live />}
        {view.running && !view.live && (
          <div className="typing" data-testid="typing">
            <span />
            <span />
            <span />
          </div>
        )}
        {view.retry && (
          <div className="notice warn">
            Retrying at {new Date(view.retry.at).toLocaleTimeString()}: {view.retry.error}
          </div>
        )}
        {view.error && <div className="notice error" data-testid="thread-error">{view.error}</div>}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          data-testid="composer"
          value={draft}
          placeholder={view.running ? "Queue a follow-up, or steer the running answer…" : "Message GrokBot…"}
          rows={Math.min(8, Math.max(1, draft.split("\n").length))}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-actions">
          {view.queued > 0 && <span className="queued" data-testid="queued">{view.queued} queued</span>}
          {view.running && (
            <>
              <button type="button" className="secondary" disabled={disabled || !draft.trim()} onClick={() => void submit("steer")}>
                Steer
              </button>
              <button type="button" className="danger" data-testid="stop" onClick={onAbort}>
                Stop
              </button>
            </>
          )}
          <button type="submit" data-testid="send" disabled={disabled || !draft.trim()}>
            {view.running ? "Queue" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
