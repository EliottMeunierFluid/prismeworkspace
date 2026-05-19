/**
 * Gestion des clés crypto en RAM.
 *
 * Source de vérité : docs/CRYPTO_SPEC-v2.md §2 + BRIEF_BLOC_1_CLIENT_SYNC.md §0
 *
 * INVARIANT DE SÉCURITÉ (cf brief §0) :
 *   Le vault_password et les clés dérivées (master_key, key_content,
 *   key_path_mac, key_path_enc) vivent UNIQUEMENT dans le process main
 *   d'Electron, en RAM, JAMAIS persistés en clair, JAMAIS transmis sur le
 *   réseau. Seul le `keyhash` (preuve de possession) part au serveur.
 *
 *   Si une clé ou le password touche le disque ou le réseau, c'est un bug
 *   de sécurité.
 */

import { deriveVaultKeys, type VaultKeys } from "@prisme/sync-crypto"
import log from "electron-log"

/**
 * Container des clés actives par vault_id.
 *
 * Une seule entrée à la fois en v1 (un workspace synchronisé). À étendre en
 * Map<vaultId, VaultKeys> quand on supportera N workspaces sync en parallèle.
 */
let activeKeys: { vaultId: string; keys: VaultKeys } | undefined

/**
 * Dérive les clés d'un vault à partir du password + salt.
 *
 * Coûte ~50-150ms (scrypt N=32768). À appeler UNE FOIS à l'activation de la
 * sync sur un workspace. Le `vaultPassword` est immédiatement OUBLIÉ après
 * l'appel (le caller doit s'assurer qu'il ne le garde pas en référence).
 *
 * NE JAMAIS LOGGER : password, salt, ni AUCUN champ de VaultKeys (sauf
 * éventuellement keyhash qui est transmissible — mais par défaut on log
 * juste sa présence, pas sa valeur).
 *
 * @param vaultPassword Mot de passe E2EE du vault (sera oublié immédiatement).
 * @param saltBuffer Salt 32B (récupéré depuis le serveur via /api/vaults).
 * @param vaultId UUID du vault pour stocker les clés actives.
 */
export function activateKeys(
  vaultPassword: string,
  saltBuffer: Buffer,
  vaultId: string,
): { keyhash: Buffer } {
  // SECURITY: pas de log de vaultPassword ni de saltBuffer ici.
  const keys = deriveVaultKeys(vaultPassword, saltBuffer)
  activeKeys = { vaultId, keys }
  log.info("[sync/keys] activated", {
    vaultId,
    // On log SEULEMENT le préfixe du keyhash pour debug (8 chars hex = 4 bytes,
    // pas de risque crypto). On ne log pas masterKey/keyContent/keyPathMac/keyPathEnc.
    keyhashPrefix: keys.keyhash.subarray(0, 4).toString("hex"),
  })
  return { keyhash: keys.keyhash }
}

/**
 * Récupère les clés actives pour usage par les sous-modules (transport, pipeline).
 *
 * Throws si pas de clés actives (l'utilisateur n'a pas encore activé la sync).
 */
export function getActiveKeys(vaultId: string): VaultKeys {
  if (!activeKeys || activeKeys.vaultId !== vaultId) {
    throw new Error(
      `No active keys for vault ${vaultId} — activate sync first`,
    )
  }
  return activeKeys.keys
}

/**
 * Zeroïze et oublie les clés (à appeler au logout / désactivation sync).
 *
 * Note : en JS pur, "zeroïser" un Buffer n'a pas la garantie crypto-grade
 * (le GC peut avoir déjà copié la mémoire). C'est best-effort.
 */
export function deactivateKeys(): void {
  if (!activeKeys) return
  const k = activeKeys.keys
  k.masterKey.fill(0)
  k.keyContent.fill(0)
  k.keyPathMac.fill(0)
  k.keyPathEnc.fill(0)
  // keyhash on garde la valeur en mémoire pour potentielle re-vérification,
  // mais pas de problème de fuite (c'est une preuve de possession publique).
  activeKeys = undefined
  log.info("[sync/keys] deactivated (keys zeroized)")
}

/**
 * Pour tests/debug : indique si des clés sont actives.
 */
export function hasActiveKeys(): boolean {
  return activeKeys !== undefined
}
