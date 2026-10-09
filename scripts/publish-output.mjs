/** Preserve captured npm diagnostics when command-stream rejects on exit. */
export function capturedPublishFailure(error) {
  return (
    error.result ?? {
      code: error.exitCode ?? error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }
  );
}
