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
