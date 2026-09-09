export const SECRET_CLASSES = Object.freeze([
  'credentials',
  'private_key',
  'token',
  'password',
  'connection_string',
  'signing_material',
  'environment_secret',
  'high_entropy_candidate',
] as const);

export type SecretClass = (typeof SECRET_CLASSES)[number];
export type SecretPolicyAction = 'exclude' | 'redact' | 'ask';

export interface SecretFinding {
  secretClass: SecretClass;
  start: number;
  end: number;
  confidence: 'high' | 'candidate';
  detector: string;
}

export interface SecretPolicyResult {
  decision: 'allowed' | 'excluded' | 'redacted' | 'ask';
  text?: string;
  findings: readonly SecretFinding[];
  requiresUserDecision: boolean;
}

const MAX_SCAN_CHARS = 1024 * 1024;
const MAX_FINDINGS = 100;
const MAX_CANDIDATES = MAX_FINDINGS * 4;

type Detector = Readonly<{
  secretClass: SecretClass;
  detector: string;
  pattern: RegExp;
}>;

const DETECTORS: readonly Detector[] = [
  {
    secretClass: 'private_key',
    detector: 'private-key-block',
    pattern:
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]{0,100000}?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/giu,
  },
  {
    secretClass: 'private_key',
    detector: 'pgp-private-key-block',
    pattern:
      /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]{0,100000}?-----END PGP PRIVATE KEY BLOCK-----/giu,
  },
  {
    secretClass: 'connection_string',
    detector: 'credentialed-connection-uri',
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^:\s/@]{1,128}:[^@\s/]{4,512}@[^\s'"<>]+/giu,
  },
  {
    secretClass: 'token',
    detector: 'provider-token',
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|(?:gsk_|sb_secret_)[A-Za-z0-9_-]{16,}|(?:xai-|sk-ant-)[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]{8,}|whsec_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{12,})\b/giu,
  },
  {
    secretClass: 'token',
    detector: 'jwt-or-bearer',
    pattern:
      /\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{8,}={0,2})\b/giu,
  },
  {
    secretClass: 'password',
    detector: 'password-assignment',
    pattern:
      /\b(?:password|passwd|passphrase)\b\s*(?:[:=]|\bis\b)\s*(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|[^\s,;}]{4,})/giu,
  },
  {
    secretClass: 'signing_material',
    detector: 'signing-material-assignment',
    pattern:
      /\b(?:signing[-_ ]?key|webhook[-_ ]?secret|client[-_ ]?secret|service[-_ ]?role)\b\s*(?:[:=]|\bis\b)\s*(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[^\s,;}]{8,})/giu,
  },
  {
    secretClass: 'environment_secret',
    detector: 'environment-secret-assignment',
    pattern:
      /^[\t ]*[A-Z][A-Z0-9_]{1,100}(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)[A-Z0-9_]*\s*=\s*[^\s#]{6,}/gmu,
  },
  {
    secretClass: 'credentials',
    detector: 'credential-assignment',
    pattern:
      /\b(?:credential|authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|x[-_ ]?api[-_ ]?key|api[-_ ]?key|apikey|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|private[-_ ]?key|secret)\b\s*(?:[:=]|\bis\b)\s*(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|[^\s,;}]{4,})/giu,
  },
] as const;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function isHighEntropyCandidate(value: string): boolean {
  const characterClasses = [
    /[A-Z]/u.test(value),
    /[a-z]/u.test(value),
    /[0-9]/u.test(value),
    /[+/_=-]/u.test(value),
  ].filter(Boolean).length;
  return (
    value.length >= 32 &&
    !/^[a-f0-9]+$/iu.test(value) &&
    !/^([A-Za-z0-9])\1+$/u.test(value) &&
    characterClasses >= 3 &&
    entropy(value) >= 4.1
  );
}

function highEntropyCandidates(
  text: string,
  limit: number,
): { findings: SecretFinding[]; overflow: boolean } {
  const findings: SecretFinding[] = [];
  const pattern = /[A-Za-z0-9+/_=-]{32,256}/gu;
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    const start = match.index;
    if (start === undefined || !isHighEntropyCandidate(value)) {
      continue;
    }
    // Separators can make an ordinary absolute Windows path look like one
    // random token. Secret-like path components still require redaction.
    if (
      /^[A-Za-z]:$/u.test(text.slice(Math.max(0, start - 2), start)) &&
      value.startsWith('/') &&
      !value.split('/').some(isHighEntropyCandidate)
    )
      continue;
    findings.push({
      secretClass: 'high_entropy_candidate',
      start,
      end: start + value.length,
      confidence: 'candidate',
      detector: 'shannon-entropy',
    });
    if (findings.length >= limit) return { findings, overflow: true };
  }
  return { findings, overflow: false };
}

