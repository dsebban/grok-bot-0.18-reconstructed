import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { isThreadId, modelKey, parseModelKey, ROOT_THREAD, type UsageInfo } from "../shared/protocol";
import { apiUrl } from "./api";
import { Chat } from "./Chat";
import { Panels } from "./Panels";
import { useBot } from "./useBot";
import "./styles.css";

const TOKEN_KEY = "grokbot:token";
const BOT_KEY = "grokbot:bot";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable (private mode); the session still works.
  }
}

type Route = { bot: string; thread: string };

function parseRoute(): Route {
  const [bot, thread] = window.location.hash.replace(/^#\/?/, "").split("/");
  return {
    bot: bot && /^[A-Za-z0-9_-]{1,64}$/.test(bot) ? bot : (readStorage(BOT_KEY) ?? "default"),
    thread: thread && isThreadId(thread) ? thread : ROOT_THREAD
  };
}

function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const navigate = useCallback((next: Route) => {
    writeStorage(BOT_KEY, next.bot);
    window.location.hash = `/${next.bot}/${next.thread}`;
  }, []);
  return [route, navigate];
}

function TokenGate({ onToken }: { onToken: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="gate">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onToken(value.trim());
        }}
      >
        <h1>GrokBot</h1>
        <p>This deployment is protected. Enter its access token.</p>
        <input type="password" value={value} autoFocus onChange={(event) => setValue(event.target.value)} />
        <button type="submit">Continue</button>
      </form>
    </div>
  );
}

