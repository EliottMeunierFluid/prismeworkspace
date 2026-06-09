import { describe, expect, test } from "bun:test"
import { hashContent } from "./hash"

/**
 * Vecteurs de référence générés depuis l'implémentation serveur
 * `ConfigManifestService.hashContent` (prisme-one-configuration). Toute
 * divergence ici = faux conflits permanents côté sync. NE PAS modifier les
 * hashes attendus sans régénérer depuis le serveur.
 */
const VECTORS: Array<[string, string]> = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["hello", "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"],
  ["hello\n", "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"],
  ["a \nb\t\nc", "ea7fb08b7a2dc4619ffb7c7bb38d95a2047935fa165d71b12efd3852a2e6d0cc"],
  ["line1\r\nline2\r\n", "2751a3a2f303ad21752038085e2b8c5f98ecff61a2e4ebbd43506a941725be80"],
  ["trailing   ", "6d388d29cd7aee3b77fb86462745dc8c57a5a417f4620a4d753defba64e33442"],
  ["  mixed \t \n end  ", "523957c02606c224d464474ab24222ec1d6e24caab9f77975aed5f052bba4506"],
]

describe("hashContent — parité serveur", () => {
  for (const [input, expected] of VECTORS) {
    test(`hash(${JSON.stringify(input)})`, () => {
      expect(hashContent(input)).toBe(expected)
    })
  }

  test("CRLF et LF donnent le même hash", () => {
    expect(hashContent("a\r\nb")).toBe(hashContent("a\nb"))
  })

  test("espaces de fin de ligne ignorés", () => {
    expect(hashContent("a   \nb")).toBe(hashContent("a\nb"))
  })
})
