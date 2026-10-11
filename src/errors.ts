/** Exit code 2 marks bad invocation; 1 marks config or device failures. */
type ExitCode = 1 | 2;

export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export const usageError = (message: string): CliError =>
  new CliError(message, 2);
