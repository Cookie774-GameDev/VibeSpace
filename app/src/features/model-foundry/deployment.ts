export interface FoundryDeploymentRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly modelVersionId: string;
  readonly artifactFingerprint: string;
  readonly status: 'active' | 'paused';
  readonly routingMode: 'manual' | 'specialist_default' | 'shadow';
  readonly trafficPercent: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FoundryDeploymentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'vibespace.model-foundry.deployments.v1';

function parseRecords(raw: string | null): FoundryDeploymentRecord[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((record): record is FoundryDeploymentRecord => {
      if (!record || typeof record !== 'object') return false;
      const item = record as Partial<FoundryDeploymentRecord>;
      return item.schemaVersion === 1
        && typeof item.id === 'string'
        && typeof item.projectId === 'string'
        && typeof item.modelVersionId === 'string'
        && typeof item.artifactFingerprint === 'string'
        && (item.status === 'active' || item.status === 'paused')
        && (item.routingMode === 'manual' || item.routingMode === 'specialist_default' || item.routingMode === 'shadow')
        && typeof item.trafficPercent === 'number';
    });
  } catch {
    return [];
  }
}

export class FoundryDeploymentRepository {
  constructor(private readonly storage: FoundryDeploymentStorage, private readonly now: () => string, private readonly id: () => string) {}

  list(projectId: string): readonly FoundryDeploymentRecord[] {
    return parseRecords(this.storage.getItem(STORAGE_KEY)).filter((record) => record.projectId === projectId);
  }

  activate(input: Omit<FoundryDeploymentRecord, 'schemaVersion' | 'id' | 'status' | 'createdAt' | 'updatedAt'>): FoundryDeploymentRecord {
    if (!input.projectId || !input.modelVersionId || !/^[a-f0-9]{64}$/i.test(input.artifactFingerprint)) throw new Error('Deployment requires a verified champion artifact.');
    if (!Number.isInteger(input.trafficPercent) || input.trafficPercent < 0 || input.trafficPercent > 100) throw new Error('Traffic percentage must be between 0 and 100.');
    const records = parseRecords(this.storage.getItem(STORAGE_KEY)).map((record) => record.projectId === input.projectId && record.status === 'active' ? { ...record, status: 'paused' as const, updatedAt: this.now() } : record);
    const timestamp = this.now();
    const deployment: FoundryDeploymentRecord = { schemaVersion: 1, id: this.id(), ...input, status: 'active', createdAt: timestamp, updatedAt: timestamp };
    this.storage.setItem(STORAGE_KEY, JSON.stringify([...records, deployment]));
    window.dispatchEvent(new CustomEvent('vibespace:foundry-deployment-changed', { detail: deployment }));
    return deployment;
  }

  pause(projectId: string, deploymentId: string): FoundryDeploymentRecord {
    const records = parseRecords(this.storage.getItem(STORAGE_KEY));
    const target = records.find((record) => record.projectId === projectId && record.id === deploymentId);
    if (!target) throw new Error('Deployment record was not found.');
    const updated = { ...target, status: 'paused' as const, updatedAt: this.now() };
    this.storage.setItem(STORAGE_KEY, JSON.stringify(records.map((record) => record.id === deploymentId ? updated : record)));
    window.dispatchEvent(new CustomEvent('vibespace:foundry-deployment-changed', { detail: updated }));
    return updated;
  }
}