function Workspace({ route, navigate, token, onUnauthorized }: {
  route: Route;
  navigate: (route: Route) => void;
  token: string | null;
  onUnauthorized: () => void;
}) {
  const { view, state, models, tools, status, call, lastError, clearError } = useBot(route.bot, route.thread, token);
  const [showArchived, setShowArchived] = useState(false);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const thread = state.threads.find((item) => item.id === route.thread);
  const title = thread?.title ?? (route.thread === ROOT_THREAD ? "First thread" : `Thread ${route.thread}`);

  useEffect(() => {
    if (status !== "open" || view.running) return;
    call<UsageInfo>({ type: "usage" }).then(setUsage, () => undefined);
  }, [status, view.running, view.messages.length, call]);

  useEffect(() => {
    if (status === "closed" && token) {
      fetch(apiUrl(`/api/bots/${route.bot}/threads`), { headers: { authorization: `Bearer ${token}` } })
        .then((response) => response.status === 401 && onUnauthorized())
        .catch(() => undefined);
    }
  }, [status, token, route.bot, onUnauthorized]);

  const grouped = useMemo(() => {
    const groups = new Map<string, typeof models>();
    for (const model of models) groups.set(model.group, [...(groups.get(model.group) ?? []), model]);
    return [...groups];
  }, [models]);

  const threads = state.threads.filter((item) => showArchived || !item.archived || item.id === route.thread);

  const openThread = (id: string) => {
    setSidebar(false);
    navigate({ bot: route.bot, thread: id });
  };

  return (
    <div className={`app${sidebar ? " sidebar-open" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">G</span>
          <div>
            <div className="brand-name">GrokBot</div>
            <button
              className="bot-name"
              title="Switch bot"
              onClick={() => {
                const next = prompt("Open bot (each bot has its own threads, memory and files):", route.bot);
                if (next && /^[A-Za-z0-9_-]{1,64}$/.test(next)) navigate({ bot: next, thread: ROOT_THREAD });
              }}
            >
              {route.bot} ▾
            </button>
          </div>
        </div>
        <button
          className="new-thread"
          data-testid="new-thread"
          onClick={() => void call<{ thread: string }>({ type: "thread.create" }).then((result) => openThread(result.thread))}
        >
          + New thread
        </button>
        <ul className="threads" data-testid="threads">
          {threads.map((item) => (
            <li key={item.id}>
              <button
                className={`thread${item.id === route.thread ? " active" : ""}${item.archived ? " archived" : ""}`}
                data-testid="thread-item"
                onClick={() => openThread(item.id)}
              >
                <span className="thread-title">{item.title}</span>
                {item.busy && <span className="dot" title="Running" />}
              </button>
            </li>
          ))}
        </ul>
        <label className="archived-toggle">
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived
        </label>
        <div className={`status status-${status}`} data-testid="status">
          {status === "open" ? "Connected" : status === "connecting" ? "Connecting…" : "Reconnecting…"}
        </div>
      </aside>

      <main className="main">
        <header className="header">
          <button className="icon menu" onClick={() => setSidebar(!sidebar)} aria-label="Threads">☰</button>
          <h1
            className="title"
            data-testid="thread-title"
            title="Rename"
            onClick={() => {
              const next = prompt("Rename thread", title);
              if (next?.trim()) void call({ type: "thread.rename", title: next });
            }}
          >
            {title}
          </h1>
          <select
            className="model-picker"
            data-testid="model-picker"
            value={view.model ? modelKey(view.model) : ""}
            onChange={(event) => {
              const model = parseModelKey(event.target.value);
              if (model) void call({ type: "model.set", model });
            }}
          >
            {view.model && !models.some((model) => modelKey(model) === modelKey(view.model!)) && (
              <option value={modelKey(view.model)}>{view.model.modelId}</option>
            )}
            {grouped.map(([group, items]) => (
              <optgroup key={group} label={group}>
                {items.map((model) => (
                  <option key={modelKey(model)} value={modelKey(model)}>
                    {model.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {usage && (usage.input > 0 || usage.output > 0) && (
            <span className="usage" title="Tokens used in this thread">
              {usage.input.toLocaleString()} in · {usage.output.toLocaleString()} out
              {usage.cost > 0 ? ` · $${usage.cost.toFixed(4)}` : ""}
            </span>
          )}
          <div className="header-actions">
            <button
              className="secondary"
              title="Fork this thread"
              data-testid="fork"
              onClick={() => void call<{ thread: string }>({ type: "thread.fork" }).then((result) => openThread(result.thread), (error: Error) => alert(error.message))}
            >
              Fork
            </button>
            <button className="secondary" title="Start a fresh context in this thread" onClick={() => void call({ type: "reset" })}>
              Reset
            </button>
            <button
              className="secondary"
              onClick={() => void call({ type: "thread.archive", archived: !thread?.archived })}
            >
              {thread?.archived ? "Unarchive" : "Archive"}
            </button>
          </div>
        </header>
        {lastError && (
          <div className="banner" onClick={clearError}>
            {lastError} <span className="muted">(dismiss)</span>
          </div>
        )}
        <Chat
          view={view}
          disabled={status !== "open"}
          onSend={async (text, whenBusy) => {
            await call({ type: "send", text, ...(whenBusy ? { whenBusy } : {}), operationId: crypto.randomUUID() });
          }}
          onAbort={() => void call({ type: "abort" })}
        />
      </main>

      <Panels state={state} tools={tools} call={call as never} />
    </div>
  );
}

function App() {
  const [route, navigate] = useRoute();
  const [token, setToken] = useState<string | null>(() => readStorage(TOKEN_KEY));
  const [needsToken, setNeedsToken] = useState<boolean | null>(null);

  useEffect(() => {
    fetch(apiUrl("/api/config"))
      .then((response) => response.json() as Promise<{ auth: boolean }>)
      .then((config) => setNeedsToken(config.auth))
      .catch(() => setNeedsToken(false));
  }, []);

  const onUnauthorized = useCallback(() => {
    writeStorage(TOKEN_KEY, null);
    setToken(null);
  }, []);

  if (needsToken === null) return <div className="gate"><p className="muted">Loading…</p></div>;
  if (needsToken && !token) {
    return (
      <TokenGate
        onToken={(value) => {
          writeStorage(TOKEN_KEY, value);
          setToken(value);
        }}
      />
    );
  }
  return <Workspace route={route} navigate={navigate} token={needsToken ? token : null} onUnauthorized={onUnauthorized} />;
}

createRoot(document.getElementById("root")!).render(<App />);
