/**
 * Merge 3-way line-based pour fichiers texte (Étape 44).
 *
 * Source de vérité : algo "diff3" classique (Hunt-McIlroy LCS + 3-way
 * stable merge). Implémentation locale pour ne pas ajouter de dépendance
 * runtime non-auditée (`diff3` / `node-diff3` npm packages).
 *
 * Idée : on diff base→local et base→remote ligne par ligne. Si une ligne
 * est inchangée des deux côtés → on la prend. Si elle est modifiée d'un
 * seul côté → on prend ce côté. Si elle est modifiée des deux côtés et que
 * les deux modifs sont IDENTIQUES → no conflict. Sinon → conflict marker.
 *
 * Limites :
 * - Line-based (pas word-level) — typique pour markdown / code / config
 * - Sensible aux fins de ligne CRLF vs LF (normalisation en entrée)
 * - Pas optimisé pour très gros fichiers (>50 MB) — OK pour notes/code
 */

const CONFLICT_LOCAL_MARKER = "<<<<<<< local"
const CONFLICT_SEP_MARKER = "======="
const CONFLICT_REMOTE_MARKER = ">>>>>>> remote"

export interface MergeResult {
  merged: string
  /** True si le merge contient des conflict markers (intervention manuelle). */
  hasConflicts: boolean
  /** Nombre de blocs de conflit textuel détectés. */
  conflictBlocks: number
}

/**
 * Fait un merge 3-way line-based.
 *
 * @param base   Contenu de l'ancêtre commun (dernier remote sync connu).
 * @param local  Contenu local actuel (modifs non encore push).
 * @param remote Contenu remote nouvellement reçu.
 * @returns merged + indicateurs conflit. Si `hasConflicts=false`, le merge
 *          peut être écrit tel quel et push au serveur. Sinon, l'utilisateur
 *          doit éditer manuellement les markers.
 */
export function merge3Way(base: string, local: string, remote: string): MergeResult {
  // Cas triviaux
  if (local === remote) {
    return { merged: local, hasConflicts: false, conflictBlocks: 0 }
  }
  if (local === base) {
    // Pas de modif locale → on prend remote tel quel
    return { merged: remote, hasConflicts: false, conflictBlocks: 0 }
  }
  if (remote === base) {
    // Pas de modif remote → on garde local
    return { merged: local, hasConflicts: false, conflictBlocks: 0 }
  }

  // Split en lignes en préservant les line endings d'origine.
  const baseLines = splitLines(base)
  const localLines = splitLines(local)
  const remoteLines = splitLines(remote)

  // Calcule les diffs base→local et base→remote sous forme de mapping
  // par ligne : pour chaque ligne `i` de base, dit si elle est conservée
  // (à quelle position dans local/remote) ou modifiée.
  const localChanges = diffLines(baseLines, localLines)
  const remoteChanges = diffLines(baseLines, remoteLines)

  // Marche le long de base et applique les changes en parallèle.
  const out: string[] = []
  let bi = 0 // index base
  let li = 0 // index local
  let ri = 0 // index remote
  let conflictBlocks = 0

  while (bi < baseLines.length || li < localLines.length || ri < remoteLines.length) {
    // Cherche le prochain hunk : section où l'un des deux côtés a changé.
    const localSame = bi < baseLines.length && li < localLines.length && baseLines[bi] === localLines[li]
    const remoteSame = bi < baseLines.length && ri < remoteLines.length && baseLines[bi] === remoteLines[ri]

    if (localSame && remoteSame) {
      // Ligne stable des deux côtés : prend telle quelle
      out.push(baseLines[bi])
      bi++
      li++
      ri++
      continue
    }

    // Collecte le hunk : avance jusqu'à ce que les deux côtés re-syncent
    // sur une ligne identique avec base, OU jusqu'à la fin.
    const hunkBaseStart = bi
    const hunkLocalStart = li
    const hunkRemoteStart = ri
    let nextResyncBase = baseLines.length
    let nextResyncLocal = localLines.length
    let nextResyncRemote = remoteLines.length

    // Cherche le prochain "anchor" : une ligne de base présente à la fois
    // dans local et remote après les positions actuelles.
    const anchor = findNextResyncAnchor(baseLines, localLines, remoteLines, bi, li, ri, localChanges, remoteChanges)
    if (anchor) {
      nextResyncBase = anchor.base
      nextResyncLocal = anchor.local
      nextResyncRemote = anchor.remote
    }

    const baseHunk = baseLines.slice(hunkBaseStart, nextResyncBase)
    const localHunk = localLines.slice(hunkLocalStart, nextResyncLocal)
    const remoteHunk = remoteLines.slice(hunkRemoteStart, nextResyncRemote)

    if (hunksEqual(localHunk, baseHunk)) {
      // Local pas changé dans ce hunk → prend remote
      out.push(...remoteHunk)
    } else if (hunksEqual(remoteHunk, baseHunk)) {
      // Remote pas changé → prend local
      out.push(...localHunk)
    } else if (hunksEqual(localHunk, remoteHunk)) {
      // Les deux ont fait la même modif → no conflict
      out.push(...localHunk)
    } else {
      // Conflit réel : markers
      conflictBlocks++
      out.push(CONFLICT_LOCAL_MARKER + "\n")
      out.push(...localHunk)
      // Garantir un newline avant le séparateur si la dernière ligne n'en a pas
      if (localHunk.length > 0 && !localHunk[localHunk.length - 1].endsWith("\n")) out.push("\n")
      out.push(CONFLICT_SEP_MARKER + "\n")
      out.push(...remoteHunk)
      if (remoteHunk.length > 0 && !remoteHunk[remoteHunk.length - 1].endsWith("\n")) out.push("\n")
      out.push(CONFLICT_REMOTE_MARKER + "\n")
    }

    bi = nextResyncBase
    li = nextResyncLocal
    ri = nextResyncRemote
  }

  return {
    merged: out.join(""),
    hasConflicts: conflictBlocks > 0,
    conflictBlocks,
  }
}

