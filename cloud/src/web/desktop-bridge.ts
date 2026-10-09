import type {
  AgentModelSelection,
  BridgeListener,
  CursorAuthStatus,
  DesktopBridge,
  DesktopUpdateStatus,
  McpServerState,
  SidebarSection,
  ThemePreference,
  ThemeState,
  Unsubscribe
} from "../../../frontend/src/recovered/contracts/desktop-bridge";
import type { WebSession } from "./session";

/**
 * `window.desktop` for the browser. The Grok Bot renderer from `frontend/`
 * was written against the Electron preload; this implements the same
 * contract with web primitives so the renderer runs unchanged:
 *
 * - account, models and agent preferences come from the GrokBot Worker;
 * - theme, sidebar layout and client persistence live in localStorage;
 * - desktop-only surfaces (updater, VNC computer, window chrome, box
 *   migration) report a stable "not available here" state.
 */

const PREFIX = "grokbot:";

function read(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, value);
  } catch {
    // Storage can be unavailable (private mode); the session still works.
  }
}

function readJson<T>(key: string, fallback: T): T {
  const raw = read(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

class Emitter<T> {
  readonly #listeners = new Set<BridgeListener<T>>();
  on(listener: BridgeListener<T>): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  emit(value: T): void {
    for (const listener of [...this.#listeners]) listener(value);
  }
}

const noop = () => {};
const never = (): Unsubscribe => noop;

function systemTheme(): "light" | "dark" {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/**
 * The renderer draws window controls for Windows and Linux; on macOS it
 * leaves them to the OS. A browser tab has neither, so always present as
 * macOS: no fake minimize/maximize/close buttons.
 */
function platform(): NodeJS.Platform {
  return "darwin";
}

const UPDATE_STATUS: DesktopUpdateStatus = {
  state: { type: "disabled", reason: "unsupported-platform" },
  currentVersion: "0.18.0-cloud",
  currentTrack: "stable",
  trackOverride: null,
  buildDefaultTrack: "stable",
  availableTracks: ["stable"],
  isTrackManagedByPolicy: true,
  isBelowMinimumVersion: false,
  autoUpdateWhenIdleOptIn: false,
  autoUpdateWhenIdleGateEnabled: false
};

const NO_MCP: McpServerState = { servers: [] };

/** Settings → Router's persistence key (frontend/.../settings/overlay/router.ts). */
const ROUTER_KEY = "settings.router-provider.v1";

function routerProviderOf(raw: string | null): string | undefined {
  try {
    const value = JSON.parse(raw ?? "null") as { provider?: unknown } | null;
    return typeof value?.provider === "string" ? value.provider : undefined;
  } catch {
    return undefined;
  }
}

export function createWebDesktopBridge(session: WebSession): DesktopBridge {
  // The bot needs the Router choice and time zone for turns it runs on its own.
  void session.syncSettings({
    routerProvider: routerProviderOf(read(`persist:${ROUTER_KEY}`)) ?? "cursor",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });
  const themeChanged = new Emitter<ThemeState>();
  const accountChanged = new Emitter<CursorAuthStatus>();
  const themeState = (): ThemeState => {
    const preference = (read("theme") as ThemePreference | null) ?? "system";
    return { preference, resolved: preference === "system" ? systemTheme() : preference };
  };
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => {
    if (themeState().preference === "system") themeChanged.emit(themeState());
  });

  const account = (): CursorAuthStatus => ({
    kind: "logged-in",
    authId: `grokbot:${session.bot}`,
    email: `${session.bot}@grokbot.cloud`,
    displayName: read("display-name") ?? "You",
    isAnysphereUser: false
  });

  const bridge = {
    async resolveAttachmentMedia() {
      return null;
    },
    async readAttachmentText() {
      return null;
    },
    async readAttachmentBytes() {
      return null;
    },
    async downloadAttachment() {
      return false;
    },
    async getLinkMetadata() {
      return null;
    },
    async openExternal(url) {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    async openCloudAgent() {},
    async stageAttachmentBytes() {
      return { ok: false, reason: "failed" };
    },
    async commitStagedAttachments() {
      return null;
    },
    async discardStagedAttachment() {},
    mcp: {
      async list() {
        return NO_MCP;
      },
      async effectivePlugins() {
        return [];
      },
      async catalog() {
        return [];
      },
      async teamPopularity() {
        return {};
      },
      async pluginLogo() {
        return null;
      },
      async install() {
        return NO_MCP;
      },
      async updatePluginInstall() {
        return NO_MCP;
      },
      async remove() {
        return { state: NO_MCP, removed: false };
      },
      async uninstallPlugin() {
        return { state: NO_MCP, removed: false };
      },
      async authenticate(serverId) {
        return { status: "not-supported", serverName: serverId, message: "Plugins are not available in GrokBot Cloud yet." };
      },
      async renameAccount() {
        return NO_MCP;
      },
      async removeAccount() {
        return NO_MCP;
      },
      async setCustomInstructions() {
        return NO_MCP;
      },
      async listServerTools() {
        return [];
      },
      async toggleToolDisabled() {
        return [];
      },
      onAuthCompleted: never
    },
    async forceGatewayReconnect() {
      session.reconnect();
    },
    async pickAvatarSource() {
      return null;
    },
    async pickAvatarFile() {
      return null;
    },
    async generateAgentAvatarImage() {
      throw new Error("Avatar generation is not available in GrokBot Cloud.");
    },
    onFocusAgent: never,
    onDeepLink: never,
    async deepLinksReady() {},
    async getBoxMigrationStatus() {
      return null;
    },
    onBoxMigration: never,
    onDevBoxRebuild: never,
    onOpenFeedback: never,
    onOpenAbout: never,
    async submitFeedback() {
      return { ok: true };
    },
    onWidgetGallery: never,
    onForceOnboarding: never,
    async transcribeAudio() {
      throw new Error("Voice input is not available in GrokBot Cloud.");
    },
    cursorAccount: {
      async getStatus() {
        return account();
      },
      async login() {
        return account();
      },
      async cancelLogin() {
        return account();
      },
      async logout() {
        session.signOut();
        return account();
      },
      async updateName(name) {
        write("display-name", name);
        const status = account();
        accountChanged.emit(status);
        return status;
      },
      async getAvatar() {
        return null;
      },
      async getWeeklyUsage() {
        return null;
      },
      async getUsageSummary() {
        return null;
      },
      async getPrReviewPreferences() {
        return null;
      },
      async getPrivacyModeEnabled() {
        return false;
      },
      async getSandAccess() {
        return { state: "granted", reason: "none" };
      },
      async getSandAccessFresh() {
        return { state: "granted", reason: "none" };
      },
      async invokeDashboardAction() {
        return null;
      },
      async cancelTrial() {
        return null;
      },
      onStatusChanged: (listener) => accountChanged.on(listener)
    },
    experiments: {
      initialSnapshot: { flags: {}, overrides: {} },
      async getSnapshot() {
        return { flags: {}, overrides: {} };
      },
      async applyFeatureFlagOverride() {},
      async refresh() {},
      async startRpcTraceWindow() {
        return false;
      },
      onChanged: never
    },
    platform: platform(),
    isDev: false,
    async getWindowState() {
      return { isFullscreen: false, isMaximized: false };
    },
    onWindowStateEvent: never,
    getZoomFactor() {
      return 1;
    },
    onZoomFactorEvent: never,
    windowControls: {
      async minimize() {},
      async toggleMaximize() {},
      async close() {},
      async setTitleBarOverlayTone() {},
      async resizeWidth() {
        return window.innerWidth;
      }
    },
    foreverBox: {
      async forceRecreate() {
        return null;
      },
      async update() {
        return null;
      },
      onVncUserPresence: never,
      onDevBoxPullProgress: never,
      egressTunnel: {
        initial: false,
        initialStatus: null,
        async get() {
          return false;
        },
        async set() {
          return false;
        },
        onChanged: never,
        async getStatus() {
          return null;
        },
        onStatusChanged: never
      },
      webauthnProxy: {
        initial: false,
        async get() {
          return false;
        },
        async set() {
          return false;
        },
        onChanged: never
      }
    },
    onboarding: {
      async getSeen() {
        return true;
      },
      async setSeen() {},
      onSkip: never
    },
    telemetry: {
      reportAgentLoad: noop,
      reportBoxVisibility: noop,
      reportSendLatency: noop,
      reportHeapMetrics: noop,
      reportSendAck: noop,
      reportReactionAck: noop,
      reportRenderTtfr: noop,
      reportRenderStream: noop,
      reportAgentsUnreachable: noop,
      reportAccessBlocked: noop,
      reportRecoveryAction: noop,
      reportRebuildLifecycle: noop,
      reportReconciliation: noop,
      reportVncSession: noop,
      reportVncLiveness: noop,
      reportOpenComputer: noop,
      reportUpdatePrompt: noop,
      reportSigninGate: noop,
      reportOnboardingStep: noop,
      reportClientFailure: noop,
      noteSentryConversation: noop
    },
    timeZone: {
      async get() {
        return {
          detectedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
          overrideTimeZone: read("time-zone")
        };
      },
      async setOverride(timeZone) {
        write("time-zone", timeZone);
        return {
          detectedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
          overrideTimeZone: timeZone
        };
      }
    },
    autoReviewInstructions: {
      async get() {
        return readJson("auto-review", { isEnabled: false, allowInstructions: [], blockInstructions: [] });
      },
      async set(instructions) {
        write("auto-review", JSON.stringify(instructions));
        return instructions;
      }
    },
    localToolPermission: {
      async get() {
        return null;
      },
      async set(permission) {
        return permission;
      },
      async ceiling() {
        return null;
      },
      async recordApproval() {},
      async clearApprovals() {}
    },
    theme: {
      initial: themeState(),
      async get() {
        return themeState();
      },
      async set(preference) {
        write("theme", preference);
        const state = themeState();
        themeChanged.emit(state);
        return state;
      },
      onChanged: (listener) => themeChanged.on(listener)
    },
    // Provider keys pasted in Settings → Router are stored by the bot.
    secrets: {
      async list() {
        const { keys, isPersistent } = await session.api<{ keys: string[]; isPersistent: boolean }>("secrets");
        return { keys, isPersistent };
      },
      async reveal() {
        return null;
      },
      async upsert(entries) {
        await session.api("secrets", { upsert: entries });
        return { synced: true };
      },
      async remove(keys) {
        await session.api("secrets", { remove: [...keys] });
        return { synced: true };
      }
    },
    agent: {
      // Settings → Router (main's renderer patch) and its Computer section.
      async getInferenceRouter() {
        return session.api("router");
      },
      async setInferenceRouter(provider: string) {
        return session.api("router", { provider });
      },
      async getBoxRuntime() {
        return { mode: "remote", status: null };
      },
      async setBoxRuntime() {
        throw new Error("GrokBot Cloud has no local Docker computer.");
      },
      // Pins and sections live in the bot, like the desktop host's, so they
      // follow the bot space across browsers.
      async getPinnedAgents() {
        return (await session.api<{ pinnedAgentIds: string[] | null }>("sidebar")).pinnedAgentIds;
      },
      async setPinnedAgents(ids) {
        return (await session.api<{ pinnedAgentIds: string[] | null }>("sidebar", { pinnedAgentIds: [...ids] })).pinnedAgentIds;
      },
      async getSidebarSections() {
        return (await session.api<{ sections: SidebarSection[] | null }>("sidebar")).sections;
      },
      async setSidebarSections(sections) {
        return (await session.api<{ sections: SidebarSection[] | null }>("sidebar", { sections: [...sections] })).sections;
      },
      async getDefaultModel() {
        return session.defaultModel();
      },
      async setDefaultModel(model: AgentModelSelection) {
        return session.setDefaultModel(model);
      },
      async getComputerUseModel() {
        return null;
      },
      async setComputerUseModel() {
        return null;
      },
      async getAvailableModels() {
        return session.availableModels();
      },
      clientPersistence: {
        async read(key) {
          return read(`persist:${key}`);
        },
        async write(key, value) {
          write(`persist:${key}`, value);
          if (key === ROUTER_KEY) void session.syncSettings({ routerProvider: routerProviderOf(value) });
        },
        async remove(key) {
          write(`persist:${key}`, null);
        },
        async listKeys(prefix) {
          const keys: string[] = [];
          try {
            for (let index = 0; index < localStorage.length; index++) {
              const key = localStorage.key(index);
              if (key?.startsWith(`${PREFIX}persist:${prefix}`)) keys.push(key.slice(`${PREFIX}persist:`.length));
            }
          } catch {
            // Storage unavailable.
          }
          return keys;
        },
        async migrateFromLocalStorage() {
          return true;
        }
      }
    },
    update: {
      async getStatus() {
        return UPDATE_STATUS;
      },
      async check() {
        return UPDATE_STATUS;
      },
      async setTrack() {
        return UPDATE_STATUS;
      },
      async quitAndInstall() {},
      async setAutoUpdateWhenIdleOptIn() {
        return UPDATE_STATUS;
      },
      onStatusEvent: never
    },
    attachProdBox: {
      async getStatus() {
        return null;
      },
      async setEnabled() {
        return null;
      }
    }
  } satisfies DesktopBridge & { agent: Record<string, unknown> };
  return bridge;
}
