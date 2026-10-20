/** Registers every built-in tool module the way src/code/setup.ts does, minus the
 *  config-gated exceptions: those register here so budgets always measure one set. */

import { join } from "node:path";
import { ToolRegistry } from "../../src/tools.js";
import { registerChoiceTool } from "../../src/tools/choice.js";
import { registerCodeQueryTools } from "../../src/tools/code-query.js";
import { registerComputerUseTool } from "../../src/tools/computer-use.js";
import { registerFilesystemTools } from "../../src/tools/filesystem.js";
import { registerImageGenTool } from "../../src/tools/image-gen.js";
import { registerJavaSourceTool } from "../../src/tools/java-source.js";
import { registerJevTool } from "../../src/tools/jev.js";
import { JobRegistry } from "../../src/tools/jobs.js";
import { registerMemoryTools } from "../../src/tools/memory.js";
import { registerPlanTool } from "../../src/tools/plan.js";
import { registerRulesTools } from "../../src/tools/rules.js";
import { registerScaffoldTools } from "../../src/tools/scaffold.js";
import { registerScreenCaptureTool } from "../../src/tools/screen-capture.js";
import { registerSeeImageTool } from "../../src/tools/see-image.js";
import { registerShellTools } from "../../src/tools/shell.js";
import { registerSubagentTool } from "../../src/tools/subagent.js";
import { registerTodoTool } from "../../src/tools/todo.js";
import { registerWaitTool } from "../../src/tools/wait.js";
import { registerWebTools } from "../../src/tools/web.js";

export interface FullToolset {
  tools: ToolRegistry;
  jobs: JobRegistry;
  configPath: string;
}

export function registerAllBuiltins(root: string): FullToolset {
  const tools = new ToolRegistry();
  const jobs = new JobRegistry();
  const configPath = join(root, "config.json");
  registerFilesystemTools(tools, { rootDir: root });
  registerShellTools(tools, { rootDir: root, jobs });
  registerMemoryTools(tools, { projectRoot: root });
  registerRulesTools(tools, { rootDir: root, configPath });
  registerCodeQueryTools(tools, { rootDir: root });
  registerPlanTool(tools);
  registerChoiceTool(tools);
  registerTodoTool(tools);
  registerWaitTool(tools);
  registerSeeImageTool(tools, { rootDir: root });
  registerScreenCaptureTool(tools, { rootDir: root });
  registerComputerUseTool(tools);
  registerScaffoldTools(tools, { projectRoot: root });
  registerImageGenTool(tools, { rootDir: root, configPath });
  registerJavaSourceTool(tools, { projectRoot: root });
  registerJevTool(tools, { configPath });
  registerWebTools(tools);
  registerSubagentTool(tools, {
    client: (() => ({})) as never,
    projectRoot: root,
    defaultModel: () => "deepseek-v4-flash",
  });
  return { tools, jobs, configPath };
}
