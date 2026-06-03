/**
 * Helpers crypto liés au compte utilisateur (key wrapping v2.0).
 *
 * Source de vérité : BRIEF_KEY_WRAPPING.md (sandbox sync/).
 *
 * Ce module orchestre le flow desktop pour ouvrir un vault v2.0 :
 *  1. fetch /api/auth/me        — récupère la métadonnée crypto (sealed
 *                                 privateKey + salt + nonce + publicKey)
 *  2. unlockUserKeypair(...)    — dérive account_kek depuis le password
 *                                 compte (scrypt + HKDF), déchiffre la
 *                                 privateKey
 *  3. getVaultMembership(...)   — récupère l'encrypted_master_key (sealed
 *                                 box du vault avec la publicKey du user)
 *  4. unwrapMasterKey(...)      — déchiffre la masterKey avec le keypair
 *
 * Une fois la masterKey en RAM, le caller (sync:connect-v2) la passe à
 * engine.activate({ precomputedMasterKey }) — l'engine skip alors le
 * scrypt v1.0 et fait juste le HKDF des sous-clés (cf MR 0.3.0
 * deriveVaultKeysFromMasterKey).
 *
 * SECURITY :
 *  - Le password compte ne vit qu'en RAM le temps de la dérivation (~150ms).
 *    Le caller doit l'oublier immédiatement après l'appel.
 *  - La privateKey est zeroïsée après usage (best-effort JS).
 *  - Aucun log ne contient ces valeurs sensibles.
 */

import {
  deriveAccountKek,
  decryptPrivateKey,
  unwrapMasterKey,
  type UserKeypair,
} from "@prisme/sync-crypto"
import log from "electron-log"
import { getCurrentUserProfile, getVaultMembership } from "./api.js"

export interface VaultUnlockResult {
  /** masterKey 32B en clair — à passer dans SyncConfig.precomputedMasterKey */
  masterKey: Buffer
  /** salt hex du vault (32B) — à passer dans SyncConfig.saltHex */
  saltHex: string
  /** keyhash hex pour validation préalable côté apps */
  keyhashHex: string
  /** crypto_version du vault (toujours 2 ici) */
  cryptoVersion: number
}

/**
 * Pipeline complet desktop v2.0 : à partir du password compte + vaultId,
 * récupère la masterKey en clair prête à activer l'engine.
 *
 * Ne persiste rien — c'est le caller (IPC handler) qui décide de :
 *  - Stocker la masterKey dans le keychain OS (cf key-storage.ts)
 *  - Stocker l'entrée registry (cf workspace-registry.ts)
 *  - Activer l'engine
 *
 * @param vaultId UUID du vault à ouvrir
 * @param accountPassword Mot de passe compte (sera oublié à la fin)
 * @throws Error si /api/auth/me n'a pas de crypto (compte legacy), si le
 *               password est incorrect (auth tag invalide), ou si l'user
 *               n'est pas membre du vault.
 */
export async function unlockVaultV2(
  vaultId: string,
  accountPassword: string,
): Promise<VaultUnlockResult> {
  // 1. Récupère le profil + méta crypto du user
  const profile = await getCurrentUserProfile()
  if (!profile.crypto) {
    throw new Error(
      "Account has no keypair (legacy v1.0 account). Please re-create your account.",
    )
  }
  const cryptoMeta = profile.crypto

  // 2. Déchiffre la privateKey via account_kek = scrypt(password, salt) + HKDF
  //    SECURITY : le password ne sort jamais de cette fonction. Le KEK est
  //    zeroïsé après usage par @prisme/sync-crypto.
  const encryptedPrivateKey = Buffer.from(cryptoMeta.encrypted_private_key_hex, "hex")
  const privateKeySalt = Buffer.from(cryptoMeta.private_key_salt_hex, "hex")
  const privateKeyNonce = Buffer.from(cryptoMeta.private_key_nonce_hex, "hex")
  const accountKek = deriveAccountKek(accountPassword, privateKeySalt)
  let privateKey: Buffer
  try {
    privateKey = await decryptPrivateKey(encryptedPrivateKey, privateKeyNonce, accountKek)
  } catch {
    accountKek.fill(0)
    throw new Error("Mot de passe incorrect")
  }
  accountKek.fill(0)

  const keypair: UserKeypair = {
    publicKey: Buffer.from(cryptoMeta.public_key_hex, "hex"),
    privateKey,
  }

  // 3. Récupère le sealed box du vault pour ce user
  const membership = await getVaultMembership(vaultId)
  if (membership.vault.crypto_version !== 2) {
    privateKey.fill(0)
    throw new Error(
      `Vault crypto_version=${membership.vault.crypto_version} is not v2 — use the legacy connect flow`,
    )
  }

  // 4. Unwrap la masterKey avec le keypair user (sealed box → masterKey 32B)
  const encryptedMasterKey = Buffer.from(membership.encrypted_master_key_hex, "hex")
  let masterKey: Buffer
  try {
    masterKey = await unwrapMasterKey(encryptedMasterKey, keypair)
  } catch (err) {
    privateKey.fill(0)
    log.error("[sync/account-crypto] unwrap failed", {
      vaultId,
      message: err instanceof Error ? err.message : String(err),
    })
    throw new Error(
      "Échec du déchiffrement du vault — l'enveloppe ne correspond pas à votre clé.",
    )
  }

  // 5. SECURITY : zeroïse la privateKey, plus utile (masterKey suffit pour
  //    l'engine et est persistée en keychain à part).
  privateKey.fill(0)

  log.info("[sync/account-crypto] vault unlocked v2", {
    vaultId,
    cryptoVersion: membership.vault.crypto_version,
    // SECURITY : pas de log de masterKey/keyhash en clair, juste le prefix
    keyhashPrefix: membership.vault.keyhash_hex.slice(0, 8),
  })

  return {
    masterKey,
    saltHex: membership.vault.salt_hex,
    keyhashHex: membership.vault.keyhash_hex,
    cryptoVersion: membership.vault.crypto_version,
  }
}
