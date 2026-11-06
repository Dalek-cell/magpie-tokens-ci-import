// Only application-authored messages may enter logs. Upstream response bodies,
// file contents, URLs and credentials must never be included.
export class PluginError extends Error {}

export function errorSummary(error) {
  if (error instanceof PluginError) return error.message;
  const names = new Set(["Error", "TypeError", "ReferenceError", "SyntaxError", "TimeoutError", "AbortError"]);
  const name = names.has(error?.name) ? error.name : "Error";
  const code = error?.code ?? error?.cause?.code;
  const codes = new Set(["ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"]);
  return codes.has(code) ? `${name} (${code})` : name;
}

export async function inStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    throw new PluginError(`${stage}: ${errorSummary(error)}`, { cause: error });
  }
}
