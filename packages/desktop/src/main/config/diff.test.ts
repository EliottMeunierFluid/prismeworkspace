import { describe, expect, test } from "bun:test"
import { diff3Way, type DiffEntry } from "./diff"

const W = (path: string, hash: string): DiffEntry => ({ path, hash, permission: "write" })
const R = (path: string, hash: string): DiffEntry => ({ path, hash, permission: "read" })

describe("diff3Way", () => {
  test("aucun changement → tout vide", () => {
    const e = [W("a", "h1"), R("b", "h2")]
    const d = diff3Way(e, e, e)
    expect(d.pull).toEqual([])
    expect(d.push).toEqual([])
    expect(d.conflicts).toEqual([])
    expect(d.revoked).toEqual([])
  })

  test("remote modifié, local intact → pull", () => {
    const ancestor = [W("a", "h1")]
    const local = [W("a", "h1")]
    const remote = [W("a", "h2")]
    const d = diff3Way(local, ancestor, remote)
    expect(d.pull.map((e) => e.path)).toEqual(["a"])
    expect(d.push).toEqual([])
    expect(d.conflicts).toEqual([])
  })

  test("nouveau fichier sur le serveur → pull", () => {
    const d = diff3Way([], [], [W("new", "h1")])
    expect(d.pull.map((e) => e.path)).toEqual(["new"])
  })

  test("local modifié (writable), remote intact → push", () => {
    const ancestor = [W("a", "h1")]
    const local = [W("a", "h2")]
    const remote = [W("a", "h1")]
    const d = diff3Way(local, ancestor, remote)
    expect(d.push.map((e) => e.path)).toEqual(["a"])
    expect(d.pull).toEqual([])
  })

  test("local modifié mais read-only → ignoré (pas de push)", () => {
    const ancestor = [R("a", "h1")]
    const local = [R("a", "h2")]
    const remote = [R("a", "h1")]
    const d = diff3Way(local, ancestor, remote)
    expect(d.push).toEqual([])
    expect(d.pull).toEqual([])
    expect(d.conflicts).toEqual([])
  })

  test("modifié des deux côtés → conflit", () => {
    const ancestor = [W("a", "h1")]
    const local = [W("a", "h2")]
    const remote = [W("a", "h3")]
    const d = diff3Way(local, ancestor, remote)
    expect(d.conflicts).toHaveLength(1)
    expect(d.conflicts[0]).toMatchObject({
      path: "a",
      localHash: "h2",
      remoteHash: "h3",
      ancestorHash: "h1",
      writable: true,
    })
    expect(d.pull).toEqual([])
    expect(d.push).toEqual([])
  })

  test("convergence des deux côtés (mêmes hashes) → pas de conflit", () => {
    const ancestor = [W("a", "h1")]
    const local = [W("a", "h2")]
    const remote = [W("a", "h2")]
    const d = diff3Way(local, ancestor, remote)
    expect(d.conflicts).toEqual([])
    expect(d.pull).toEqual([])
    expect(d.push).toEqual([])
  })

  test("remote disparu (présent en ancestor+local) → revoked", () => {
    const ancestor = [W("a", "h1")]
    const local = [W("a", "h1")]
    const remote: DiffEntry[] = []
    const d = diff3Way(local, ancestor, remote)
    expect(d.revoked.map((e) => e.path)).toEqual(["a"])
  })

  test("fichier purement local jamais synchronisé → push (création)", () => {
    const d = diff3Way([W("local-only", "h1")], [], [])
    expect(d.push.map((e) => e.path)).toEqual(["local-only"])
    expect(d.revoked).toEqual([])
  })

  test("read-only conflit → writable=false", () => {
    const d = diff3Way([R("a", "h2")], [R("a", "h1")], [R("a", "h3")])
    expect(d.conflicts[0]?.writable).toBe(false)
  })
})
