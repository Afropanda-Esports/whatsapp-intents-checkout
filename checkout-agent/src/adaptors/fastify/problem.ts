const PROBLEM_BASE = 'https://checkout-agent.local';

export function problemDocument(
  status: number,
  title: string,
  path: string,
  extensions?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(extensions ?? {}),
    type: `${PROBLEM_BASE}${path}`,
    title,
    status,
  };
}

export function zodIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join('.') || 'body',
    message: issue.message,
  }));
}
