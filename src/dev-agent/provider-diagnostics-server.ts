import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  parseProviderDiagnosticsEventPost,
  parseProviderDiagnosticsShare,
  PROVIDER_DIAGNOSTICS_BRIDGE_PATH,
  PROVIDER_DIAGNOSTICS_EVENT_LIMIT,
  PROVIDER_DIAGNOSTICS_EVENTS_PATH,
  PROVIDER_DIAGNOSTICS_HEALTH_PATH,
  PROVIDER_DIAGNOSTICS_MAX_BYTES,
  PROVIDER_DIAGNOSTICS_TTL_MS,
  type ProviderDiagnosticsBridgeRecord,
  type ProviderDiagnosticsEventPost,
  type ProviderDiagnosticsEventsRecord,
  type ProviderDiagnosticsHealth,
  type ProviderDiagnosticsMonitorEvent,
  type ProviderDiagnosticsShare,
  type ProviderDiagnosticsStoredEvent,
} from './provider-diagnostics-bridge';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/u;
const PROVIDER_DIAGNOSTICS_PATHS = new Set([
  PROVIDER_DIAGNOSTICS_BRIDGE_PATH,
  PROVIDER_DIAGNOSTICS_EVENTS_PATH,
  PROVIDER_DIAGNOSTICS_HEALTH_PATH,
]);

type MonitorSession = {
  sessionId: string;
  startedAt: number;
  receivedAt: number;
  updatedAt: number;
  expiresAt: number;
  nextSequence: number;
  droppedEventCount: number;
  report: ProviderDiagnosticsShare;
  events: ProviderDiagnosticsStoredEvent[];
};

export function providerDiagnosticsBridgePlugin(): Plugin {
  let session: MonitorSession | null = null;

  return {
    name: 'bgsm-provider-diagnostics-bridge',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (!PROVIDER_DIAGNOSTICS_PATHS.has(requestUrl.pathname)) {
          next();
          return;
        }

        setCommonHeaders(response);
        const origin = request.headers.origin ?? null;
        if (origin && EXTENSION_ORIGIN.test(origin)) setExtensionCors(response, origin);

        if (request.method === 'OPTIONS') {
          if (!origin || !EXTENSION_ORIGIN.test(origin)) {
            writeJson(response, 403, { error: 'extension_origin_required' });
            return;
          }
          if (request.headers['access-control-request-private-network'] === 'true') {
            response.setHeader('Access-Control-Allow-Private-Network', 'true');
          }
          response.statusCode = 204;
          response.end();
          return;
        }

        session = activeSession(session);

        if (request.method === 'GET') {
          if (requestUrl.pathname === PROVIDER_DIAGNOSTICS_HEALTH_PATH) {
            writeJson(response, 200, healthRecord(session));
            return;
          }
          if (!session) {
            writeJson(response, 404, {
              error: 'provider_diagnostics_not_monitoring',
              bridgeVersion: 2,
            });
            return;
          }
          if (requestUrl.pathname === PROVIDER_DIAGNOSTICS_EVENTS_PATH) {
            writeJson(response, 200, eventsRecord(
              session,
              parseNonNegativeInteger(requestUrl.searchParams.get('after')) ?? 0,
              clampEventLimit(parseNonNegativeInteger(requestUrl.searchParams.get('limit'))),
            ));
            return;
          }
          writeJson(response, 200, latestRecord(session));
          return;
        }

        if (!origin || !EXTENSION_ORIGIN.test(origin)) {
          writeJson(response, 403, { error: 'extension_origin_required' });
          return;
        }

        if (request.method === 'DELETE') {
          if (requestUrl.pathname !== PROVIDER_DIAGNOSTICS_BRIDGE_PATH) {
            response.setHeader('Allow', 'GET, POST, OPTIONS');
            writeJson(response, 405, { error: 'method_not_allowed' });
            return;
          }
          session = null;
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== 'POST') {
          response.setHeader('Allow', requestUrl.pathname === PROVIDER_DIAGNOSTICS_BRIDGE_PATH
            ? 'GET, POST, DELETE, OPTIONS'
            : 'GET, POST, OPTIONS');
          writeJson(response, 405, { error: 'method_not_allowed' });
          return;
        }

        try {
          const json = await readBoundedJson(request);
          if (requestUrl.pathname === PROVIDER_DIAGNOSTICS_BRIDGE_PATH) {
            const report = parseProviderDiagnosticsShare(json);
            if (!report) {
              writeJson(response, 400, { error: 'provider_diagnostics_invalid' });
              return;
            }
            session = startSession(report);
            writeJson(response, 201, latestRecord(session));
            return;
          }
          if (requestUrl.pathname === PROVIDER_DIAGNOSTICS_EVENTS_PATH) {
            const post = parseProviderDiagnosticsEventPost(json);
            if (!post) {
              writeJson(response, 400, { error: 'provider_diagnostics_event_invalid' });
              return;
            }
            session = acceptEvent(session, post);
            if (!session) {
              writeJson(response, 409, { error: 'provider_diagnostics_session_unavailable' });
              return;
            }
            writeJson(response, 202, latestRecord(session));
            return;
          }
          writeJson(response, 405, { error: 'method_not_allowed' });
        } catch (error) {
          writeJson(response, 400, {
            error: error instanceof Error ? error.message : 'provider_diagnostics_invalid',
          });
        }
      });
    },
  };
}

