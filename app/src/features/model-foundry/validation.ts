import {
  FOUNDRY_SCHEMA_VERSION,
  type BaseModelRecord,
  type DatasetVersionManifest,
  type EvaluationSuite,
  type EvaluationSuiteSummary,
  type FoundrySchemaVersion,
  type ProjectSnapshot,
  type SpecialistDefinition,
  type TrainingJobSnapshot,
  type TrainingManifest,
} from './domain';

export const CURRENT_FOUNDRY_SCHEMA_VERSION = FOUNDRY_SCHEMA_VERSION;
export const MAX_IDENTIFIER_LENGTH = 64;
export const MAX_NAME_LENGTH = 120;
export const MAX_TEXT_LENGTH = 2_000;
export const MAX_LIST_ITEMS = 64;

export interface ValidationIssue {
  readonly code:
    | 'blank'
    | 'invalid_format'
    | 'invalid_lifecycle'
    | 'invalid_provenance'
    | 'out_of_range'
    | 'too_long'
    | 'unsupported';
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly valid: true; readonly value: T; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] };

type UnknownRecord = Record<string, unknown>;

const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const STORAGE_SEPARATOR_PATTERN = /[\\/]/;
const SHELL_META_PATTERN = /[;&|`$><!*?()[\]{}"'~]/;
const ACTIVE_VALIDATION_STATES = ['queued', 'preparing', 'training', 'checkpointing'] as const;
const ACTIVE_VALIDATION_STATE_SET: ReadonlySet<string> = new Set(ACTIVE_VALIDATION_STATES);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: ValidationIssue[],
  path: readonly (string | number)[],
  code: ValidationIssue['code'],
  message: string,
) {
  issues.push({ path, code, message });
}

function validateSchema(record: UnknownRecord, issues: ValidationIssue[], path: readonly (string | number)[] = []) {
  if (record.schemaVersion !== CURRENT_FOUNDRY_SCHEMA_VERSION) {
    addIssue(issues, [...path, 'schemaVersion'], 'unsupported', 'Unsupported Foundry schema version.');
  }
}

function validateStorageId(
  value: unknown,
  issues: ValidationIssue[],
  path: readonly (string | number)[],
) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    addIssue(issues, path, 'blank', 'Identifier must not be blank.');
    return;
  }
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    addIssue(issues, path, 'too_long', `Identifier must not exceed ${MAX_IDENTIFIER_LENGTH} characters.`);
  }
  if (
    value.includes('..') ||
    STORAGE_SEPARATOR_PATTERN.test(value) ||
    CONTROL_PATTERN.test(value) ||
    SHELL_META_PATTERN.test(value)
  ) {
    addIssue(
      issues,
      path,
      'invalid_format',
      'Identifier contains traversal, separator, control, or shell metacharacters.',
    );
  }
}

function validateText(
  value: unknown,
  issues: ValidationIssue[],
  path: readonly (string | number)[],
  maxLength = MAX_TEXT_LENGTH,
) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    addIssue(issues, path, 'blank', 'Text must not be blank.');
    return;
  }
  if (value.length > maxLength) {
    addIssue(issues, path, 'too_long', `Text must not exceed ${maxLength} characters.`);
  }
  if (CONTROL_PATTERN.test(value)) {
    addIssue(issues, path, 'invalid_format', 'Text must not contain control characters.');
  }
}

function validateStringList(
  value: unknown,
  issues: ValidationIssue[],
  path: readonly (string | number)[],
  options: { nonEmpty?: boolean } = { nonEmpty: true },
) {
  if (!Array.isArray(value)) {
    addIssue(issues, path, 'invalid_format', 'Expected a list of text values.');
    return;
  }
  if (options.nonEmpty !== false && value.length === 0) {
    addIssue(issues, path, 'blank', 'At least one item is required.');
  }
  if (value.length > MAX_LIST_ITEMS) {
    addIssue(issues, path, 'out_of_range', `No more than ${MAX_LIST_ITEMS} items are allowed.`);
  }
  value.forEach((item, index) => validateText(item, issues, [...path, index]));
}

function validateJsonSchemaContract(
  value: unknown,
  issues: ValidationIssue[],
  path: readonly (string | number)[],
) {
  if (!isRecord(value) || value.type !== 'object' || !isRecord(value.properties)) {
    addIssue(issues, path, 'invalid_format', 'Expected an object schema with declared properties.');
    return;
  }
  validateStringList(value.required, issues, [...path, 'required']);
  for (const [key, property] of Object.entries(value.properties)) {
    validateStorageId(key, issues, [...path, 'properties', key]);
    if (!isRecord(property)) {
      addIssue(issues, [...path, 'properties', key], 'invalid_format', 'Expected a schema property.');
      continue;
    }
    validateText(property.description, issues, [...path, 'properties', key, 'description']);
  }
}

function validateIsoTimestamp(
  value: unknown,
  issues: ValidationIssue[],
  path: readonly (string | number)[],
) {
  if (
    typeof value !== 'string' ||
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    addIssue(issues, path, 'invalid_format', 'Expected an ISO timestamp.');
  }
}

function validateNonNegativeNumber(
  value: unknown,
  issues: ValidationIssue[],
  path: readonly (string | number)[],
) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    addIssue(issues, path, 'out_of_range', 'Expected a finite, non-negative number.');
  }
}

function validatePositiveNumber(
  value: unknown,
  issues: ValidationIssue[],
  path: readonly (string | number)[],
) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    addIssue(issues, path, 'out_of_range', 'Expected a finite number greater than zero.');
  }
}

function validateMetricMap(value: unknown, issues: ValidationIssue[], path: readonly (string | number)[]) {
  if (!isRecord(value)) {
    addIssue(issues, path, 'invalid_format', 'Expected a metric value map.');
    return;
  }
  for (const [metricId, metricValue] of Object.entries(value)) {
    validateStorageId(metricId, issues, [...path, metricId]);
    if (typeof metricValue !== 'number' || !Number.isFinite(metricValue)) {
      addIssue(issues, [...path, metricId], 'out_of_range', 'Metric values must be finite numbers.');
    }
  }
}

function validateHash(value: unknown, issues: ValidationIssue[], path: readonly (string | number)[]) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    addIssue(issues, path, 'invalid_format', 'Expected a 64-character hexadecimal hash.');
  }
}

function finish<T>(value: unknown, issues: ValidationIssue[]): ValidationResult<T> {
  return issues.length === 0
    ? { valid: true, value: value as T, issues: [] }
    : { valid: false, issues };
}

export function validateSpecialist(value: unknown): ValidationResult<SpecialistDefinition> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    addIssue(issues, [], 'invalid_format', 'Expected a specialist object.');
    return { valid: false, issues };
  }

  validateSchema(value, issues);
  validateStorageId(value.id, issues, ['id']);
  validateText(value.name, issues, ['name'], MAX_NAME_LENGTH);
  validateText(value.purpose, issues, ['purpose']);
  validateText(value.objective, issues, ['objective']);
  validateStringList(value.nonGoals, issues, ['nonGoals']);
  validateJsonSchemaContract(value.inputSchema, issues, ['inputSchema']);
  validateJsonSchemaContract(value.outputSchema, issues, ['outputSchema']);
  validateStringList(value.expectedInputs, issues, ['expectedInputs']);
  validateStringList(value.expectedOutputs, issues, ['expectedOutputs']);
  validateStringList(value.constraints, issues, ['constraints']);
  validateStringList(value.behaviorRequirements, issues, ['behaviorRequirements']);
  validateStringList(value.forbiddenBehavior, issues, ['forbiddenBehavior']);
  if (!isRecord(value.toolPermissions)) {
    addIssue(issues, ['toolPermissions'], 'invalid_format', 'Tool permissions are required.');
  } else {
    if (!['none', 'allowlist'].includes(String(value.toolPermissions.mode))) {
      addIssue(issues, ['toolPermissions', 'mode'], 'unsupported', 'Unsupported tool permission mode.');
    }
    validateStringList(value.toolPermissions.allowedTools, issues, ['toolPermissions', 'allowedTools'], {
      nonEmpty: value.toolPermissions.mode === 'allowlist',
    });
  }
  if (!isRecord(value.privacyPolicy) || value.privacyPolicy.localOnly !== true) {
    addIssue(issues, ['privacyPolicy'], 'unsupported', 'A local-only privacy policy is required.');
  }
  if (
    !isRecord(value.dataPolicy) ||
    value.dataPolicy.trainingUse !== 'approved_only' ||
    value.dataPolicy.externalTransfer !== false ||
    value.dataPolicy.rawDataLogging !== false
  ) {
    addIssue(issues, ['dataPolicy'], 'unsupported', 'Only approved, local, non-logging data use is supported.');
  }
  for (const [key, numericKey] of [
    ['latencyTarget', 'maxMilliseconds'],
    ['memoryTarget', 'maxBytes'],
  ] as const) {
    const target = value[key];
    if (!isRecord(target)) {
      addIssue(issues, [key], 'invalid_format', `${key} is required.`);
    } else if (target.kind === 'maximum') {
      validatePositiveNumber(target[numericKey], issues, [key, numericKey]);
    } else if (target.kind !== 'not_measured' || target[numericKey] !== null) {
      addIssue(issues, [key], 'invalid_format', `Invalid ${key}.`);
    }
  }
  if (!isRecord(value.evaluationRubric) || !Array.isArray(value.evaluationRubric.criteria)) {
    addIssue(issues, ['evaluationRubric'], 'invalid_format', 'Evaluation rubric criteria are required.');
  } else if (value.evaluationRubric.criteria.length === 0) {
    addIssue(issues, ['evaluationRubric', 'criteria'], 'blank', 'Evaluation rubric criteria are required.');
  } else {
    value.evaluationRubric.criteria.forEach((criterion, index) => {
      if (!isRecord(criterion)) {
        addIssue(issues, ['evaluationRubric', 'criteria', index], 'invalid_format', 'Expected a rubric criterion.');
        return;
      }
      validateStorageId(criterion.id, issues, ['evaluationRubric', 'criteria', index, 'id']);
      validateText(criterion.description, issues, ['evaluationRubric', 'criteria', index, 'description']);
      validatePositiveNumber(criterion.weight, issues, ['evaluationRubric', 'criteria', index, 'weight']);
    });
  }
  if (!isRecord(value.safetyRubric)) {
    addIssue(issues, ['safetyRubric'], 'invalid_format', 'Safety rubric is required.');
  } else {
    validateStringList(value.safetyRubric.requiredChecks, issues, ['safetyRubric', 'requiredChecks']);
  }
  if (!['personal', 'commercial', 'research'].includes(String(value.commercialIntent))) {
    addIssue(issues, ['commercialIntent'], 'unsupported', 'Unsupported commercial intent.');
  }
  validateStringList(value.modelLicenseConstraints, issues, ['modelLicenseConstraints']);
  for (const [key, amountKey] of [
    ['promotionThreshold', 'minimumValue'],
    ['regressionThreshold', 'maximumRegression'],
  ] as const) {
    const threshold = value[key];
    if (!isRecord(threshold)) {
      addIssue(issues, [key], 'invalid_format', `${key} is required.`);
    } else {
      validateStorageId(threshold.metricId, issues, [key, 'metricId']);
      validateNonNegativeNumber(threshold[amountKey], issues, [key, amountKey]);
    }
  }
  validateStorageId(value.owner, issues, ['owner']);
  validatePositiveNumber(value.version, issues, ['version']);

  if (!Array.isArray(value.successMetrics) || value.successMetrics.length === 0) {
    addIssue(issues, ['successMetrics'], 'blank', 'At least one measurable success metric is required.');
  } else {
    value.successMetrics.forEach((metric, index) => {
      const path = ['successMetrics', index] as const;
      if (!isRecord(metric)) {
        addIssue(issues, path, 'invalid_format', 'Expected a success metric object.');
        return;
      }
      validateStorageId(metric.id, issues, [...path, 'id']);
      validateText(metric.name, issues, [...path, 'name'], MAX_NAME_LENGTH);
      validateText(metric.description, issues, [...path, 'description']);
      validateNonNegativeNumber(metric.target, issues, [...path, 'target']);
      validateText(metric.unit, issues, [...path, 'unit'], MAX_NAME_LENGTH);
      if (metric.direction !== 'at_least' && metric.direction !== 'at_most') {
        addIssue(issues, [...path, 'direction'], 'unsupported', 'Unsupported success metric direction.');
      }
    });
  }

  if (value.privacyMode !== 'local_only') {
    addIssue(issues, ['privacyMode'], 'unsupported', 'Only local-only privacy mode is supported.');
  }
  validateIsoTimestamp(value.createdAt, issues, ['createdAt']);
  validateIsoTimestamp(value.updatedAt, issues, ['updatedAt']);
  return finish<SpecialistDefinition>(value, issues);
}

export function validateBaseModel(value: unknown): ValidationResult<BaseModelRecord> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    addIssue(issues, [], 'invalid_format', 'Expected a base model object.');
    return { valid: false, issues };
  }

  validateSchema(value, issues);
  validateStorageId(value.id, issues, ['id']);
  validateText(value.displayName, issues, ['displayName'], MAX_NAME_LENGTH);
  if (value.backend !== 'fixture' && value.backend !== 'real') {
    addIssue(issues, ['backend'], 'unsupported', 'Unsupported training backend.');
  }
  validateText(value.sourceUri, issues, ['sourceUri']);
  validateStorageId(value.revision, issues, ['revision']);
  validateText(value.license, issues, ['license'], MAX_NAME_LENGTH);
  validateNonNegativeNumber(value.parameterCount, issues, ['parameterCount']);
  validateText(value.quantization, issues, ['quantization'], MAX_NAME_LENGTH);
  validateNonNegativeNumber(value.sizeBytes, issues, ['sizeBytes']);

  if (!isRecord(value.checksum)) {
    addIssue(issues, ['checksum'], 'invalid_format', 'Checksum metadata is required.');
  } else {
    if (value.checksum.algorithm !== 'sha256') {
      addIssue(issues, ['checksum', 'algorithm'], 'unsupported', 'Only SHA-256 checksums are supported.');
    }
    validateHash(value.checksum.value, issues, ['checksum', 'value']);
  }

  if (!isRecord(value.minimumResources)) {
    addIssue(issues, ['minimumResources'], 'invalid_format', 'Minimum resource metadata is required.');
  } else {
    validateNonNegativeNumber(value.minimumResources.ramBytes, issues, ['minimumResources', 'ramBytes']);
    validateNonNegativeNumber(value.minimumResources.vramBytes, issues, ['minimumResources', 'vramBytes']);
    validateNonNegativeNumber(value.minimumResources.diskBytes, issues, ['minimumResources', 'diskBytes']);
  }

  if (!['approved', 'unreviewed', 'blocked'].includes(String(value.trustStatus))) {
    addIssue(issues, ['trustStatus'], 'unsupported', 'Unsupported trust status.');
  }
  if (!['compatible', 'incompatible', 'unknown'].includes(String(value.compatibilityStatus))) {
    addIssue(issues, ['compatibilityStatus'], 'unsupported', 'Unsupported compatibility status.');
  }
  if (!isRecord(value.remoteCode)) {
    addIssue(issues, ['remoteCode'], 'invalid_format', 'Remote-code policy is required.');
  } else {
    if (value.remoteCode.supported !== false) {
      addIssue(issues, ['remoteCode', 'supported'], 'unsupported', 'Remote code execution is unsupported.');
    }
    if (value.remoteCode.requested !== false) {
      addIssue(issues, ['remoteCode', 'requested'], 'unsupported', 'Remote code execution cannot be requested.');
    }
  }
  validateIsoTimestamp(value.createdAt, issues, ['createdAt']);
  return finish<BaseModelRecord>(value, issues);
}

export function validateDatasetVersion(value: unknown): ValidationResult<DatasetVersionManifest> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    addIssue(issues, [], 'invalid_format', 'Expected a dataset version manifest.');
    return { valid: false, issues };
  }

  validateSchema(value, issues);
  validateStorageId(value.id, issues, ['id']);
  validateStorageId(value.datasetId, issues, ['datasetId']);
  validatePositiveNumber(value.version, issues, ['version']);
  if (typeof value.version === 'number' && !Number.isInteger(value.version)) {
    addIssue(issues, ['version'], 'out_of_range', 'Dataset version must be an integer.');
  }
  validateHash(value.manifestHash, issues, ['manifestHash']);

  if (!Array.isArray(value.examples) || value.examples.length === 0) {
    addIssue(issues, ['examples'], 'blank', 'At least one dataset example is required.');
  } else {
    value.examples.forEach((example, index) => {
      const path = ['examples', index] as const;
      if (!isRecord(example)) {
        addIssue(issues, path, 'invalid_format', 'Expected a dataset example.');
        return;
      }
      validateStorageId(example.id, issues, [...path, 'id']);
      validateStorageId(example.projectId, issues, [...path, 'projectId']);
      validateStorageId(example.datasetVersionId, issues, [...path, 'datasetVersionId']);
      if (example.datasetVersionId !== value.id) {
        addIssue(issues, [...path, 'datasetVersionId'], 'invalid_provenance', 'Example must reference this dataset version.');
      }
      if (!['prompt_completion', 'chat_conversation', 'tool_trace', 'code_patch', 'before_after', 'bug_fix', 'test_failure_fix', 'structured_extraction', 'classification', 'preference', 'rubric_scored', 'human_edit', 'accepted_output', 'rejected_output', 'evaluation'].includes(String(example.exampleType))) {
        addIssue(issues, [...path, 'exampleType'], 'unsupported', 'Unsupported dataset example type.');
      }
      validateText(example.input, issues, [...path, 'input']);
      validateText(example.expectedOutput, issues, [...path, 'expectedOutput']);
      if (!['train', 'validation', 'test'].includes(String(example.split))) {
        addIssue(issues, [...path, 'split'], 'unsupported', 'Unsupported dataset split.');
      }
      validateStringList(example.labels, issues, [...path, 'labels'], { nonEmpty: false });
      validateStringList(example.tags, issues, [...path, 'tags'], { nonEmpty: false });
      validateHash(example.contentHash, issues, [...path, 'contentHash']);
      if (!isRecord(example.provenance)) {
        addIssue(issues, [...path, 'provenance'], 'invalid_provenance', 'Example provenance is required.');
      } else {
        validateStorageId(example.provenance.sourceId, issues, [...path, 'provenance', 'sourceId']);
        validateText(example.provenance.sourceVersion, issues, [...path, 'provenance', 'sourceVersion'], MAX_NAME_LENGTH);
      }
      validateText(example.license, issues, [...path, 'license'], MAX_NAME_LENGTH);
      validateNonNegativeNumber(example.tokenEstimate, issues, [...path, 'tokenEstimate']);
      if (!['user', 'reviewer', 'synthetic_generator'].includes(String(example.authorType))) {
        addIssue(issues, [...path, 'authorType'], 'unsupported', 'Unsupported example author type.');
      }
      if (typeof example.synthetic !== 'boolean') {
        addIssue(issues, [...path, 'synthetic'], 'invalid_format', 'Synthetic provenance flag is required.');
      }
      if (!['private', 'sensitive', 'public'].includes(String(example.privacyClassification))) {
        addIssue(issues, [...path, 'privacyClassification'], 'unsupported', 'Unsupported privacy classification.');
      }
      if (example.approvalStatus !== 'approved' || example.qualityStatus !== 'approved') {
        addIssue(issues, [...path, 'approvalStatus'], 'invalid_provenance', 'Included examples must be approved.');
      }
      if (example.secretScanStatus !== 'passed') {
        addIssue(issues, [...path, 'secretScanStatus'], 'invalid_provenance', 'Included examples must pass secret scanning.');
      }
      if (!isRecord(example.source)) {
        addIssue(issues, [...path, 'source'], 'invalid_provenance', 'Approved source metadata is required.');
      } else {
        if (!['manual', 'user_authored', 'json', 'jsonl', 'csv', 'markdown', 'vibespace_conversation', 'accepted_agent_run', 'git_patch', 'test_artifact', 'context_map', 'licensed', 'approved_feedback'].includes(String(example.source.kind))) {
          addIssue(issues, [...path, 'source', 'kind'], 'unsupported', 'Unsupported dataset source kind.');
        }
        validateText(example.source.reference, issues, [...path, 'source', 'reference']);
        if (example.source.approved !== true) {
          addIssue(issues, [...path, 'source', 'approved'], 'invalid_provenance', 'Source must be approved.');
        }
      }
      if (!isRecord(example.consent)) {
        addIssue(issues, [...path, 'consent'], 'invalid_provenance', 'Consent metadata is required.');
      } else {
        if (example.consent.approved !== true) {
          addIssue(issues, [...path, 'consent', 'approved'], 'invalid_provenance', 'Consent must be approved.');
        }
        validateStorageId(example.consent.actorId, issues, [...path, 'consent', 'actorId']);
        validateIsoTimestamp(example.consent.approvedAt, issues, [...path, 'consent', 'approvedAt']);
        validateText(example.consent.purpose, issues, [...path, 'consent', 'purpose']);
      }
      validateIsoTimestamp(example.createdAt, issues, [...path, 'createdAt']);
    });
  }

  validateHash(value.fingerprint, issues, ['fingerprint']);
  validateStringList(value.includedExampleIds, issues, ['includedExampleIds']);
  validateStringList(value.excludedExampleIds, issues, ['excludedExampleIds'], { nonEmpty: false });
  if (!isRecord(value.splitStrategy) || !isRecord(value.splitStrategy.statistics)) {
    addIssue(issues, ['splitStrategy'], 'invalid_provenance', 'Deterministic split strategy is required.');
  } else {
    validateNonNegativeNumber(value.splitStrategy.seed, issues, ['splitStrategy', 'seed']);
    for (const split of ['train', 'validation', 'test']) {
      validateNonNegativeNumber(value.splitStrategy.statistics[split], issues, ['splitStrategy', 'statistics', split]);
    }
  }
  if (
    Array.isArray(value.includedExampleIds) &&
    Array.isArray(value.examples) &&
    value.includedExampleIds.length !== value.examples.length
  ) {
    addIssue(issues, ['includedExampleIds'], 'invalid_provenance', 'Included example IDs must match the manifest examples.');
  }
  if (Array.isArray(value.examples) && Array.isArray(value.includedExampleIds)) {
    const exampleIds = value.examples
      .filter(isRecord)
      .map((example) => example.id)
      .filter((id): id is string => typeof id === 'string');
    const includedIds = value.includedExampleIds.filter((id): id is string => typeof id === 'string');
    const exampleSet = new Set(exampleIds);
    const includedSet = new Set(includedIds);
    if (
      exampleSet.size !== exampleIds.length ||
      includedSet.size !== includedIds.length ||
      exampleSet.size !== includedSet.size ||
      exampleIds.some((id) => !includedSet.has(id))
    ) {
      addIssue(issues, ['includedExampleIds'], 'invalid_provenance', 'Included IDs must exactly match unique manifest examples.');
    }
    if (Array.isArray(value.excludedExampleIds) && value.excludedExampleIds.some((id) => exampleSet.has(String(id)))) {
      addIssue(issues, ['excludedExampleIds'], 'invalid_provenance', 'Excluded IDs cannot appear in manifest examples.');
    }
    if (isRecord(value.splitStrategy) && isRecord(value.splitStrategy.statistics)) {
      for (const split of ['train', 'validation', 'test'] as const) {
        const actual = value.examples.filter((example) => isRecord(example) && example.split === split).length;
        if (value.splitStrategy.statistics[split] !== actual) {
          addIssue(issues, ['splitStrategy', 'statistics', split], 'invalid_provenance', 'Split statistic does not match manifest examples.');
        }
      }
    }
  }

  if (!isRecord(value.scanSummary)) {
    addIssue(issues, ['scanSummary'], 'invalid_provenance', 'Scan summary is required.');
  } else {
    if (!['passed', 'failed'].includes(String(value.scanSummary.status))) {
      addIssue(issues, ['scanSummary', 'status'], 'unsupported', 'Unsupported scan status.');
    }
    validateText(value.scanSummary.scanner, issues, ['scanSummary', 'scanner'], MAX_NAME_LENGTH);
    validateNonNegativeNumber(value.scanSummary.issueCount, issues, ['scanSummary', 'issueCount']);
  }
  if (!isRecord(value.qualitySummary)) {
    addIssue(issues, ['qualitySummary'], 'invalid_provenance', 'Quality summary is required.');
  } else {
    validateNonNegativeNumber(value.qualitySummary.score, issues, ['qualitySummary', 'score']);
    validateStorageId(value.qualitySummary.reviewedBy, issues, ['qualitySummary', 'reviewedBy']);
  }
  if (!isRecord(value.lineage)) {
    addIssue(issues, ['lineage'], 'invalid_provenance', 'Dataset lineage is required.');
  } else {
    validateStringList(value.lineage.sourceDatasetIds, issues, ['lineage', 'sourceDatasetIds'], {
      nonEmpty: false,
    });
    validateStringList(value.lineage.feedbackEventIds, issues, ['lineage', 'feedbackEventIds'], {
      nonEmpty: false,
    });
    if (Array.isArray(value.examples) && Array.isArray(value.lineage.feedbackEventIds)) {
      const feedbackIds = new Set(value.lineage.feedbackEventIds.map(String));
      value.examples.forEach((example, index) => {
        if (isRecord(example) && isRecord(example.source) && example.source.kind === 'approved_feedback' && !feedbackIds.has(String(example.source.reference))) {
          addIssue(issues, ['examples', index, 'source', 'reference'], 'invalid_provenance', 'Approved feedback source must appear in dataset lineage.');
        }
      });
    }
  }
  for (const reportName of ['licenseReport', 'secretScanReport'] as const) {
    const report = value[reportName];
    if (!isRecord(report) || report.status !== 'passed') {
      addIssue(issues, [reportName], 'invalid_provenance', `${reportName} must be present and passing.`);
    }
  }
  validateIsoTimestamp(value.createdAt, issues, ['createdAt']);
  return finish<DatasetVersionManifest>(value, issues);
}

export function validateTrainingJob(value: unknown): ValidationResult<TrainingJobSnapshot> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    addIssue(issues, [], 'invalid_format', 'Expected a training job snapshot.');
    return { valid: false, issues };
  }
  validateSchema(value, issues);
  validateStorageId(value.id, issues, ['id']);
  validateStorageId(value.projectId, issues, ['projectId']);
  validateStorageId(value.manifestId, issues, ['manifestId']);
  if (value.backend !== 'fixture' && value.backend !== 'real') {
    addIssue(issues, ['backend'], 'unsupported', 'Unsupported training backend.');
  }
  const states = ['queued', 'preparing', 'training', 'checkpointing', 'completed', 'cancelled', 'failed', 'interrupted'];
  if (!states.includes(String(value.state))) {
    addIssue(issues, ['state'], 'unsupported', 'Unsupported training state.');
  }
  validateNonNegativeNumber(value.sequence, issues, ['sequence']);
  if (typeof value.sequence === 'number' && !Number.isInteger(value.sequence)) {
    addIssue(issues, ['sequence'], 'out_of_range', 'Sequence must be an integer.');
  }
  validateNonNegativeNumber(value.progress, issues, ['progress']);
  if (typeof value.progress === 'number' && value.progress > 1) {
    addIssue(issues, ['progress'], 'out_of_range', 'Progress cannot exceed 1.');
  }
  if (value.state === 'completed' && value.progress !== 1) {
    addIssue(issues, ['progress'], 'invalid_lifecycle', 'Completed jobs must have progress exactly 1.');
  }
  if (value.state === 'completed' && !isRecord(value.artifact)) {
    addIssue(issues, ['artifact'], 'invalid_lifecycle', 'Completed fixture jobs require an artifact reference.');
  }
  if (value.state === 'checkpointing' && !isRecord(value.checkpoint)) {
    addIssue(issues, ['checkpoint'], 'invalid_lifecycle', 'Checkpointing jobs require a checkpoint reference.');
  }
  if (value.state === 'cancelled' && !isRecord(value.cancellation)) {
    addIssue(issues, ['cancellation'], 'invalid_lifecycle', 'Cancelled jobs require cancellation metadata.');
  }
  if (!isRecord(value.recovery)) {
    addIssue(issues, ['recovery'], 'invalid_lifecycle', 'Recovery metadata is required.');
  } else if (value.state === 'interrupted' && value.recovery.recoverable !== true) {
    addIssue(
      issues,
      ['recovery', 'recoverable'],
      'invalid_lifecycle',
      'Interrupted fixture jobs must remain recoverable.',
    );
  } else if (value.state === 'interrupted') {
    if (!ACTIVE_VALIDATION_STATE_SET.has(String(value.recovery.previousState))) {
      addIssue(issues, ['recovery', 'previousState'], 'invalid_lifecycle', 'Interrupted jobs require a prior active state.');
    }
    validateIsoTimestamp(value.recovery.interruptedAt, issues, ['recovery', 'interruptedAt']);
  } else if (['queued', 'preparing', 'training', 'checkpointing'].includes(String(value.state)) && value.recovery.recoverable !== true) {
    addIssue(issues, ['recovery', 'recoverable'], 'invalid_lifecycle', 'Active jobs must remain recoverable.');
  }
  if (value.state === 'failed' && !isRecord(value.error)) {
    addIssue(issues, ['error'], 'invalid_lifecycle', 'Failed jobs require a structured error.');
  }
  validateIsoTimestamp(value.createdAt, issues, ['createdAt']);
  validateIsoTimestamp(value.updatedAt, issues, ['updatedAt']);
  return finish<TrainingJobSnapshot>(value, issues);
}

export function validateTrainingManifest(value: unknown): ValidationResult<TrainingManifest> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    addIssue(issues, [], 'invalid_format', 'Expected a training manifest.');
    return { valid: false, issues };
  }
  validateSchema(value, issues);
  for (const key of ['id', 'projectId', 'specialistId', 'datasetVersionId', 'baseModelId', 'baseRevision']) {
    validateStorageId(value[key], issues, [key]);
  }
  validateHash(value.datasetManifestHash, issues, ['datasetManifestHash']);
  validateHash(value.datasetFingerprint, issues, ['datasetFingerprint']);
  if (!isRecord(value.baseChecksum)) {
    addIssue(issues, ['baseChecksum'], 'invalid_provenance', 'Base checksum is required.');
  } else {
    validateHash(value.baseChecksum.value, issues, ['baseChecksum', 'value']);
  }
  if (!['lora', 'qlora'].includes(String(value.method))) {
    addIssue(issues, ['method'], 'unsupported', 'Only LoRA and QLoRA methods are modeled.');
  }
  if (!isRecord(value.config)) {
    addIssue(issues, ['config'], 'invalid_format', 'Training config is required.');
  } else {
    validatePositiveNumber(value.config.epochs, issues, ['config', 'epochs']);
    validatePositiveNumber(value.config.learningRate, issues, ['config', 'learningRate']);
    validatePositiveNumber(value.config.rank, issues, ['config', 'rank']);
    validateNonNegativeNumber(value.config.seed, issues, ['config', 'seed']);
    validatePositiveNumber(value.config.batchSize, issues, ['config', 'batchSize']);
    validatePositiveNumber(
      value.config.gradientAccumulationSteps,
      issues,
      ['config', 'gradientAccumulationSteps'],
    );
    validatePositiveNumber(value.config.sequenceLength, issues, ['config', 'sequenceLength']);
    validateNonNegativeNumber(value.config.validationSplit, issues, ['config', 'validationSplit']);
    if (typeof value.config.validationSplit === 'number' && value.config.validationSplit >= 1) {
      addIssue(issues, ['config', 'validationSplit'], 'out_of_range', 'Validation split must be below 1.');
    }
  }
  if (!isRecord(value.adapterConfiguration)) {
    addIssue(issues, ['adapterConfiguration'], 'invalid_provenance', 'Adapter configuration is required.');
  }
  validateText(value.quantization, issues, ['quantization'], MAX_NAME_LENGTH);
  validateText(value.softwareVersion, issues, ['softwareVersion'], MAX_NAME_LENGTH);
  validateText(value.workerVersion, issues, ['workerVersion'], MAX_NAME_LENGTH);
  if (value.backend === 'fixture' && value.hardwareSummary !== null) {
    addIssue(issues, ['hardwareSummary'], 'invalid_provenance', 'Fixture jobs must not fabricate hardware metadata.');
  }
  if (!['pending', 'fixture_completed', 'cancelled', 'failed', 'interrupted'].includes(String(value.exitState))) {
    addIssue(issues, ['exitState'], 'unsupported', 'Unsupported training manifest exit state.');
  }
  for (const collection of ['checkpoints', 'metrics', 'warnings', 'errors', 'artifactChecksums']) {
    if (!Array.isArray(value[collection])) {
      addIssue(issues, [collection], 'invalid_provenance', `${collection} collection is required.`);
    }
  }
  validateIsoTimestamp(value.createdAt, issues, ['createdAt']);
  return finish<TrainingManifest>(value, issues);
}

export function validateEvaluationSuite(value: unknown): ValidationResult<EvaluationSuite> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    addIssue(issues, [], 'invalid_format', 'Expected an evaluation suite.');
    return { valid: false, issues };
  }
  validateSchema(value, issues);
  validateStorageId(value.id, issues, ['id']);
  validateText(value.name, issues, ['name'], MAX_NAME_LENGTH);
  validatePositiveNumber(value.version, issues, ['version']);
  validateText(value.targetCapability, issues, ['targetCapability']);
  validateText(value.description, issues, ['description']);
  validateStringList(value.caseIds, issues, ['caseIds']);
  validateText(value.rubric, issues, ['rubric']);
  validateStringList(value.deterministicChecks, issues, ['deterministicChecks']);
  validateStringList(value.requiredSafetyCaseIds, issues, ['requiredSafetyCaseIds']);
  validateStorageId(value.owner, issues, ['owner']);
  validateHash(value.fingerprint, issues, ['fingerprint']);
  if (!isRecord(value.judgeConfiguration)) {
    addIssue(issues, ['judgeConfiguration'], 'invalid_provenance', 'Judge configuration is required.');
  } else if (
    value.judgeConfiguration.kind === 'deterministic_fixture' &&
    value.judgeConfiguration.modelId !== null
  ) {
    addIssue(
      issues,
      ['judgeConfiguration', 'modelId'],
      'invalid_provenance',
      'Deterministic fixture judging must not claim a judge model.',
    );
  }
  if (!isRecord(value.promotionThresholds) || !isRecord(value.regressionThresholds)) {
    addIssue(issues, ['promotionThresholds'], 'invalid_provenance', 'Evaluation gate thresholds are required.');
  }
  validateIsoTimestamp(value.createdAt, issues, ['createdAt']);
  if (!Array.isArray(value.metricDefinitions) || value.metricDefinitions.length === 0) {
    addIssue(issues, ['metricDefinitions'], 'blank', 'Evaluation metrics are required.');
  } else {
    value.metricDefinitions.forEach((metric, index) => {
      if (!isRecord(metric)) {
        addIssue(issues, ['metricDefinitions', index], 'invalid_format', 'Expected a metric definition.');
        return;
      }
      validateStorageId(metric.id, issues, ['metricDefinitions', index, 'id']);
      validateText(metric.name, issues, ['metricDefinitions', index, 'name'], MAX_NAME_LENGTH);
      validateNonNegativeNumber(
        metric.allowedRegression,
        issues,
        ['metricDefinitions', index, 'allowedRegression'],
      );
      if (isRecord(value.promotionThresholds)) {
        if (typeof value.promotionThresholds[String(metric.id)] !== 'number' || !Number.isFinite(value.promotionThresholds[String(metric.id)])) {
          addIssue(issues, ['promotionThresholds', String(metric.id)], 'invalid_provenance', 'Every metric requires a finite promotion threshold.');
        }
      }
      if (isRecord(value.regressionThresholds)) {
        validateNonNegativeNumber(value.regressionThresholds[String(metric.id)], issues, ['regressionThresholds', String(metric.id)]);
      }
    });
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    addIssue(issues, ['cases'], 'blank', 'Evaluation cases are required.');
  } else {
    value.cases.forEach((evaluationCase, index) => {
      if (!isRecord(evaluationCase)) {
        addIssue(issues, ['cases', index], 'invalid_format', 'Expected an evaluation case.');
        return;
      }
      validateStorageId(evaluationCase.id, issues, ['cases', index, 'id']);
      validateHash(evaluationCase.contentHash, issues, ['cases', index, 'contentHash']);
      validateText(evaluationCase.input, issues, ['cases', index, 'input']);
      validateStringList(evaluationCase.permittedContext, issues, ['cases', index, 'permittedContext']);
      validatePositiveNumber(evaluationCase.timeoutMilliseconds, issues, ['cases', index, 'timeoutMilliseconds']);
      validatePositiveNumber(evaluationCase.outputCharacterLimit, issues, ['cases', index, 'outputCharacterLimit']);
      validateStringList(evaluationCase.allowedTools, issues, ['cases', index, 'allowedTools'], { nonEmpty: false });
      validateStringList(evaluationCase.forbiddenTools, issues, ['cases', index, 'forbiddenTools'], { nonEmpty: false });
      validateStringList(evaluationCase.tags, issues, ['cases', index, 'tags']);
      validateStringList(evaluationCase.expectedEvidence, issues, ['cases', index, 'expectedEvidence']);
      if (!isRecord(evaluationCase.expectedSchema) || evaluationCase.expectedSchema.type !== 'object') {
        addIssue(issues, ['cases', index, 'expectedSchema'], 'invalid_provenance', 'Expected output schema is required.');
      }
      if (typeof evaluationCase.hidden !== 'boolean') {
        addIssue(issues, ['cases', index, 'hidden'], 'invalid_format', 'Hidden-case flag is required.');
      }
      if (!isRecord(evaluationCase.fixtureEvidence)) {
        addIssue(issues, ['cases', index, 'fixtureEvidence'], 'invalid_provenance', 'Fixture evidence is required.');
      } else {
        validateMetricMap(evaluationCase.fixtureEvidence.baseMetrics, issues, ['cases', index, 'fixtureEvidence', 'baseMetrics']);
        validateMetricMap(evaluationCase.fixtureEvidence.candidateMetrics, issues, ['cases', index, 'fixtureEvidence', 'candidateMetrics']);
        if (evaluationCase.fixtureEvidence.championMetrics !== undefined) validateMetricMap(evaluationCase.fixtureEvidence.championMetrics, issues, ['cases', index, 'fixtureEvidence', 'championMetrics']);
        validateStringList(evaluationCase.fixtureEvidence.safetyFailures, issues, ['cases', index, 'fixtureEvidence', 'safetyFailures'], { nonEmpty: false });
      }
    });
  }
  if (Array.isArray(value.caseIds) && Array.isArray(value.cases)) {
    const caseIds = new Set(value.cases.filter(isRecord).map((item) => item.id).filter((id): id is string => typeof id === 'string'));
    const declaredIds = new Set(value.caseIds.filter((id): id is string => typeof id === 'string'));
    if (caseIds.size !== value.cases.length || declaredIds.size !== value.caseIds.length || [...caseIds].some((id) => !declaredIds.has(id)) || [...declaredIds].some((id) => !caseIds.has(id))) {
      addIssue(issues, ['caseIds'], 'invalid_provenance', 'Case IDs must exactly match unique evaluation cases.');
    }
    if (Array.isArray(value.requiredSafetyCaseIds) && value.requiredSafetyCaseIds.some((id) => !caseIds.has(String(id)))) {
      addIssue(issues, ['requiredSafetyCaseIds'], 'invalid_provenance', 'Required safety cases must be present in the suite.');
    }
  }
  return finish<EvaluationSuite>(value, issues);
}

function validateEvaluationSuiteSummary(value: unknown, issues: ValidationIssue[], path: readonly (string | number)[]) {
  if (!isRecord(value)) {
    addIssue(issues, path, 'invalid_format', 'Expected evaluation suite metadata.');
    return;
  }
  validateSchema(value, issues, path);
  validateStorageId(value.id, issues, [...path, 'id']);
  validateText(value.name, issues, [...path, 'name'], MAX_NAME_LENGTH);
  validatePositiveNumber(value.version, issues, [...path, 'version']);
  validateText(value.targetCapability, issues, [...path, 'targetCapability']);
  validateText(value.description, issues, [...path, 'description']);
  validateNonNegativeNumber(value.caseCount, issues, [...path, 'caseCount']);
  validateStringList(value.metricIds, issues, [...path, 'metricIds']);
  validateStringList(value.requiredSafetyCaseIds, issues, [...path, 'requiredSafetyCaseIds']);
  validateStorageId(value.owner, issues, [...path, 'owner']);
  validateHash(value.fingerprint, issues, [...path, 'fingerprint']);
  validateIsoTimestamp(value.createdAt, issues, [...path, 'createdAt']);
  if ('cases' in value) addIssue(issues, [...path, 'cases'], 'invalid_provenance', 'Persisted suites cannot contain evaluation cases.');
}

export function validateProjectSnapshot(value: unknown): ValidationResult<ProjectSnapshot> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    addIssue(issues, [], 'invalid_format', 'Expected a project snapshot.');
    return { valid: false, issues };
  }
  validateSchema(value, issues);
  if (value.fixtureLabel !== 'fixture') {
    addIssue(issues, ['fixtureLabel'], 'unsupported', 'Only fixture snapshots are supported here.');
  }
  if (!isRecord(value.project)) {
    addIssue(issues, ['project'], 'invalid_format', 'Project metadata is required.');
  } else {
    validateSchema(value.project, issues, ['project']);
    validateStorageId(value.project.id, issues, ['project', 'id']);
    const specialistResult = validateSpecialist(value.project.specialist);
    if (!specialistResult.valid) {
      specialistResult.issues.forEach((issue) =>
        issues.push({ ...issue, path: ['project', 'specialist', ...issue.path] }),
      );
    }
  }
  if (value.baseModel !== undefined) {
    const result = validateBaseModel(value.baseModel);
    if (!result.valid) result.issues.forEach((issue) => issues.push({ ...issue, path: ['baseModel', ...issue.path] }));
  }
  if (value.datasetVersion !== undefined) {
    const result = validateDatasetVersion(value.datasetVersion);
    if (!result.valid) result.issues.forEach((issue) => issues.push({ ...issue, path: ['datasetVersion', ...issue.path] }));
  }
  if (value.trainingManifest !== undefined) {
    const result = validateTrainingManifest(value.trainingManifest);
    if (!result.valid) result.issues.forEach((issue) => issues.push({ ...issue, path: ['trainingManifest', ...issue.path] }));
  }
  if (!Array.isArray(value.trainingManifests)) {
    addIssue(issues, ['trainingManifests'], 'invalid_format', 'Training manifest collection is required.');
  } else {
    value.trainingManifests.forEach((manifest, index) => {
      const result = validateTrainingManifest(manifest);
      if (!result.valid) {
        result.issues.forEach((issue) =>
          issues.push({ ...issue, path: ['trainingManifests', index, ...issue.path] }),
        );
      }
    });
  }
  if (!Array.isArray(value.trainingJobs)) {
    addIssue(issues, ['trainingJobs'], 'invalid_format', 'Training job collection is required.');
  } else {
    value.trainingJobs.forEach((job, index) => {
      const result = validateTrainingJob(job);
      if (!result.valid) result.issues.forEach((issue) => issues.push({ ...issue, path: ['trainingJobs', index, ...issue.path] }));
    });
  }
  for (const collection of ['evaluationSuites', 'evaluationRuns', 'modelVersions', 'promotions', 'feedbackEvents', 'improvementCycles']) {
    if (!Array.isArray(value[collection])) {
      addIssue(issues, [collection], 'invalid_format', `${collection} collection is required.`);
    }
  }
  if (Array.isArray(value.evaluationSuites)) {
    value.evaluationSuites.forEach((suite, index) => validateEvaluationSuiteSummary(suite, issues, ['evaluationSuites', index]));
  }
  const projectId = isRecord(value.project) && typeof value.project.id === 'string' ? value.project.id : undefined;
  const versionIds = new Set(Array.isArray(value.modelVersions) ? value.modelVersions.filter(isRecord).map((version) => version.id).filter((id): id is string => typeof id === 'string') : []);
  const jobIds = new Set(Array.isArray(value.trainingJobs) ? value.trainingJobs.filter(isRecord).map((job) => job.id).filter((id): id is string => typeof id === 'string') : []);
  const evaluationIds = new Set(Array.isArray(value.evaluationRuns) ? value.evaluationRuns.filter(isRecord).map((run) => run.id).filter((id): id is string => typeof id === 'string') : []);
  const suiteIds = new Set(Array.isArray(value.evaluationSuites) ? value.evaluationSuites.filter(isRecord).map((suite) => suite.id).filter((id): id is string => typeof id === 'string') : []);
  const suiteById = new Map(Array.isArray(value.evaluationSuites) ? value.evaluationSuites.filter(isRecord).filter((suite) => typeof suite.id === 'string').map((suite) => [suite.id as string, suite]) : []);
  const feedbackIds = new Set(Array.isArray(value.feedbackEvents) ? value.feedbackEvents.filter(isRecord).map((event) => event.id).filter((id): id is string => typeof id === 'string') : []);
  if (value.championVersionId !== undefined && !versionIds.has(String(value.championVersionId))) {
    addIssue(issues, ['championVersionId'], 'invalid_provenance', 'Champion must reference a persisted model version.');
  }
  if (Array.isArray(value.modelVersions)) value.modelVersions.forEach((version, index) => {
    const path = ['modelVersions', index] as const;
    if (!isRecord(version)) return addIssue(issues, path, 'invalid_format', 'Expected a model version.');
    validateSchema(version, issues, path); validateStorageId(version.id, issues, [...path, 'id']);
    if (version.projectId !== projectId) addIssue(issues, [...path, 'projectId'], 'invalid_provenance', 'Model version belongs to another project.');
    if (!jobIds.has(String(version.sourceJobId))) addIssue(issues, [...path, 'sourceJobId'], 'invalid_provenance', 'Model version must reference a training job.');
    validateHash(version.artifactFingerprint, issues, [...path, 'artifactFingerprint']); validateIsoTimestamp(version.createdAt, issues, [...path, 'createdAt']);
  });
  if (Array.isArray(value.evaluationRuns)) value.evaluationRuns.forEach((run, index) => {
    const path = ['evaluationRuns', index] as const;
    if (!isRecord(run)) return addIssue(issues, path, 'invalid_format', 'Expected an evaluation run.');
    validateSchema(run, issues, path); validateStorageId(run.id, issues, [...path, 'id']);
    if (run.projectId !== projectId) addIssue(issues, [...path, 'projectId'], 'invalid_provenance', 'Evaluation belongs to another project.');
    if (!suiteIds.has(String(run.suiteId))) addIssue(issues, [...path, 'suiteId'], 'invalid_provenance', 'Evaluation suite metadata must exist.');
    if (run.backend !== 'fixture') addIssue(issues, [...path, 'backend'], 'unsupported', 'Persisted evaluations must use the fixture backend.');
    if (!['completed', 'incomplete'].includes(String(run.status))) addIssue(issues, [...path, 'status'], 'unsupported', 'Unsupported evaluation status.');
    if (!isRecord(run.identities) || !versionIds.has(String(run.identities.candidateVersionId))) addIssue(issues, [...path, 'identities', 'candidateVersionId'], 'invalid_provenance', 'Evaluation must reference a candidate.');
    if (!Array.isArray(run.caseEvidence) || run.caseEvidence.length === 0) addIssue(issues, [...path, 'caseEvidence'], 'invalid_provenance', 'Evaluation evidence is required.');
    else run.caseEvidence.forEach((evidence, evidenceIndex) => {
      const evidencePath = [...path, 'caseEvidence', evidenceIndex] as const;
      if (!isRecord(evidence)) return addIssue(issues, evidencePath, 'invalid_format', 'Expected case evidence.');
      validateStorageId(evidence.caseId, issues, [...evidencePath, 'caseId']); validateHash(evidence.evidenceHash, issues, [...evidencePath, 'evidenceHash']);
      if ('input' in evidence) addIssue(issues, [...evidencePath, 'input'], 'invalid_provenance', 'Evaluation evidence cannot persist case inputs.');
      if (!isRecord(evidence.metricValues)) addIssue(issues, [...evidencePath, 'metricValues'], 'invalid_format', 'Metric evidence is required.');
      else { validateMetricMap(evidence.metricValues.base, issues, [...evidencePath, 'metricValues', 'base']); validateMetricMap(evidence.metricValues.candidate, issues, [...evidencePath, 'metricValues', 'candidate']); if (evidence.metricValues.champion !== undefined) validateMetricMap(evidence.metricValues.champion, issues, [...evidencePath, 'metricValues', 'champion']); }
      validateStringList(evidence.safetyFailures, issues, [...evidencePath, 'safetyFailures'], { nonEmpty: false });
    });
    if (!Array.isArray(run.aggregateDeltas) || run.aggregateDeltas.length === 0) addIssue(issues, [...path, 'aggregateDeltas'], 'invalid_provenance', 'Aggregate evaluation deltas are required.');
    else run.aggregateDeltas.forEach((delta, deltaIndex) => {
      const deltaPath = [...path, 'aggregateDeltas', deltaIndex] as const;
      if (!isRecord(delta)) return addIssue(issues, deltaPath, 'invalid_format', 'Expected aggregate delta.');
      validateStorageId(delta.metricId, issues, [...deltaPath, 'metricId']);
      for (const field of ['baseValue', 'candidateValue', 'candidateDeltaFromBase']) if (typeof delta[field] !== 'number' || !Number.isFinite(delta[field])) addIssue(issues, [...deltaPath, field], 'out_of_range', 'Aggregate values must be finite.');
      if (typeof delta.passes !== 'boolean') addIssue(issues, [...deltaPath, 'passes'], 'invalid_format', 'Aggregate pass status is required.');
    });
    validateStringList(run.safetyFailures, issues, [...path, 'safetyFailures'], { nonEmpty: false });
    const suite = suiteById.get(String(run.suiteId));
    if (suite) {
      if (Array.isArray(run.caseEvidence) && run.caseEvidence.length !== suite.caseCount) addIssue(issues, [...path, 'caseEvidence'], 'invalid_provenance', 'Evaluation evidence count must match suite metadata.');
      if (Array.isArray(run.aggregateDeltas) && Array.isArray(suite.metricIds)) {
        const actualMetricIds = new Set(run.aggregateDeltas.filter(isRecord).map((delta) => String(delta.metricId)));
        const expectedMetricIds = new Set(suite.metricIds.map(String));
        if (actualMetricIds.size !== expectedMetricIds.size || [...expectedMetricIds].some((id) => !actualMetricIds.has(id))) addIssue(issues, [...path, 'aggregateDeltas'], 'invalid_provenance', 'Aggregate metrics must exactly match suite metadata.');
      }
    }
    if (!isRecord(run.gate) || !['pass', 'blocked', 'incomplete'].includes(String(run.gate.result)) || !Array.isArray(run.gate.reasons)) addIssue(issues, [...path, 'gate'], 'invalid_provenance', 'Evaluation gate structure is invalid.');
    else if (run.gate.result === 'pass' && (run.status !== 'completed' || run.gate.reasons.length > 0 || (Array.isArray(run.safetyFailures) && run.safetyFailures.length > 0) || (Array.isArray(run.aggregateDeltas) && run.aggregateDeltas.some((delta) => !isRecord(delta) || delta.passes !== true)))) addIssue(issues, [...path, 'gate'], 'invalid_provenance', 'Passing evaluations require complete, safe, passing evidence.');
    validateIsoTimestamp(run.createdAt, issues, [...path, 'createdAt']);
  });
  if (Array.isArray(value.promotions)) value.promotions.forEach((promotion, index) => {
    const path = ['promotions', index] as const;
    if (!isRecord(promotion)) return addIssue(issues, path, 'invalid_format', 'Expected a promotion record.');
    validateSchema(promotion, issues, path); validateStorageId(promotion.id, issues, [...path, 'id']);
    if (promotion.projectId !== projectId) addIssue(issues, [...path, 'projectId'], 'invalid_provenance', 'Promotion belongs to another project.');
    if (!versionIds.has(String(promotion.targetVersionId))) addIssue(issues, [...path, 'targetVersionId'], 'invalid_provenance', 'Promotion target must exist.');
    if (promotion.evaluationRunId !== undefined && !evaluationIds.has(String(promotion.evaluationRunId))) addIssue(issues, [...path, 'evaluationRunId'], 'invalid_provenance', 'Promotion evaluation must exist.');
    if (!isRecord(promotion.approval) || promotion.approval.approved !== true) addIssue(issues, [...path, 'approval'], 'invalid_provenance', 'Promotion requires approval.');
    else { validateStorageId(promotion.approval.actorId, issues, [...path, 'approval', 'actorId']); validateText(promotion.approval.reason, issues, [...path, 'approval', 'reason']); validateIsoTimestamp(promotion.approval.approvedAt, issues, [...path, 'approval', 'approvedAt']); }
    if (!isRecord(promotion.gateEvidence) || promotion.gateEvidence.artifactChecksumVerified !== true || promotion.gateEvidence.licenseApproved !== true || promotion.gateEvidence.evaluationGatePassed !== true) addIssue(issues, [...path, 'gateEvidence'], 'invalid_provenance', 'Promotion gate evidence must be complete and passing.');
    validateIsoTimestamp(promotion.createdAt, issues, [...path, 'createdAt']);
  });
  if (Array.isArray(value.feedbackEvents)) value.feedbackEvents.forEach((event, index) => {
    const path = ['feedbackEvents', index] as const;
    if (!isRecord(event)) return addIssue(issues, path, 'invalid_format', 'Expected feedback event.');
    validateSchema(event, issues, path); validateStorageId(event.id, issues, [...path, 'id']);
    if (event.projectId !== projectId) addIssue(issues, [...path, 'projectId'], 'invalid_provenance', 'Feedback belongs to another project.');
    if (!['helpful', 'not_helpful'].includes(String(event.rating))) addIssue(issues, [...path, 'rating'], 'unsupported', 'Unsupported feedback rating.');
    validateHash(event.evidenceHash, issues, [...path, 'evidenceHash']);
    if (!isRecord(event.consent) || event.consent.approved !== true) addIssue(issues, [...path, 'consent'], 'invalid_provenance', 'Feedback requires consent.');
    else { validateStorageId(event.consent.actorId, issues, [...path, 'consent', 'actorId']); validateIsoTimestamp(event.consent.approvedAt, issues, [...path, 'consent', 'approvedAt']); validateText(event.consent.purpose, issues, [...path, 'consent', 'purpose']); }
    validateIsoTimestamp(event.createdAt, issues, [...path, 'createdAt']);
  });
  if (Array.isArray(value.improvementCycles)) value.improvementCycles.forEach((cycle, index) => {
    const path = ['improvementCycles', index] as const;
    if (!isRecord(cycle)) return addIssue(issues, path, 'invalid_format', 'Expected improvement cycle.');
    validateSchema(cycle, issues, path); validateStorageId(cycle.id, issues, [...path, 'id']);
    if (cycle.projectId !== projectId) addIssue(issues, [...path, 'projectId'], 'invalid_provenance', 'Cycle belongs to another project.');
    if (!Array.isArray(cycle.feedbackProvenance) || cycle.feedbackProvenance.some((item) => !isRecord(item) || !feedbackIds.has(String(item.feedbackEventId)))) addIssue(issues, [...path, 'feedbackProvenance'], 'invalid_provenance', 'Cycle feedback provenance must exist.');
    validateIsoTimestamp(cycle.createdAt, issues, [...path, 'createdAt']);
  });
  if (value.championVersionId !== undefined && Array.isArray(value.promotions)) {
    const lastPromotion = value.promotions.at(-1);
    if (!isRecord(lastPromotion) || lastPromotion.targetVersionId !== value.championVersionId) addIssue(issues, ['championVersionId'], 'invalid_provenance', 'Champion must match the latest approved promotion or rollback.');
  }
  return finish<ProjectSnapshot>(value, issues);
}

export const VIBECODER_TEMPLATE: SpecialistDefinition = {
  schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION,
  id: 'vibecoder',
  name: 'VibeCoder',
  purpose: 'Review narrow coding changes against explicit acceptance criteria and local evidence.',
  objective: 'Produce precise, evidence-backed coding review findings for small local changes.',
  nonGoals: [
    'Executing code, installing runtimes, or modifying a repository.',
    'General-purpose conversation or claims about evidence that was not supplied.',
  ],
  inputSchema: {
    type: 'object',
    required: ['change', 'acceptanceCriteria'],
    properties: {
      change: { type: 'string', description: 'A file-scoped code change supplied locally.' },
      acceptanceCriteria: { type: 'array', description: 'Explicit criteria for the requested change.' },
      testEvidence: { type: 'string', description: 'Optional local test output supplied by the user.' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['findings', 'evidenceStatus'],
    properties: {
      findings: { type: 'array', description: 'Prioritized, file-scoped review findings.' },
      evidenceStatus: { type: 'string', description: 'A truthful summary of supplied evidence.' },
    },
  },
  expectedInputs: [
    'A file-scoped code change with language and runtime context.',
    'Explicit acceptance criteria and locally produced test evidence.',
  ],
  expectedOutputs: [
    'Prioritized findings with exact file locations and concrete impact.',
    'A concise statement when no evidence-backed finding is present.',
  ],
  constraints: [
    'Never claim code execution, repository access, or test results without supplied local evidence.',
    'Never include secrets or send code, prompts, or feedback off-device.',
    'Stay within the requested files and coding task.',
  ],
  behaviorRequirements: [
    'Tie every finding to supplied code or local test evidence.',
    'State clearly when the supplied evidence does not support a finding.',
  ],
  forbiddenBehavior: [
    'Do not claim to run tools, inspect files, or contact services.',
    'Do not reveal, retain, or transmit secrets or raw code outside the local project.',
  ],
  toolPermissions: { mode: 'none', allowedTools: [] },
  privacyPolicy: {
    classification: 'private',
    localOnly: true,
    retention: 'project_lifetime',
  },
  dataPolicy: {
    trainingUse: 'approved_only',
    externalTransfer: false,
    rawDataLogging: false,
  },
  latencyTarget: { kind: 'maximum', maxMilliseconds: 8_000 },
  memoryTarget: { kind: 'maximum', maxBytes: 1_073_741_824 },
  evaluationRubric: {
    criteria: [
      { id: 'evidence', description: 'Findings are supported by supplied evidence.', weight: 0.5 },
      { id: 'precision', description: 'Findings are concrete and actionable.', weight: 0.5 },
    ],
  },
  safetyRubric: {
    requiredChecks: ['no-secret-disclosure', 'no-unsupported-tool-claims', 'no-hidden-case-leakage'],
  },
  commercialIntent: 'personal',
  modelLicenseConstraints: ['Model license must permit local use and adapter creation.'],
  promotionThreshold: { metricId: 'finding-precision', minimumValue: 0.8 },
  regressionThreshold: { metricId: 'finding-precision', maximumRegression: 0.05 },
  successMetrics: [
    {
      id: 'finding-precision',
      name: 'Finding precision',
      description: 'Fraction of reported findings accepted as actionable by a reviewer.',
      target: 0.8,
      unit: 'ratio',
      direction: 'at_least',
    },
    {
      id: 'unsupported-claims',
      name: 'Unsupported claims',
      description: 'Count of claims about tools or evidence that were not supplied.',
      target: 0,
      unit: 'count',
      direction: 'at_most',
    },
  ],
  privacyMode: 'local_only',
  owner: 'local-owner',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export function isSupportedFoundrySchemaVersion(value: unknown): value is FoundrySchemaVersion {
  return value === CURRENT_FOUNDRY_SCHEMA_VERSION;
}
