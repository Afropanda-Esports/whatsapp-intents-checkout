export function problemDocument(
  publicBaseUrl: string,
  status: number,
  path: string,
  title: string,
  extensions?: Record<string, string>,
): Record<string, unknown> {
  return {
    type: `${publicBaseUrl}${path}`,
    title,
    status,
    ...extensions,
  };
}