function startSession(report: ProviderDiagnosticsShare): MonitorSession {
  const now = Date.now();
  const sessionId = `provider-monitor:${crypto.randomUUID()}`;
  const event: ProviderDiagnosticsMonitorEvent = Object.freeze({
    schemaVersion: 1,
    sessionId,
    emittedAt: now,
    kind: 'monitor_started',
    rootOperationId: null,
    requestId: null,
    data: Object.freeze({}),
  });
  return {
    sessionId,
    startedAt: now,
    receivedAt: now,
    updatedAt: now,
    expiresAt: now + PROVIDER_DIAGNOSTICS_TTL_MS,
    nextSequence: 2,
    droppedEventCount: 0,
    report,
    events: [Object.freeze({ sequence: 1, receivedAt: now, event })],
  };
}

function acceptEvent(
  current: MonitorSession | null,
  post: ProviderDiagnosticsEventPost,
): MonitorSession | null {
  const now = Date.now();
  let session = activeSession(current);
  if (!session) {
    if (
      !post.report
      || post.expiresAt <= now
      || post.startedAt > now
      || post.expiresAt - post.startedAt > PROVIDER_DIAGNOSTICS_TTL_MS
    ) return null;
    session = {
      sessionId: post.sessionId,
      startedAt: post.startedAt,
      receivedAt: now,
      updatedAt: now,
      expiresAt: post.expiresAt,
      nextSequence: 1,
      droppedEventCount: 0,
      report: post.report,
      events: [],
    };
  }
  if (
    session.sessionId !== post.sessionId
    || session.startedAt !== post.startedAt
    || session.expiresAt !== post.expiresAt
  ) return null;

  const stored = Object.freeze({
    sequence: session.nextSequence,
    receivedAt: now,
    event: post.event,
  });
  session.events.push(stored);
  session.nextSequence += 1;
  session.updatedAt = now;
  if (post.report) session.report = post.report;
  while (session.events.length > PROVIDER_DIAGNOSTICS_EVENT_LIMIT) {
    session.events.shift();
    session.droppedEventCount += 1;
  }
  return session;
}

function activeSession(session: MonitorSession | null): MonitorSession | null {
  return session && session.expiresAt > Date.now() ? session : null;
}

function latestRecord(session: MonitorSession): ProviderDiagnosticsBridgeRecord {
  return Object.freeze({
    bridgeVersion: 2,
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    receivedAt: session.receivedAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    eventCount: session.nextSequence - 1,
    droppedEventCount: session.droppedEventCount,
    report: session.report,
    latestEvent: session.events.at(-1)!,
  });
}

function eventsRecord(
  session: MonitorSession,
  after: number,
  limit: number,
): ProviderDiagnosticsEventsRecord {
  return Object.freeze({
    bridgeVersion: 2,
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    eventCount: session.nextSequence - 1,
    droppedEventCount: session.droppedEventCount,
    events: Object.freeze(session.events.filter((event) => event.sequence > after).slice(-limit)),
  });
}

function healthRecord(session: MonitorSession | null): ProviderDiagnosticsHealth {
  const serverTime = Date.now();
  if (!session) {
    return Object.freeze({
      bridgeVersion: 2,
      state: 'idle',
      serverTime,
      sessionId: null,
      startedAt: null,
      updatedAt: null,
      expiresAt: null,
      eventCount: 0,
      droppedEventCount: 0,
    });
  }
  return Object.freeze({
    bridgeVersion: 2,
    state: 'monitoring',
    serverTime,
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    eventCount: session.nextSequence - 1,
    droppedEventCount: session.droppedEventCount,
  });
}

async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > PROVIDER_DIAGNOSTICS_MAX_BYTES) {
      throw new Error('provider_diagnostics_too_large');
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error('provider_diagnostics_empty');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('provider_diagnostics_json_invalid');
  }
}

function parseNonNegativeInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function clampEventLimit(value: number | null): number {
  return Math.max(1, Math.min(PROVIDER_DIAGNOSTICS_EVENT_LIMIT, value ?? PROVIDER_DIAGNOSTICS_EVENT_LIMIT));
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-BGSM-Diagnostics-Schema', 'provider-monitor-v2');
}

function setExtensionCors(response: ServerResponse, origin: string): void {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Vary', 'Origin');
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.end(`${JSON.stringify(value)}\n`);
}
