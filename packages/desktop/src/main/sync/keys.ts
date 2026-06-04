/**
 * Gestion des clés crypto en RAM.
 *
 * Source de vérité : docs/CRYPTO_SPEC-v2.md §2 + BRIEF_KEY_WRAPPING.md.
 *
 * INVARIANT DE SÉCURITÉ :
 *   La masterKey et les clés dérivées (key_content, key_path_mac,
 *   key_path_enc) vivent UNIQUEMENT dans le process main d'Electron, en
 *   RAM, JAMAIS persistées en clair, JAMAIS transmises sur le réseau.
 *   Seul le `keyhash` (preuve de possession) part au serveur.
 *
 *   Si une clé touche le disque ou le réseau, c'est un bug de sécurité.
 */

import {
  deriveVaultKeysFromMasterKey,
  type VaultKeys,
} from "@prisme/sync-crypto"
import log from "electron-log"

/**
 * Container des clés actives par vault_id.
 *
 * Une seule entrée à la fois (un workspace synchronisé). À étendre en
 * Map<vaultId, VaultKeys> quand on supportera N workspaces sync en parallèle.
 */
let activeKeys: { vaultId: string; keys: VaultKeys } | undefined

/**
 * (Ré)active les clés à partir d'une masterKey précalculée.
 *
 * En v2.0 la masterKey est obtenue soit en unwrappant la sealed box du vault
 * avec le keypair user (account-crypto.unlockVaultV2), soit relue depuis le
 * keychain OS (sync:reactivate). L'engine ne dérive plus jamais en interne
 * depuis un password — c'est juste HKDF des sous-clés ici.
 *
 * NE JAMAIS LOGGER : masterKey, keyContent, keyPathMac, keyPathEnc.
 *
 * @param masterKey 32 bytes.
 * @param saltBuffer 32 bytes.
 * @param vaultId UUID du vault.
 */
export function activateKeysFromMasterKey(
  masterKey: Buffer,
  saltBuffer: Buffer,
  vaultId: string,
): { keyhash: Buffer } {
  const keys = deriveVaultKeysFromMasterKey(masterKey, saltBuffer)
  activeKeys = { vaultId, keys }
  log.info("[sync/keys] activated (from precomputed masterKey)", {
    vaultId,
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
