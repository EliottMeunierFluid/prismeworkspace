import { describe, expect, test } from "bun:test"
import { isTextFile, merge3Way } from "./merge"

describe("merge 3-way", () => {
  test("local et remote identiques → pas de conflit", () => {
    const r = merge3Way("base", "modified", "modified")
    expect(r.merged).toBe("modified")
    expect(r.hasConflicts).toBe(false)
    expect(r.conflictBlocks).toBe(0)
  })

  test("modif local seulement → prend local", () => {
    const r = merge3Way("a\nb\nc\n", "a\nB-MODIFIED\nc\n", "a\nb\nc\n")
    expect(r.merged).toBe("a\nB-MODIFIED\nc\n")
    expect(r.hasConflicts).toBe(false)
  })

  test("modif remote seulement → prend remote", () => {
    const r = merge3Way("a\nb\nc\n", "a\nb\nc\n", "a\nb\nC-MODIFIED\n")
    expect(r.merged).toBe("a\nb\nC-MODIFIED\n")
    expect(r.hasConflicts).toBe(false)
  })

  test("modifs sur lignes différentes → merge propre, no conflict", () => {
    const r = merge3Way(
      "alpha\nbeta\ngamma\ndelta\n",
      "ALPHA-edited\nbeta\ngamma\ndelta\n",
      "alpha\nbeta\ngamma\nDELTA-edited\n",
    )
    expect(r.hasConflicts).toBe(false)
    expect(r.merged).toBe("ALPHA-edited\nbeta\ngamma\nDELTA-edited\n")
  })

  test("modifs sur même ligne, contenu différent → conflit avec markers", () => {
    const r = merge3Way(
      "a\nb\nc\n",
      "a\nLOCAL-edit\nc\n",
      "a\nREMOTE-edit\nc\n",
    )
    expect(r.hasConflicts).toBe(true)
    expect(r.conflictBlocks).toBe(1)
    expect(r.merged).toContain("<<<<<<< local")
    expect(r.merged).toContain("LOCAL-edit")
    expect(r.merged).toContain("=======")
    expect(r.merged).toContain("REMOTE-edit")
    expect(r.merged).toContain(">>>>>>> remote")
    expect(r.merged).toContain("a\n")
    expect(r.merged).toContain("c\n")
  })

  test("ajouts adjacents dans une même ligne supprimée → conflit", () => {
    // Base : "line\n", local replace par "LOCAL\n", remote replace par "REMOTE\n"
    // Les deux remplacent la même ligne par des contenus différents.
    const r = merge3Way("middle\n", "LOCAL\n", "REMOTE\n")
    expect(r.hasConflicts).toBe(true)
  })

  test("local et remote font la même modif → no conflict", () => {
    const r = merge3Way("a\nold\nc\n", "a\nNEW\nc\n", "a\nNEW\nc\n")
    expect(r.hasConflicts).toBe(false)
    expect(r.merged).toBe("a\nNEW\nc\n")
  })

  test("file vide en base, ajouts différents", () => {
    const r = merge3Way("", "local content\n", "remote content\n")
    expect(r.hasConflicts).toBe(true)
  })

  test("ajout en fin seulement local", () => {
    const r = merge3Way("line1\n", "line1\nline2-local\n", "line1\n")
    expect(r.hasConflicts).toBe(false)
    expect(r.merged).toBe("line1\nline2-local\n")
  })

  test("delete d'une ligne local seulement", () => {
    const r = merge3Way("a\nb\nc\n", "a\nc\n", "a\nb\nc\n")
    expect(r.hasConflicts).toBe(false)
    expect(r.merged).toBe("a\nc\n")
  })
})

describe("isTextFile", () => {
  test("extensions courantes sont reconnues", () => {
    expect(isTextFile("note.md")).toBe(true)
    expect(isTextFile("config.json")).toBe(true)
    expect(isTextFile("file.yaml")).toBe(true)
    expect(isTextFile("src/main.ts")).toBe(true)
    expect(isTextFile("Cargo.toml")).toBe(true)
  })

  test("binaires retournent false", () => {
    expect(isTextFile("photo.png")).toBe(false)
    expect(isTextFile("doc.pdf")).toBe(false)
    expect(isTextFile("archive.zip")).toBe(false)
    expect(isTextFile("noext")).toBe(false)
  })

  test("case-insensitive", () => {
    expect(isTextFile("README.MD")).toBe(true)
    expect(isTextFile("SCRIPT.JS")).toBe(true)
  })
})
