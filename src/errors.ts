/** Exit code 2 marks bad invocation; 1 marks config or device failures. */
export type ExitCode = 1 | 2;

export class CliError extends Error {
  readonly exitCode: ExitCode;
  /** HTTP status from the device, when the failure came from an API call. */
  readonly status: number | undefined;

  constructor(message: string, exitCode: ExitCode = 1, status?: number) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.status = status;
  }
}

export const usageError = (message: string): CliError =>
  new CliError(message, 2);
