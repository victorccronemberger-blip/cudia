import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"

export const UpgradeCommand = {
  command: "upgrade",
  describe: "show CUDIA update instructions",
  builder: (yargs: Argv) => yargs,
  handler: async () => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Update CUDIA")
    prompts.log.info("Use `cudia update --check` to check for updates or `cudia update` to install one.")
    prompts.outro("Done")
  },
}