/**
 * Détermine si un fichier est texte sur la base de son extension.
 * Liste conservative — on conflict-copy par défaut pour les inconnus.
 */
const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "text",
  "json", "jsonc", "yaml", "yml", "toml",
  "html", "htm", "css", "scss", "less",
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift", "php",
  "c", "cpp", "h", "hpp", "cs", "sh", "bash", "zsh",
  "sql", "graphql", "proto",
  "csv", "tsv",
  "xml", "svg",
  "env", "gitignore", "editorconfig",
  "ini", "conf", "config",
])

export function isTextFile(path: string): boolean {
  const lastDot = path.lastIndexOf(".")
  if (lastDot === -1 || lastDot === path.length - 1) return false
  const ext = path.slice(lastDot + 1).toLowerCase()
  return TEXT_EXTENSIONS.has(ext)
}

// ─── Helpers internes ─────────────────────────────────────────────────────────

/**
 * Split en lignes en préservant le `\n` à la fin de chaque ligne (sauf
 * éventuellement la dernière). Cette propriété est utile pour reconstruire
 * exactement le texte d'origine.
 */
function splitLines(s: string): string[] {
  if (s.length === 0) return []
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") {
      lines.push(s.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < s.length) lines.push(s.slice(start))
  return lines
}

/**
 * Calcule pour chaque ligne de base si elle est conservée (et à quelle
 * position) dans `other`. Renvoie un mapping array<basePos → otherPos|-1>.
 * Algo : LCS basique via DP. Adapté aux tailles modérées (<10k lignes).
 */
function diffLines(base: string[], other: string[]): number[] {
  const m = base.length
  const n = other.length
  // dp[i][j] = longueur LCS de base[0..i) et other[0..j)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (base[i - 1] === other[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }
  // Backtrace pour mapper chaque base[i] à other[j] si dans LCS
  const mapping = new Array<number>(m).fill(-1)
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    if (base[i - 1] === other[j - 1]) {
      mapping[i - 1] = j - 1
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }
  return mapping
}

/**
 * Cherche la prochaine ligne dans base après position `bi` qui est aussi
 * présente (et alignée par LCS) dans local après `li` ET dans remote après
 * `ri`. C'est notre "resync anchor" entre les 3 versions.
 */
function findNextResyncAnchor(
  base: string[],
  _local: string[],
  _remote: string[],
  bi: number,
  li: number,
  ri: number,
  localMap: number[],
  remoteMap: number[],
): { base: number; local: number; remote: number } | undefined {
  for (let i = bi; i < base.length; i++) {
    const localPos = localMap[i]
    const remotePos = remoteMap[i]
    if (localPos >= li && remotePos >= ri) {
      return { base: i, local: localPos, remote: remotePos }
    }
  }
  return undefined
}

function hunksEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
