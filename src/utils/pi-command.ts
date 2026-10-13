import path from "node:path";

/** Relaunch the same Pi/runtime without losing Nix paths or shell quoting. */
export function getPiLaunchCommand(
  argv1: string | undefined = process.argv[1],
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string {
  const quote = (value: string) => platform === "win32"
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, "'\\''")}'`;
  const invoke = platform === "win32" ? "& " : "";
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  if (argv1 && [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(pathApi.extname(argv1).toLowerCase())) {
    return `${invoke}${quote(execPath)} ${quote(argv1)}`;
  }

  const binary = pathApi.basename(execPath).toLowerCase();
  if (execPath && !["node", "node.exe", "bun", "bun.exe"].includes(binary)) {
    return `${invoke}${quote(execPath)}`;
  }
  return "pi";
}

export type ProjectTrustArg = "--approve" | "--no-approve" | undefined;

/** Preserve the lead session's one-run project trust override for child Pi sessions. */
export function getProjectTrustArg(argv: readonly string[] = process.argv): ProjectTrustArg {
  if (argv.includes("--approve") || argv.includes("-a")) return "--approve";
  if (argv.includes("--no-approve") || argv.includes("-na")) return "--no-approve";
  return undefined;
}

export function buildPiCommand(
  piBinary: string,
  model?: string,
  thinking?: string,
  trustArg: ProjectTrustArg = getProjectTrustArg(),
): string {
  const args: string[] = [];
  if (trustArg) args.push(trustArg);
  if (model) {
    args.push("--model", thinking ? `${model}:${thinking}` : model);
  } else if (thinking) {
    args.push("--thinking", thinking);
  }
  return [piBinary, ...args].join(" ");
}
