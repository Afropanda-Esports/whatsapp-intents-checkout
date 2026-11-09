export type Ping = () => Promise<boolean>;

export type LiveReport = {
  status: 'live';
};

export type ReadyReport = {
  status: 'ready';
  checks: {
    config: 'ok';
    postgres: 'up';
  };
};

export type NotReadyReport = {
  status: 'not-ready';
  checks: {
    config: 'ok';
    postgres: 'down';
  };
};

export type HealthReport = LiveReport | ReadyReport | NotReadyReport;

export const notReadyReport: NotReadyReport = {
  status: 'not-ready',
  checks: { config: 'ok', postgres: 'down' },
};

export type HealthChecker = {
  live: () => LiveReport;
  ready: () => Promise<ReadyReport | NotReadyReport>;
};

/** `live` has no access to `ping`. Config is already known-good before listen. */
export function createHealthChecker(ping: Ping): HealthChecker {
  return {
    live: () => ({ status: 'live' }),
    ready: () => readyReport(ping),
  };
}

/**
 * Config is already known-good: the process does not listen when it is not.
 * The only request-time check is the database ping.
 */
async function readyReport(ping: Ping): Promise<ReadyReport | NotReadyReport> {
  try {
    const up = await ping();
    if (!up) return notReadyReport;
    return { status: 'ready', checks: { config: 'ok', postgres: 'up' } };
  } catch {
    return notReadyReport;
  }
}
