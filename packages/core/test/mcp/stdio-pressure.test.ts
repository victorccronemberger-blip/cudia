import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

for (const mode of ["esm", "cjs"]) {
  for (const scenario of ["ordered", "exit", "stalled", "graceful", "destroyed-then-close"]) {
    test(`${mode} stdio settles concurrent sends during ${scenario} without listener warnings`, async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(new URL("../fixture/mcp-stdio-pressure.mjs", import.meta.url)),
          mode,
          scenario,
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        if (exit !== 0) throw new Error(stderr || stdout || `Fixture exited with ${exit}`)
        expect(stderr).not.toContain("MaxListenersExceededWarning")
        expect(exit).toBe(0)
        const result = JSON.parse(stdout)
        expect(result.before).toBe(true)
        expect(result.after).toBe(true)
        expect(result.warnings).toEqual([])
        expect(result.unhandled).toEqual([])
        expect(result.fulfilled + result.rejected).toBe(32)
        if (scenario === "ordered") {
          expect(result.fulfilled).toBe(32)
          expect(result.errors).toEqual([])
          expect(result.received).toEqual(Array.from({ length: 32 }, (_, index) => index))
        }
        if (["exit", "stalled", "destroyed-then-close"].includes(scenario)) expect(result.rejected).toBeGreaterThan(0)
        if (scenario === "graceful") expect(result.fulfilled).toBe(32)
      } finally {
        child.kill()
        await child.exited
      }
    }, 15_000)
  }
}
