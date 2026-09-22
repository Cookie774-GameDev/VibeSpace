import type { JevJsonValue, JevQuestions, JevEvaluation } from './types';

export const JEV_MODEL_ALIAS = 'jev-latest' as const;
export const JEV_API_ORIGIN = 'https://api.typesafe.ai' as const;

export type JevTransportRequest = Readonly<{
  body: Readonly<{
    state: JevJsonValue;
    model: string;
    questions: JevQuestions;
  }>;
  signal: AbortSignal;
}>;

export type JevTransport = (request: JevTransportRequest) => Promise<unknown>;

/** Renderer-safe result returned by the native `jev_http_models` command. */
export type JevNativeErrorKind =
  | 'missing_key'
  | 'invalid_key'
  | 'forbidden'
  | 'network'
  | 'provider_error'
  | 'malformed'
  | 'response_too_large'
  | 'request_too_large'
  | 'invalid_request'
  | 'storage_error';

export type JevNativeResultKind = 'connected' | JevNativeErrorKind;

export type JevNativeModel = Readonly<{ id: string; label?: string }>;

export type JevNativeModelsResult = Readonly<{
  kind: JevNativeResultKind;
  models: readonly JevNativeModel[];
  status: number | null;
}>;

export type JevNativeSystemOneResult = Readonly<{
  kind: 'ok' | JevNativeErrorKind;
  body: unknown | null;
  status: number | null;
  model?: string;
  usage?: Readonly<{
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  }>;
}>;

/** Exact typed bridge owned by the native secure-settings lane. */
export type JevNativeHttpBridge = Readonly<{
  jev_http_models: (input?: { signal?: AbortSignal }) => Promise<JevNativeModelsResult>;
  jev_http_systemone: (input: {
    request: Readonly<{
      state: JevJsonValue;
      model: string;
      questions: JevQuestions;
    }>;
    signal?: AbortSignal;
  }) => Promise<JevNativeSystemOneResult>;
}>;

export type JevTransportProbe = (input: { signal: AbortSignal }) => Promise<Readonly<{
  available: boolean;
  modelIds: readonly string[];
}>>;

export type JevClient = Readonly<{
  evaluate(input: {
    state: JevJsonValue;
    questions: JevQuestions;
    signal?: AbortSignal;
  }): Promise<JevEvaluation>;
  probe?(input?: { signal?: AbortSignal }): Promise<Readonly<{
    available: boolean;
    modelIds: readonly string[];
  }>>;
}>;

export type JevTransportErrorCode =
  | 'transport_unavailable'
  | 'transport_timeout'
  | 'response_invalid'
  | 'request_invalid';

export class JevClientError extends Error {
  readonly code: JevTransportErrorCode;

  constructor(code: JevTransportErrorCode) {
    super(`jev_${code}`);
    this.name = 'JevClientError';
    this.code = code;
  }
}
