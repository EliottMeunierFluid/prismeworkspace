import { createHash } from "node:crypto"

/**
 * Hash SHA-256 normalisé d'un contenu texte.
 *
 * ⚠️ DOIT être identique octet-pour-octet à l'implémentation serveur
 * `ConfigManifestService.hashContent` (prisme-one-configuration), sinon le diff
 * 3-way produira de faux conflits permanents.
 *
 * Normalisation (même ordre que le serveur) :
 *   1. suppression de tous les `\r`
 *   2. split sur `\n`
 *   3. suppression des espaces/tabs en fin de chaque ligne
 *   4. re-join avec `\n`
 */
export function hashContent(content: string): string {
  const normalized = content
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
  return createHash("sha256").update(normalized).digest("hex")
}
