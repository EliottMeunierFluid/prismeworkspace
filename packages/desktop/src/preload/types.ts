export type InitStep = { phase: "server_waiting" } | { phase: "sqlite_waiting" } | { phase: "done" }

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type SqliteMigrationProgress = { type: "InProgress"; value: number } | { type: "Done" }

export type WslConfig = { enabled: boolean }

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
}

export type WindowConfig = {
  updaterEnabled: boolean
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: (onStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getWindowConfig: () => Promise<WindowConfig>
  consumeInitialDeepLinks: () => Promise<string[]>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  parseMarkdownCommand: (markdown: string) => Promise<string>
  checkAppExists: (appName: string) => Promise<boolean>
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>

  getWindowCount: () => Promise<number>
  onSqliteMigrationProgress: (cb: (progress: SqliteMigrationProgress) => void) => () => void
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    accept?: string[]
    extensions?: string[]
  }) => Promise<string | string[] | null>
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openLink: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  showNotification: (title: string, body?: string) => void
  getWindowFocused: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  writeTextFile: (path: string, content: string) => Promise<void>
  pathExists: (path: string) => Promise<boolean>
  renameFile: (oldPath: string, newPath: string) => Promise<void>
  deleteFile: (path: string) => Promise<void>
  createDirectory: (path: string) => Promise<void>
  deleteDirectory: (path: string) => Promise<void>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void>
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>

  // ─── Sync (Prisme Workspace) ─────────────────────────────────────────
  authSignIn: () => Promise<{
    ok: boolean
    email?: string
    plan?: "free" | "sync" | "team"
    error?: string
  }>
  authSignOut: () => Promise<void>
  authCurrentUser: () => Promise<{
    email: string
    plan: "free" | "sync" | "team"
  } | null>
  vaultsList: () => Promise<
    Array<{
      id: string
      name: string
      owner_type: "personal" | "team" | "company"
      region: string
      quota_bytes: number
      crypto_version: number
      /** Salt hex 64 chars (public — sert à dériver master_key côté client). */
      salt: string
      size_bytes: number
      version: number
      created_at: string
    }>
  >
  workspacesListConnected: () => Promise<
    Array<{
      workspaceRoot: string
      vaultId: string
      vaultName: string
      saltHex: string
      connectedAt: string
    }>
  >
  workspacesGetEntry: (root: string) => Promise<
    | {
        workspaceRoot: string
        vaultId: string
        vaultName: string
        saltHex: string
        connectedAt: string
      }
    | undefined
  >
  syncConnect: (args: {
    workspaceRoot: string
    vaultId: string
    vaultName: string
    saltHex: string
    vaultPassword: string
  }) => Promise<{
    ok: boolean
    error?: string
    status:
      | { state: "idle" }
      | { state: "activating" }
      | { state: "connecting" }
      | { state: "ready"; vaultVersion: number }
      | { state: "disconnected"; reason: string }
      | { state: "error"; message: string }
  }>
  syncDisconnect: (workspaceRoot: string) => Promise<void>
  syncStatus: () => Promise<
    | { state: "idle" }
    | { state: "activating" }
    | { state: "connecting" }
    | { state: "ready"; vaultVersion: number }
    | { state: "disconnected"; reason: string }
    | { state: "error"; message: string }
  >
}
