import path from "node:path"
import { lstat, rm } from "node:fs/promises"

export function resolveOutputDirectory(directory: string, requested = "dist") {
  const root = path.resolve(directory)
  const output = path.resolve(root, requested)
  const relative = path.relative(root, output)
  if (!/^dist(?:-[A-Za-z0-9_-]+)?$/.test(relative)) {
    throw new Error("Build output must be dist or a dist-<name> directory directly inside the package")
  }
  return output
}

export async function prepareOutputDirectory(directory: string, requested?: string) {
  const output = resolveOutputDirectory(directory, requested)
  const info = await lstat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (info?.isSymbolicLink()) throw new Error("Build output must not be a symbolic link")
  try {
    await rm(output, { recursive: true, force: true })
  } catch (error) {
    throw new Error("Cannot clear build output. If a binary is running, use --output-dir dist-preview.", {
      cause: error,
    })
  }
  return output
}
