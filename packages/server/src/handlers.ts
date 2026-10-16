import { Layer } from "effect"
import { MessageHandler } from "./handlers/message"
import { ModelHandler } from "./handlers/model"
import { ProviderHandler } from "./handlers/provider"
import { SessionHandler } from "./handlers/session"
import { PermissionHandler } from "./handlers/permission"
import { FileSystemHandler } from "./handlers/fs"
import { CommandHandler } from "./handlers/command"
import { SkillHandler } from "./handlers/skill"
import { EventHandler } from "./handlers/event"
import { AgentHandler } from "./handlers/agent"
import { HealthHandler } from "./handlers/health"
import { PtyHandler } from "./handlers/pty"
import { QuestionHandler } from "./handlers/question"
import { ReferenceHandler } from "./handlers/reference"
import { LocationHandler } from "./handlers/location"
import { LocationPathsHandler } from "./handlers/location-paths"
import { ProjectHandler } from "./handlers/project"
import { IntegrationHandler } from "./handlers/integration"
import { CredentialHandler } from "./handlers/credential"
import { ProjectCopyHandler } from "./handlers/project-copy"
import { MCPHandler } from "./handlers/mcp"
import { LSPHandler } from "./handlers/lsp"
import { VcsHandler } from "./handlers/vcs"

export const handlers = Layer.mergeAll(
  HealthHandler,
  LocationHandler,
  LocationPathsHandler,
  ProjectHandler,
  AgentHandler,
  SessionHandler,
  MessageHandler,
  ModelHandler,
  ProviderHandler,
  IntegrationHandler,
  MCPHandler,
  LSPHandler,
  CredentialHandler,
  PermissionHandler,
  FileSystemHandler,
  VcsHandler,
  CommandHandler,
  SkillHandler,
  EventHandler,
  PtyHandler,
  QuestionHandler,
  ReferenceHandler,
  ProjectCopyHandler,
)
