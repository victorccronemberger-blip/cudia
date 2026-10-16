import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { FileNode } from "@/context/file/types"
import { createFileTreeStore } from "@/context/file/tree-store"

type Request = {
  scope: string
  deferred: PromiseWithResolvers<FileNode[]>
}

function fixture() {
  let scope = "A"
  const requests: Request[] = []
  const errors: string[] = []
  const tree = createFileTreeStore({
    scope: () => scope,
    normalizeDir: (path) => path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""),
    list: () => {
      const deferred = Promise.withResolvers<FileNode[]>()
      requests.push({ scope, deferred })
      return deferred.promise
    },
    onError: (message) => errors.push(message),
  })

  return {
    tree,
    requests,
    errors,
    setScope(value: string) {
      scope = value
      tree.reset()
    },
  }
}

const file = (path: string): FileNode => ({
  name: path.split("/").at(-1)!,
  path,
  absolute: `/${path}`,
  type: "file",
})

test("resets file-tree ownership across A to B to A scope changes", async () => {
  await createRoot(async (dispose) => {
    const state = fixture()
    const firstA = state.tree.listDir("")

    state.setScope("B")
    const requestB = state.tree.listDir("")
    state.setScope("A")
    const latestA = state.tree.listDir("")

    expect(state.requests.map((request) => request.scope)).toEqual(["A", "B", "A"])

    state.requests[0]!.deferred.resolve([file("old-a.txt")])
    await firstA
    state.requests[1]!.deferred.resolve([file("b.txt")])
    await requestB

    expect(state.tree.children("")).toEqual([])
    expect(state.tree.dirState("")?.loading).toBe(true)

    state.requests[2]!.deferred.resolve([file("latest-a.txt")])
    await latestA

    expect(state.tree.children("").map((node) => node.path)).toEqual(["latest-a.txt"])
    expect(state.tree.isLoaded("")).toBe(true)
    dispose()
  })
})

test("an older request finally cannot remove the new scope's in-flight dedupe entry", async () => {
  await createRoot(async (dispose) => {
    const state = fixture()
    const old = state.tree.listDir("")

    state.setScope("B")
    state.setScope("A")
    const current = state.tree.listDir("")

    state.requests[0]!.deferred.resolve([file("stale.txt")])
    await old

    expect(state.tree.listDir("")).toBe(current)
    expect(state.requests).toHaveLength(2)

    state.requests[1]!.deferred.resolve([file("current.txt")])
    await current
    expect(state.tree.children("").map((node) => node.path)).toEqual(["current.txt"])
    dispose()
  })
})

test("a stale rejection does not set current error state or show a toast", async () => {
  await createRoot(async (dispose) => {
    const state = fixture()
    const old = state.tree.listDir("")

    state.setScope("B")
    state.setScope("A")
    const current = state.tree.listDir("")

    state.requests[0]!.deferred.reject(new Error("stale failure"))
    await old

    expect(state.errors).toEqual([])
    expect(state.tree.dirState("")).toMatchObject({ expanded: true, loading: true })
    expect(state.tree.dirState("")?.error).toBeUndefined()

    state.requests[1]!.deferred.resolve([file("current.txt")])
    await current
    expect(state.tree.dirState("")).toMatchObject({ loaded: true, loading: false })
    expect(state.errors).toEqual([])
    dispose()
  })
})
