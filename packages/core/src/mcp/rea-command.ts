import path from "node:path"

export function isReaCommand(command: string, args: readonly string[]) {
  const executable = path.win32.basename(command)
  if (/^rea(?:\.cmd|\.exe)?$/i.test(executable)) return true
  if (/^(?:node|bun)(?:\.exe)?$/i.test(executable))
    return /(?:^|[\\/])rea-agents[\\/]scripts[\\/]rea\.mjs$/i.test(args[0] ?? "")
  if (!/^npx(?:\.cmd|\.exe)?$/i.test(executable)) return false
  const index = args.findIndex((arg) => arg !== "-y" && arg !== "--yes")
  return index >= 0 && /^rea-agents(?:@[^\\/]+)?$/.test(args[index]!)
}
