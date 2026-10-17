export type ProjectTrustArg = "--approve" | "--no-approve" | undefined;

/** Preserve the lead session's one-run project trust override for child Pi sessions. */
export function getProjectTrustArg(argv: readonly string[] = process.argv): ProjectTrustArg {
  if (argv.includes("--approve") || argv.includes("-a")) return "--approve";
  if (argv.includes("--no-approve") || argv.includes("-na")) return "--no-approve";
  return undefined;
}

export function shellArgument(value: string): string {
  return /^[a-zA-Z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildPiCommand(
  piBinary: string,
  model?: string,
  thinking?: string,
  trustArg: ProjectTrustArg | null = getProjectTrustArg(),
  sessionFile?: string,
): string {
  const args: string[] = [];
  if (trustArg) args.push(trustArg);
  if (model) {
    args.push("--model", thinking ? `${model}:${thinking}` : model);
  } else if (thinking) {
    args.push("--thinking", thinking);
  }
  if (sessionFile) args.push("--session", sessionFile);
  return [piBinary, ...args.map(shellArgument)].join(" ");
}
