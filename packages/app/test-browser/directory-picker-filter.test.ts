import { expect, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import { skipDirectoryPickerClientFilter } from "../src/components/directory-picker-domain"

test.each(["C:/work/AlphaGit", "~"])("retains server-resolved picker rows for %s", async (query) => {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const list = useFilteredList({
        items: [
          { absolute: "C:\\work\\AlphaGit", search: "C:\\work\\AlphaGit", group: "folders" as const },
          { absolute: "C:\\unrelated", search: "Unrelated recent project", group: "recent" as const },
        ],
        key: (item) => item.absolute,
        filterKeys: ["search"],
        skipFilter: skipDirectoryPickerClientFilter,
      })
      list.onInput(query)

      createEffect(() => {
        if (list.grouped.loading) return
        try {
          expect(list.flat().map((item) => item.absolute)).toEqual(["C:\\work\\AlphaGit"])
          dispose()
          resolve()
        } catch (error) {
          dispose()
          reject(error)
        }
      })
    })
  })
})
