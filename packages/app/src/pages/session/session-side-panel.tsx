import { For, Match, Show, Switch, createEffect, createMemo, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { createOpenSessionFileTab, createSessionTabs, getTabReorderIndex, type Sizing } from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  size: Sizing
}) {
  const layout = useLayout()
  const platform = usePlatform()
  const settings = useSettings()
  const sync = useSync()
  const file = useFile()
  const sdk = useSDK()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const { sessionKey, tabs, view } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const shown = createMemo(
    () =>
      platform.platform !== "desktop" ||
      import.meta.env.VITE_OPENCODE_CHANNEL !== "beta" ||
      settings.general.showFileTree(),
  )

  const reviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const fileOpen = createMemo(() => isDesktop() && shown() && layout.fileTree.opened())
  const open = createMemo(() => reviewOpen() || fileOpen())
  const reviewTab = createMemo(() => false)
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (reviewOpen()) return `calc(100% - ${layout.session.width()}px)`
    return `${layout.fileTree.width()}px`
  })
  const treeWidth = createMemo(() => (fileOpen() ? `${layout.fileTree.width()}px` : "0px"))

  const diffFiles = createMemo(() => props.diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of props.diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const sanitizeNoteName = (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return ""
    const cleaned = trimmed.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ")
    return cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`
  }

  const createNote = async () => {
    const dir = sdk.directory
    if (!dir || !platform.writeTextFile || !platform.pathExists) {
      showToast({
        variant: "error",
        title: "No workspace open",
        description: "Open a workspace before creating a note.",
      })
      return
    }

    const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/"

    const writeNote = async (rawName: string) => {
      const filename = sanitizeNoteName(rawName)
      if (!filename) throw new Error(language.t("dialog.note.create.name.label"))
      const absolute = `${dir}${sep}${filename}`
      if (await platform.pathExists!(absolute)) {
        throw new Error(language.t("dialog.note.create.error.exists"))
      }
      const baseName = filename.replace(/\.md$/, "")
      const body = language.t("notes.create.defaultBody").replace("{{name}}", baseName)
      await platform.writeTextFile!(absolute, body)
      void file.tree.refresh("")
      void file.tree.expand("")
      view().reviewPanel.open()
      openTab(file.tab(filename))
    }

    void import("@/components/dialog-create-note").then((x) => {
      dialog.show(() => (
        <x.DialogCreateNote
          defaultName={language.t("notes.create.defaultName")}
          onConfirm={async (rawName) => {
            try {
              await writeNote(rawName)
            } catch (err) {
              showToast({
                variant: "error",
                title: "Failed to create note",
                description: err instanceof Error ? err.message : String(err),
              })
              throw err
            }
          }}
        />
      ))
    })
  }

  const absoluteWorkspacePath = (relative: string) => {
    const dir = sdk.directory
    if (!dir) return null
    const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/"
    const cleaned = relative.replace(/^[/\\]+/, "")
    const absolute = `${dir}${sep}${cleaned}`
    if (!absolute.startsWith(dir)) return null
    return absolute
  }

  const parentOf = (relative: string) => {
    const cleaned = relative.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "")
    const lastSlash = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"))
    return lastSlash > 0 ? cleaned.slice(0, lastSlash) : ""
  }

  const refreshTreeAt = (relative: string) => {
    void file.tree.refresh(parentOf(relative))
  }

  const renameFile = (node: { path: string; name: string }) => {
    if (!platform.renameFile || !platform.pathExists) {
      showToast({
        variant: "error",
        title: language.t("toast.file.rename.failed.title"),
        description: "Rename is not supported on this platform.",
      })
      return
    }
    const absolute = absoluteWorkspacePath(node.path)
    if (!absolute) return

    const lastSlash = Math.max(absolute.lastIndexOf("/"), absolute.lastIndexOf("\\"))
    const parentDir = lastSlash > 0 ? absolute.slice(0, lastSlash) : absolute
    const sep = absolute.includes("\\") && !absolute.includes("/") ? "\\" : "/"
    const ext = (() => {
      const dot = node.name.lastIndexOf(".")
      return dot > 0 ? node.name.slice(dot) : ""
    })()

    void import("@/components/dialog-rename-file").then((x) => {
      dialog.show(() => (
        <x.DialogRenameFile
          currentName={node.name}
          onConfirm={async (rawName) => {
            const trimmed = rawName.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ")
            const newName = trimmed.includes(".") || !ext ? trimmed : `${trimmed}${ext}`
            const newAbsolute = `${parentDir}${sep}${newName}`
            if (newAbsolute === absolute) return
            try {
              if (await platform.pathExists!(newAbsolute)) {
                throw new Error(language.t("dialog.file.rename.error.exists"))
              }
              const oldTabId = file.tab(node.path)
              const parentRelative = parentOf(node.path)
              const newRelative = parentRelative ? pathJoin(parentRelative, newName) : newName
              const newTabId = file.tab(newRelative)
              const currentTabs = tabs().all()
              const idx = currentTabs.indexOf(oldTabId)
              const wasOpen = idx !== -1
              const wasActive = tabs().active() === oldTabId

              if (wasOpen) {
                try {
                  tabs().close(oldTabId)
                } catch {}
                await new Promise((resolve) => setTimeout(resolve, 200))
              }
              await platform.renameFile!(absolute, newAbsolute)
              refreshTreeAt(node.path)
              if (wasOpen) {
                const refreshedTabs = tabs().all().filter((t) => t !== newTabId)
                const insertIdx = Math.min(idx, refreshedTabs.length)
                const nextTabs = [...refreshedTabs.slice(0, insertIdx), newTabId, ...refreshedTabs.slice(insertIdx)]
                tabs().setAll(nextTabs)
                if (wasActive) tabs().setActive(newTabId)
              }
            } catch (err) {
              showToast({
                variant: "error",
                title: language.t("toast.file.rename.failed.title"),
                description: err instanceof Error ? err.message : String(err),
              })
              throw err
            }
          }}
        />
      ))
    })
  }

  const deleteFile = (node: { path: string; name: string }) => {
    if (!platform.deleteFile) {
      showToast({
        variant: "error",
        title: language.t("toast.file.delete.failed.title"),
        description: "Delete is not supported on this platform.",
      })
      return
    }
    const absolute = absoluteWorkspacePath(node.path)
    if (!absolute) return

    void import("@/components/dialog-confirm-delete-file").then((x) => {
      dialog.show(() => (
        <x.DialogConfirmDeleteFile
          filename={node.name}
          kind="file"
          onConfirm={async () => {
            try {
              const tabId = file.tab(node.path)
              const wasOpen = tabs().all().some((tab) => tab === tabId)
              if (wasOpen) {
                try {
                  tabs().close(tabId)
                } catch {}
                await new Promise((resolve) => setTimeout(resolve, 200))
              }
              await platform.deleteFile!(absolute)
              refreshTreeAt(node.path)
            } catch (err) {
              showToast({
                variant: "error",
                title: language.t("toast.file.delete.failed.title"),
                description: err instanceof Error ? err.message : String(err),
              })
              throw err
            }
          }}
        />
      ))
    })
  }

  const pathJoin = (base: string, child: string) => {
    if (!base) return child
    const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/"
    return `${base}${sep}${child}`
  }

  const sanitizeName = (raw: string) => raw.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ")

  const createFileAt = (parentRelative: string) => {
    if (!platform.writeTextFile || !platform.pathExists) return
    const parentAbsolute = absoluteWorkspacePath(parentRelative)
    if (parentAbsolute === null) return

    void import("@/components/dialog-create-file").then((x) => {
      dialog.show(() => (
        <x.DialogCreateFile
          defaultName=""
          onConfirm={async (rawName) => {
            const filename = sanitizeName(rawName)
            if (!filename) return
            const absolute = pathJoin(parentAbsolute, filename)
            try {
              if (await platform.pathExists!(absolute)) {
                throw new Error(language.t("dialog.file.create.error.exists"))
              }
              await platform.writeTextFile!(absolute, "")
              void file.tree.refresh(parentRelative)
              void file.tree.expand(parentRelative)
              const relative = parentRelative ? pathJoin(parentRelative, filename) : filename
              view().reviewPanel.open()
              openTab(file.tab(relative))
            } catch (err) {
              showToast({
                variant: "error",
                title: language.t("toast.file.create.failed.title"),
                description: err instanceof Error ? err.message : String(err),
              })
              throw err
            }
          }}
        />
      ))
    })
  }

  const createDirectoryAt = (parentRelative: string) => {
    if (!platform.createDirectory || !platform.pathExists) {
      showToast({
        variant: "error",
        title: language.t("toast.directory.create.failed.title"),
        description: "Create folder is not supported on this platform.",
      })
      return
    }
    const parentAbsolute = absoluteWorkspacePath(parentRelative)
    if (parentAbsolute === null) return

    void import("@/components/dialog-create-directory").then((x) => {
      dialog.show(() => (
        <x.DialogCreateDirectory
          defaultName={language.t("dialog.directory.create.defaultName")}
          onConfirm={async (rawName) => {
            const dirname = sanitizeName(rawName)
            if (!dirname) return
            const absolute = pathJoin(parentAbsolute, dirname)
            try {
              if (await platform.pathExists!(absolute)) {
                throw new Error(language.t("dialog.directory.create.error.exists"))
              }
              await platform.createDirectory!(absolute)
              void file.tree.refresh(parentRelative)
              void file.tree.expand(parentRelative)
            } catch (err) {
              showToast({
                variant: "error",
                title: language.t("toast.directory.create.failed.title"),
                description: err instanceof Error ? err.message : String(err),
              })
              throw err
            }
          }}
        />
      ))
    })
  }

  const renameDirectory = (node: { path: string; name: string }) => {
    if (!platform.renameFile || !platform.pathExists) {
      showToast({
        variant: "error",
        title: language.t("toast.directory.rename.failed.title"),
        description: "Rename is not supported on this platform.",
      })
      return
    }
    const absolute = absoluteWorkspacePath(node.path)
    if (!absolute) return

    const lastSlash = Math.max(absolute.lastIndexOf("/"), absolute.lastIndexOf("\\"))
    const parentDir = lastSlash > 0 ? absolute.slice(0, lastSlash) : absolute
    const sep = absolute.includes("\\") && !absolute.includes("/") ? "\\" : "/"

    void import("@/components/dialog-rename-file").then((x) => {
      dialog.show(() => (
        <x.DialogRenameFile
          currentName={node.name}
          kind="directory"
          onConfirm={async (rawName) => {
            const newName = sanitizeName(rawName)
            if (!newName) return
            const newAbsolute = `${parentDir}${sep}${newName}`
            if (newAbsolute === absolute) return
            try {
              if (await platform.pathExists!(newAbsolute)) {
                throw new Error(language.t("dialog.file.rename.error.exists"))
              }
              const dirPrefix = node.path.replace(/[/\\]+$/, "") + "/"
              const dirPrefixWin = node.path.replace(/[/\\]+$/, "") + "\\"
              const openTabs = tabs().all()
              const closedAny = openTabs.some((tabId) => {
                const filePath = file.pathFromTab(tabId)
                if (!filePath) return false
                if (filePath.startsWith(dirPrefix) || filePath.startsWith(dirPrefixWin)) {
                  try {
                    tabs().close(tabId)
                  } catch {}
                  return true
                }
                return false
              })
              if (closedAny) {
                await new Promise((resolve) => setTimeout(resolve, 200))
              }
              await platform.renameFile!(absolute, newAbsolute)
              refreshTreeAt(node.path)
            } catch (err) {
              showToast({
                variant: "error",
                title: language.t("toast.directory.rename.failed.title"),
                description: err instanceof Error ? err.message : String(err),
              })
              throw err
            }
          }}
        />
      ))
    })
  }

  const deleteDirectory = (node: { path: string; name: string }) => {
    if (!platform.deleteDirectory) {
      showToast({
        variant: "error",
        title: language.t("toast.directory.delete.failed.title"),
        description: "Delete folder is not supported on this platform.",
      })
      return
    }
    const absolute = absoluteWorkspacePath(node.path)
    if (!absolute) return

    void import("@/components/dialog-confirm-delete-file").then((x) => {
      dialog.show(() => (
        <x.DialogConfirmDeleteFile
          filename={node.name}
          kind="directory"
          onConfirm={async () => {
            try {
              const dirPrefix = node.path.replace(/[/\\]+$/, "") + "/"
              const dirPrefixWin = node.path.replace(/[/\\]+$/, "") + "\\"
              const openTabs = tabs().all()
              const closedAny = openTabs.some((tabId) => {
                const filePath = file.pathFromTab(tabId)
                if (!filePath) return false
                if (filePath.startsWith(dirPrefix) || filePath.startsWith(dirPrefixWin)) {
                  try {
                    tabs().close(tabId)
                  } catch {}
                  return true
                }
                return false
              })
              if (closedAny) {
                await new Promise((resolve) => setTimeout(resolve, 200))
              }
              await platform.deleteDirectory!(absolute)
              refreshTreeAt(node.path)
            } catch (err) {
              showToast({
                variant: "error",
                title: language.t("toast.directory.delete.failed.title"),
                description: err instanceof Error ? err.message : String(err),
              })
              throw err
            }
          }}
        />
      ))
    })
  }

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  const activeFilePath = createMemo(() => {
    const tab = activeFileTab()
    if (!tab) return undefined
    return file.pathFromTab(tab)
  })

  createEffect(() => {
    const path = activeFilePath()
    if (!path) return
    const cleaned = path.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "")
    if (!cleaned) return
    const segments = cleaned.split(/[/\\]/)
    let accumulated = ""
    for (let i = 0; i < segments.length - 1; i++) {
      accumulated = accumulated ? `${accumulated}/${segments[i]}` : segments[i]
      void file.tree.expand(accumulated)
    }
  })

  const fileTreeTab = () => layout.fileTree.tab()

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop()}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active() && !props.reviewSnap,
        }}
        style={{ width: panelWidth() }}
      >
        <div class="size-full flex border-l border-border-weaker-base">
          <div
            aria-hidden={!reviewOpen()}
            inert={!reviewOpen()}
            class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
            classList={{
              "pointer-events-none": !reviewOpen(),
            }}
          >
            <div class="size-full min-w-0 h-full bg-background-base">
              <DragDropProvider
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver}
                collisionDetector={closestCenter}
              >
                <DragDropSensors />
                <ConstrainDragYAxis />
                <Tabs value={activeTab()} onChange={openTab}>
                  <div class="sticky top-0 shrink-0 flex">
                    <Tabs.List
                      ref={(el: HTMLDivElement) => {
                        const stop = createFileTabListSync({ el, contextOpen })
                        onCleanup(stop)
                      }}
                    >
                      <Show when={reviewTab() && props.canReview()}>
                        <Tabs.Trigger value="review">
                          <div class="flex items-center gap-1.5">
                            <div>{language.t("session.tab.review")}</div>
                            <Show when={props.hasReview()}>
                              <div>{props.reviewCount()}</div>
                            </Show>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <Show when={contextOpen()}>
                        <Tabs.Trigger
                          value="context"
                          closeButton={
                            <TooltipKeybind
                              title={language.t("common.closeTab")}
                              keybind={command.keybind("tab.close")}
                              placement="bottom"
                              gutter={10}
                            >
                              <IconButton
                                icon="close-small"
                                variant="ghost"
                                class="h-5 w-5"
                                onClick={() => tabs().close("context")}
                                aria-label={language.t("common.closeTab")}
                              />
                            </TooltipKeybind>
                          }
                          hideCloseButton
                          onMiddleClick={() => tabs().close("context")}
                        >
                          <div class="flex items-center gap-2">
                            <SessionContextUsage variant="indicator" />
                            <div>{language.t("session.tab.context")}</div>
                          </div>
                        </Tabs.Trigger>
                      </Show>
                      <SortableProvider ids={openedTabs()}>
                        <For each={openedTabs()}>{(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}</For>
                      </SortableProvider>
                      <div class="bg-background-stronger h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pr-3 gap-1">
                        <Tooltip value={language.t("notes.empty.create")} class="flex items-center">
                          <IconButton
                            icon="new-session"
                            variant="ghost"
                            iconSize="normal"
                            class="!rounded-md"
                            onClick={() => void createNote()}
                            aria-label={language.t("notes.empty.create")}
                          />
                        </Tooltip>
                        <TooltipKeybind
                          title={language.t("command.file.open")}
                          keybind={command.keybind("file.open")}
                          class="flex items-center"
                        >
                          <IconButton
                            icon="plus-small"
                            variant="ghost"
                            iconSize="large"
                            class="!rounded-md"
                            onClick={() => {
                              void import("@/components/dialog-select-file").then((x) => {
                                dialog.show(() => <x.DialogSelectFile mode="files" onOpenFile={showAllFiles} />)
                              })
                            }}
                            aria-label={language.t("command.file.open")}
                          />
                        </TooltipKeybind>
                      </div>
                    </Tabs.List>
                  </div>

                  <Show when={reviewTab() && props.canReview()}>
                    <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "review"}>{props.reviewPanel()}</Show>
                    </Tabs.Content>
                  </Show>

                  <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                    <Show when={activeTab() === "empty"}>
                      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                        <div class="h-full w-full px-6 flex flex-col items-center justify-center text-center gap-4">
                          <Mark class="w-14 opacity-20" />
                          <div class="flex flex-col gap-1.5 max-w-72">
                            <div class="text-14-medium text-text-base">{language.t("notes.empty.title")}</div>
                            <div class="text-13-regular text-text-weak">
                              {language.t("notes.empty.description")}
                            </div>
                          </div>
                          <Button size="normal" onClick={() => void createNote()}>
                            {language.t("notes.empty.create")}
                          </Button>
                        </div>
                      </div>
                    </Show>
                  </Tabs.Content>

                  <Show when={contextOpen()}>
                    <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "context"}>
                        <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                          <SessionContextTab />
                        </div>
                      </Show>
                    </Tabs.Content>
                  </Show>

                  <Show when={activeFileTab()} keyed>
                    {(tab) => <FileTabContent tab={tab} />}
                  </Show>
                </Tabs>
                <DragOverlay>
                  <Show when={store.activeDraggable} keyed>
                    {(tab) => {
                      const path = file.pathFromTab(tab)
                      return (
                        <div data-component="tabs-drag-preview">
                          <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                        </div>
                      )
                    }}
                  </Show>
                </DragOverlay>
              </DragDropProvider>
            </div>
          </div>

          <Show when={shown()}>
            <div
              id="file-tree-panel"
              aria-hidden={!fileOpen()}
              inert={!fileOpen()}
              class="relative min-w-0 h-full shrink-0 overflow-hidden"
              classList={{
                "pointer-events-none": !fileOpen(),
                "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                  !props.size.active(),
              }}
              style={{ width: treeWidth() }}
            >
              <div
                class="h-full flex flex-col overflow-hidden group/filetree"
                classList={{ "border-l border-border-weaker-base": reviewOpen() }}
              >
                <div class="h-full min-h-0 overflow-y-auto bg-background-stronger px-3 py-0" data-scope="filetree">
                  <Switch>
                    <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                    <Match when={true}>
                      <FileTree
                        path=""
                        class="pt-3"
                        active={activeFilePath()}
                        modified={diffFiles()}
                        kinds={kinds()}
                        onFileClick={(node) => openTab(file.tab(node.path))}
                        onFileRename={(node) => void renameFile(node)}
                        onFileDelete={(node) => void deleteFile(node)}
                        onDirectoryRename={(node) => void renameDirectory(node)}
                        onDirectoryDelete={(node) => void deleteDirectory(node)}
                        onDirectoryCreateFile={(node) => createFileAt(node.path)}
                        onDirectoryCreateSubdirectory={(node) => createDirectoryAt(node.path)}
                        onRootCreateFile={() => createFileAt("")}
                        onRootCreateDirectory={() => createDirectoryAt("")}
                      />
                    </Match>
                  </Switch>
                </div>
              </div>
              <Show when={fileOpen()}>
                <div onPointerDown={() => props.size.start()}>
                  <ResizeHandle
                    direction="horizontal"
                    edge="start"
                    size={layout.fileTree.width()}
                    min={200}
                    max={480}
                    onResize={(width) => {
                      props.size.touch()
                      layout.fileTree.resize(width)
                    }}
                  />
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </aside>
    </Show>
  )
}