function incompletePrivateKeys(text: string, originalLength: number): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const pattern = /-----BEGIN(?: PGP PRIVATE KEY BLOCK|(?: [A-Z0-9]+)* PRIVATE KEY)-----/giu;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const endMarker = match[0].replace('BEGIN', 'END');
    const end = text.indexOf(endMarker, match.index + match[0].length);
    if (end >= 0 && end - match.index <= 100_000) continue;
    findings.push({
      secretClass: 'private_key',
      start: match.index,
      end: originalLength,
      confidence: 'high',
      detector: 'incomplete-private-key-block',
    });
  }
  return findings;
}

function boundaryFinding(start: number, end: number): SecretFinding {
  return {
    secretClass: 'high_entropy_candidate',
    start,
    end,
    confidence: 'candidate',
    detector: 'scan-boundary',
  };
}

function copyFinding(finding: SecretFinding): SecretFinding {
  return Object.freeze({ ...finding });
}

export function detectSecrets(value: string): readonly SecretFinding[] {
  if (typeof value !== 'string') throw new Error('secret_detector_input_invalid');
  const text = value.slice(0, MAX_SCAN_CHARS);
  const candidates: SecretFinding[] = [];
  let overflow = false;
  detectorLoop: for (const detector of DETECTORS) {
    for (const match of text.matchAll(detector.pattern)) {
      if (match.index === undefined) continue;
      candidates.push({
        secretClass: detector.secretClass,
        start: match.index,
        end: match.index + match[0].length,
        confidence: 'high',
        detector: detector.detector,
      });
      if (candidates.length >= MAX_CANDIDATES) {
        overflow = true;
        break detectorLoop;
      }
    }
  }
  if (!overflow) {
    candidates.push(...incompletePrivateKeys(text, value.length));
    const entropyCandidates = highEntropyCandidates(
      text,
      Math.max(1, MAX_CANDIDATES - candidates.length),
    );
    overflow = entropyCandidates.overflow;
    candidates.push(
      ...entropyCandidates.findings.filter(
        (candidate) =>
          !candidates.some((high) => candidate.start < high.end && high.start < candidate.end),
      ),
    );
  }
  if (overflow) {
    return Object.freeze([copyFinding(boundaryFinding(0, value.length))]);
  }
  candidates.sort(
    (left, right) =>
      left.start - right.start ||
      right.end - right.start - (left.end - left.start) ||
      (left.confidence === right.confidence ? 0 : left.confidence === 'high' ? -1 : 1),
  );
  const accepted: SecretFinding[] = [];
  for (const candidate of candidates) {
    const prior = accepted.at(-1);
    if (prior && candidate.start < prior.end) continue;
    if (accepted.length >= MAX_FINDINGS - 1) {
      accepted.push(boundaryFinding(candidate.start, value.length));
      return Object.freeze(accepted.map(copyFinding));
    }
    accepted.push(candidate);
  }
  if (value.length > text.length) {
    const prior = accepted.at(-1);
    if (!prior || prior.end < value.length) {
      if (accepted.length >= MAX_FINDINGS) {
        return Object.freeze([copyFinding(boundaryFinding(0, value.length))]);
      }
      accepted.push(boundaryFinding(text.length, value.length));
    }
  }
  return Object.freeze(accepted.map(copyFinding));
}

export function hasDetectedSecret(value: string): boolean {
  return detectSecrets(value).length > 0;
}

export function applySecretPolicy(value: string, action: SecretPolicyAction): SecretPolicyResult {
  if (!['exclude', 'redact', 'ask'].includes(action)) {
    throw new Error('secret_policy_action_invalid');
  }
  const findings = detectSecrets(value);
  if (findings.length === 0) {
    return Object.freeze({
      decision: 'allowed',
      text: value,
      findings,
      requiresUserDecision: false,
    });
  }
  if (action === 'exclude') {
    return Object.freeze({
      decision: 'excluded',
      text: undefined,
      findings,
      requiresUserDecision: false,
    });
  }
  if (action === 'ask') {
    return Object.freeze({
      decision: 'ask',
      text: undefined,
      findings,
      requiresUserDecision: true,
    });
  }
  let redacted = value;
  for (const finding of [...findings].reverse()) {
    redacted =
      redacted.slice(0, finding.start) +
      `[redacted:${finding.secretClass}]` +
      redacted.slice(finding.end);
  }
  return Object.freeze({
    decision: 'redacted',
    text: redacted,
    findings,
    requiresUserDecision: false,
  });
}
