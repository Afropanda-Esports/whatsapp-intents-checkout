export type PandaPayOptions = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
};

export type PandaPayRequest = {
  baseUrl: string;
  apiKey: string;
  path: string;
  method: 'GET' | 'POST';
  body?: unknown;
  fetchImpl?: typeof fetch;
};

export async function pandaPayRequest(options: PandaPayRequest): Promise<unknown | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'X-Api-Key': options.apiKey,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetchImpl(new URL(options.path, options.baseUrl), {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
