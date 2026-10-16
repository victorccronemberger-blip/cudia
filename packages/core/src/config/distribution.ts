export * as ConfigDistribution from "./distribution"

import path from "path"
import { realpath, stat } from "fs/promises"
import { Flag } from "../flag/flag"

/** An explicitly configured, immutable source of defaults, separate from user config. */
export type Source = {
  directory: string
  contains: (file: string) => Promise<boolean>
}

function identity(file: string) {
  const resolved = path.resolve(file)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

// Resolve on each config discovery, rather than caching process environment across instances.
export async function resolve(): Promise<Source | undefined> {
  const configured = Flag.CUDIA_DISTRIBUTION_DIR
  if (configured === undefined) return
  if (!path.isAbsolute(configured) || (process.platform === "win32" && /^[\\/](?![\\/])/.test(configured))) {
    throw new Error("CUDIA_DISTRIBUTION_DIR must be an absolute directory path")
  }
  const directory = await realpath(configured)
  if (!(await stat(directory)).isDirectory()) throw new Error("CUDIA_DISTRIBUTION_DIR must name a directory")
  const root = identity(directory)
  return {
    directory,
    async contains(file) {
      // Existing aliases must be resolved before checking the path boundary. Resolve the
      // closest existing ancestor as well, so a missing output file cannot escape detection.
      async function canonical(file: string): Promise<string> {
        return realpath(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error
          const parent = path.dirname(file)
          if (parent === file) throw error
          return canonical(parent).then((parent) => path.join(parent, path.basename(file)))
        })
      }
      const candidate = identity(await canonical(path.resolve(file)))
      return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
    },
  }
}

/** Check raw data before compatibility decoding can drop unsupported declarations. */
export function validate(input: unknown, source: string) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return
  if ("plugin" in input || "plugins" in input) {
    throw new Error(`Distribution defaults cannot declare plugins: ${source}`)
  }
  if ("experimental" in input && typeof input.experimental === "object" && input.experimental !== null) {
    if ("policies" in input.experimental) {
      throw new Error(`Distribution defaults cannot declare experimental.policies: ${source}`)
    }
  }
  if ("tui" in input) validate(input.tui, source)
}
