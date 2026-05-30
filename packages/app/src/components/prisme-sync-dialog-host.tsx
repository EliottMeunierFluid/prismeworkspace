/**
 * Bridge entre usePrismeSync().dialogTarget() (signal) et l'API dialog.show()
 * du DialogProvider.
 *
 * À monter une fois dans l'arbre React, sous DialogProvider ET sous
 * PrismeSyncProvider. Surveille le signal dialogTarget et :
 *  - si non-null → ouvre le wizard via dialog.show(...)
 *  - si null → ferme (no-op si déjà fermé)
 *
 * Ce composant ne rend rien visuellement.
 */

import { createEffect } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { usePrismeSync } from "@/context/prisme-sync"
import { DialogConnectSync } from "./dialog-connect-sync"

export function PrismeSyncDialogHost() {
  const dialog = useDialog()
  const sync = usePrismeSync()

  createEffect(() => {
    const target = sync.dialogTarget()
    if (target) {
      dialog.show(() => <DialogConnectSync target={target} />)
    }
  })

  return null
}
