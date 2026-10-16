import { OpenCode } from "@opencode-ai/runtime-client"
import type {
  FilesFindInput,
  FilesFindOutput,
  FilesListInput,
  FilesListOutput,
  LocationGetInput,
  LocationGetOutput,
  LocationPathsGetOutput,
  ProjectsListOutput,
  VcsGetInput,
  VcsGetOutput,
} from "@opencode-ai/runtime-client"
import type { FileContent } from "@opencode-ai/sdk/v2"
import { createNativeFileReader, type NativeFileReadInput } from "./native-files"
import type { ServerConnection } from "@/context/server"
import { serverClientOptions } from "@/utils/server"

export type NativeWorkspaceClient = {
  projects: { list: () => Promise<ProjectsListOutput> }
  location: { get: (input?: LocationGetInput) => Promise<LocationGetOutput> }
  locationPaths: { get: () => Promise<LocationPathsGetOutput> }
  vcs: { get: (input?: VcsGetInput, options?: OpenCode.RequestOptions) => Promise<VcsGetOutput> }
  files: {
    list: (input?: FilesListInput, options?: OpenCode.RequestOptions) => Promise<FilesListOutput>
    find: (input: FilesFindInput, options?: OpenCode.RequestOptions) => Promise<FilesFindOutput>
    read: (input: NativeFileReadInput, options?: OpenCode.RequestOptions) => Promise<FileContent>
  }
}

export function createNativeWorkspaceClient(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): NativeWorkspaceClient {
  const config = serverClientOptions(input)
  const client = OpenCode.make(config)
  return { ...client, files: { ...client.files, read: createNativeFileReader(config) } }
}
