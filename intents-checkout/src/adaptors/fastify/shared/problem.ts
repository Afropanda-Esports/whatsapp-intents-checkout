export function problemDocument(
  publicBaseUrl: string,
  status: number,
  path: string,
  title: string,
  extensions?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...extensions,
    type: `${publicBaseUrl}${path}`,
    title,
    status,
  };
}
