/**
 * Diff 3-way de configuration : local (disque) vs ancestor (manifest dernière
 * sync) vs remote (manifest serveur). Pur et déterministe — testable sans I/O.
 *
 * Remplace le raisonnement que le skill /update déléguait à l'IA (cf SKILL.md
 * §1-2). La logique de classification est volontairement explicite.
 *
 * Conventions :
 *  - `local`/`remote` : { path, hash, permission? }
 *  - `ancestor` : entries du manifest local (dernière sync connue)
 *  - le hash est le SHA-256 normalisé (cf hash.ts), comparable entre les 3 côtés.
 */

export interface DiffEntry {
  path: string
  hash: string
  scope?: string
  permission?: "read" | "write"
}

export interface ConflictEntry {
  path: string
  localHash: string
  remoteHash: string
  ancestorHash: string | null
  /** false si le fichier est read-only (le push de la résolution "local" échouera). */
  writable: boolean
}

export interface DiffResult {
  /** À télécharger : remote a changé, local intact. */
  pull: DiffEntry[]
  /** À envoyer : local a changé, remote intact. (write uniquement) */
  push: DiffEntry[]
  /** Modifié des deux côtés (hashes différents partout). */
  conflicts: ConflictEntry[]
  /** Présent dans ancestor+local mais disparu du remote. */
  revoked: DiffEntry[]
}

function toMap(entries: DiffEntry[]): Map<string, DiffEntry> {
  return new Map(entries.map((e) => [e.path, e]))
}

/**
 * Calcule le diff 3-way.
 *
 * @param local   état réel des fichiers sur disque
 * @param ancestor état de la dernière synchro (manifest local)
 * @param remote  manifest serveur courant
 */
export function diff3Way(
  local: DiffEntry[],
  ancestor: DiffEntry[],
  remote: DiffEntry[],
): DiffResult {
  const localMap = toMap(local)
  const ancestorMap = toMap(ancestor)
  const remoteMap = toMap(remote)

  const pull: DiffEntry[] = []
  const push: DiffEntry[] = []
  const conflicts: ConflictEntry[] = []
  const revoked: DiffEntry[] = []

  const allPaths = new Set<string>([...localMap.keys(), ...ancestorMap.keys(), ...remoteMap.keys()])

  for (const path of allPaths) {
    const l = localMap.get(path)
    const a = ancestorMap.get(path)
    const r = remoteMap.get(path)

    const localChanged = !!l && (!a || l.hash !== a.hash)
    const remoteChanged = !!r && (!a || r.hash !== a.hash)

    // ── Cas remote absent ──────────────────────────────────────────────
    if (!r) {
      // Présent en ancestor (donc connu d'une sync passée) → révocation.
      if (a) {
        if (l) revoked.push(l)
        // si plus en local non plus, rien à faire (déjà supprimé).
      }
      // Si pas en ancestor mais en local seul → fichier purement local,
      // jamais synchronisé : on tente un push (création).
      else if (l) {
        push.push(l)
      }
      continue
    }

    // ── remote présent ─────────────────────────────────────────────────
    // `localChanged`/`remoteChanged` impliquent l/r non-null (cf calcul ci-dessus).
    if (localChanged && remoteChanged && l && r) {
      // Les deux ont bougé : conflit, sauf si convergence (mêmes hashes).
      if (l.hash === r.hash) {
        // Convergence accidentelle : rien à faire (juste actualiser manifest).
        continue
      }
      conflicts.push({
        path,
        localHash: l.hash,
        remoteHash: r.hash,
        ancestorHash: a?.hash ?? null,
        writable: (l.permission ?? r.permission) === "write",
      })
    } else if (remoteChanged && !localChanged) {
      pull.push(r)
    } else if (localChanged && !remoteChanged && l) {
      // local modifié, remote = ancestor → push (si writable)
      if ((l.permission ?? r.permission) === "write") {
        push.push(l)
      }
      // sinon : modif locale d'un read-only ignorée silencieusement
      // (sera écrasée au prochain pull si le remote bouge).
    }
    // ni l'un ni l'autre n'a changé → rien.
  }

  return { pull, push, conflicts, revoked }
}
