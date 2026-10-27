// Every error is JSON: { "error": { "code", "message" } }. Messages are written for testers,
// so the app can show them as they are.

export type ErrorCode =
  | "invalid_code"
  | "code_expired"
  | "code_revoked"
  | "quota_exhausted"
  | "creation_call_limit"
  | "rate_limited"
  | "demo_paused"
  | "model_not_allowed"
  | "request_too_large"
  | "upstream_error"
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "method_not_allowed"
  | "internal_error";

const STATUS: Record<ErrorCode, number> = {
  invalid_code: 401,
  code_expired: 403,
  code_revoked: 403,
  quota_exhausted: 403,
  creation_call_limit: 403,
  rate_limited: 429,
  demo_paused: 503,
  model_not_allowed: 400,
  request_too_large: 413,
  upstream_error: 502,
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  method_not_allowed: 405,
  internal_error: 500,
};

export const MESSAGES = {
  invalid_code: "This access code isn't valid. Check it in Settings → AI access.",
  code_expired: "This access code has expired. Ask for a new one, or use your own Meta API key in Settings.",
  code_revoked: "This access code has been turned off. Ask for a new one, or use your own Meta API key in Settings.",
  quota_creations:
    "This access code has no routine creations left. Saved routines still rerun without AI, or you can use your own Meta API key in Settings.",
  quota_sam: "This access code has no image checks left. Saved routines still rerun without AI.",
  creation_call_limit:
    "This routine needed more AI calls than the demo allows for one creation. Try again with a simpler request.",
  rate_limited: "Too many requests in a short time. Wait a minute and try again.",
  demo_paused: "The demo is paused right now. Saved routines still rerun without AI.",
  demo_budget:
    "The demo has used its AI budget for now and is paused. Saved routines still rerun without AI.",
  model_not_allowed: "This model isn't available in the demo.",
  request_too_large: (mb: number) => `This request is too large for the demo (limit ${mb} MB). Try fewer or smaller images.`,
  upstream_error: (status: number) => `Meta's AI service returned an error (status ${status}). Try again in a moment.`,
} as const;

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }

  get status() {
    return STATUS[this.code];
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(err: ApiError): Response {
  return json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status, err.headers);
}
