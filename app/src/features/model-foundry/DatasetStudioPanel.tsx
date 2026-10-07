import * as React from 'react';
import { AlertTriangle, CheckCircle2, FileJson2, Plus, ScanSearch, ShieldCheck } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import type { DatasetVersionManifest } from './domain';
import { buildDatasetVersion, buildLocalSyntheticVariation, parseScopedDatasetImport, redactDatasetText, scanDatasetText, type DatasetDraft, type DatasetImportFormat, type ScanFinding } from './datasetStudio';
import { promotedAdapterForProject } from './adapterRegistry';
import { generateFromFoundryArtifact } from './nativeBridge';
import { useAuthStore } from '../../stores/auth';
import { resolveAccountIdentity } from '../../lib/accountIdentity';

export interface DatasetStudioPanelProps {
  readonly projectId: string;
  readonly now: () => string;
  readonly onVersion: (manifest: DatasetVersionManifest) => void;
  readonly version?: number;
  readonly parentVersionId?: string | null;
}

const emptyDraft = (): DatasetDraft => ({ input: '', expectedOutput: '', exampleType: 'prompt_completion', sourceKind: 'manual', sourceReference: 'local-manual-entry', license: 'user-owned', privacyClassification: 'private', tags: [] });

export function DatasetExamplePreview({ examples }: { readonly examples: readonly Pick<DatasetDraft, 'input' | 'expectedOutput'>[] }) {
  if (examples.length === 0) return <p className="text-metadata text-muted-foreground">No approved examples to preview.</p>;
  return <ol className="max-h-64 space-y-2 overflow-y-auto pr-1">
    {examples.map((example, index) => <li key={index} className="rounded-md border border-border bg-background/40 p-3">
      <div className="text-metadata text-muted-foreground">Example {index + 1}</div>
      <div className="mt-2 text-metadata text-muted-foreground">Input</div>
      <p className="whitespace-pre-wrap break-words text-secondary">{example.input}</p>
      <div className="mt-2 text-metadata text-muted-foreground">Expected output</div>
      <p className="whitespace-pre-wrap break-words text-secondary">{example.expectedOutput}</p>
    </li>)}
  </ol>;
}

export function DatasetStudioPanel(props: DatasetStudioPanelProps) {
  const scope = JSON.stringify([props.projectId, props.version ?? 1, props.parentVersionId ?? null]);
  return <DatasetStudioDraft key={scope} {...props} />;
}

function DatasetStudioDraft({ projectId, now, onVersion, version = 1, parentVersionId = null }: DatasetStudioPanelProps) {
  const [draft, setDraft] = React.useState<DatasetDraft>(emptyDraft);
  const [drafts, setDrafts] = React.useState<readonly DatasetDraft[]>([]);
  const [inputFindings, setInputFindings] = React.useState<readonly ScanFinding[]>([]);
  const [outputFindings, setOutputFindings] = React.useState<readonly ScanFinding[]>([]);
  const [consent, setConsent] = React.useState(false);
  const [importFormat, setImportFormat] = React.useState<DatasetImportFormat>('jsonl');
  const [importText, setImportText] = React.useState('');
  const [status, setStatus] = React.useState<string | null>(null);
  const [building, setBuilding] = React.useState(false);
  const [locked, setLocked] = React.useState(false);
  const [teacherApproval, setTeacherApproval] = React.useState(false);
  const [teacherBusy, setTeacherBusy] = React.useState(false);
  const mounted = React.useRef(false);
  const buildRevision = React.useRef(0);
  const teacherRevision = React.useRef(0);
  const activeBuild = React.useRef<symbol | null>(null);
  const activeTeacher = React.useRef<AbortController | null>(null);
  const revokeTeacher = () => {
    teacherRevision.current += 1;
    activeTeacher.current?.abort();
  };
  React.useLayoutEffect(() => {
    mounted.current = true;
    const unsubscribe = useAuthStore.subscribe((next, previous) => {
      const nextIdentity = resolveAccountIdentity(next);
      const previousIdentity = resolveAccountIdentity(previous);
      if (nextIdentity?.accountId !== previousIdentity?.accountId || nextIdentity?.source !== previousIdentity?.source ||
          next.workspaceId !== previous.workspaceId || next.projectId !== previous.projectId) {
        buildRevision.current += 1;
        teacherRevision.current += 1;
        activeTeacher.current?.abort();
        setConsent(false); setTeacherApproval(false);
      }
    });
    return () => {
      mounted.current = false;
      buildRevision.current += 1;
      teacherRevision.current += 1;
      activeTeacher.current?.abort();
      unsubscribe();
    };
  }, []);
  const changeDraft = (next: React.SetStateAction<DatasetDraft>) => {
    revokeTeacher(); setTeacherApproval(false); setDraft(next);
  };
  const appendDrafts = (next: readonly DatasetDraft[]) => {
    if (!next.length) return;
    buildRevision.current += 1; setConsent(false);
    setDrafts((current) => [...current, ...next]);
  };
  const changeConsent = (approved: boolean) => {
    buildRevision.current += 1; setConsent(approved);
  };
  const changeTeacherApproval = (approved: boolean) => {
    revokeTeacher(); setTeacherApproval(approved);
  };

  const findingCount = inputFindings.length + outputFindings.length;
  const scan = () => {
    const nextInput = scanDatasetText(draft.input);
    const nextOutput = scanDatasetText(draft.expectedOutput);
    setInputFindings(nextInput);
    setOutputFindings(nextOutput);
    setStatus(nextInput.length + nextOutput.length ? 'Example quarantined pending review or redaction.' : 'Secret and privacy scan passed.');
  };
  const redact = () => {
    changeDraft((current) => ({ ...current, input: redactDatasetText(current.input, inputFindings), expectedOutput: redactDatasetText(current.expectedOutput, outputFindings) }));
    setInputFindings([]); setOutputFindings([]); setStatus('Findings redacted. Run the scan again before approval.');
  };
  const addDraft = () => {
    scan();
    const findings = [...scanDatasetText(draft.input), ...scanDatasetText(draft.expectedOutput)];
    if (findings.length) return;
    if (!draft.input.trim() || !draft.expectedOutput.trim()) { setStatus('Input and expected output are required.'); return; }
    appendDrafts([draft]); changeDraft(emptyDraft()); setStatus('Approved example staged for immutable versioning.');
  };
  const stageSyntheticVariation = () => {
    const findings = [...scanDatasetText(draft.input), ...scanDatasetText(draft.expectedOutput)];
    if (findings.length) { setStatus('Scan and redact the seed before generating a local synthetic variation.'); return; }
    try { appendDrafts([buildLocalSyntheticVariation(draft)]); setStatus('Locally generated deterministic variation staged and labeled synthetic. Review it before creating the immutable version.'); }
    catch (caught) { setStatus(caught instanceof Error ? caught.message : 'Synthetic variation could not be staged.'); }
  };
  const generateWithLocalTeacher = async () => {
    if (activeTeacher.current) return;
    if (!teacherApproval) { setStatus('Explicit approval is required before a local promoted adapter may draft a teacher target.'); return; }
    if (!draft.input.trim()) { setStatus('Write a seed input before requesting a local teacher draft.'); return; }
    if (scanDatasetText(draft.input).length) { setStatus('The seed is quarantined. Redact findings and scan again before local teacher generation.'); return; }
    const teacher = promotedAdapterForProject(window.localStorage, projectId);
    if (!teacher) { setStatus('Promote a passing local adapter for this project before using it as a teacher.'); return; }
    const controller = new AbortController();
    activeTeacher.current = controller;
    const revision = teacherRevision.current;
    const isCurrent = () => mounted.current && activeTeacher.current === controller && teacherRevision.current === revision;
    setTeacherBusy(true);
    try {
      const response = await generateFromFoundryArtifact({ projectId, jobId: teacher.jobId, prompt: `Draft a concise expected response for this approved training input. Do not expose secrets, private paths, credentials, or tool calls.\n\nINPUT: ${draft.input.trim()}`, maxNewTokens: 256, signal: controller.signal });
      if (!isCurrent()) return;
      const currentTeacher = promotedAdapterForProject(window.localStorage, projectId);
      if (currentTeacher?.jobId !== teacher.jobId || currentTeacher.artifactManifestSha256 !== teacher.artifactManifestSha256 ||
          response.artifactManifestSha256 !== teacher.artifactManifestSha256) {
        setStatus('The local teacher changed or lost approval. Review and approve a new request.'); return;
      }
      const output = response.text.replace(/[\r\n\t]+/g, ' ').trim();
      const findings = scanDatasetText(output);
      if (!output || findings.length) { setStatus('Local teacher output was quarantined. It was not added to the dataset.'); return; }
      setDraft((current) => ({ ...current, expectedOutput: output, sourceKind: 'accepted_agent_run', sourceReference: `local-foundry-teacher:${teacher.jobId}`, synthetic: true, syntheticProvenance: `promoted local Foundry teacher ${teacher.jobId}; reviewed before approval` }));
      setStatus('Local teacher draft filled the expected-output field. Review, scan, and explicitly stage it before versioning.');
    } catch (caught) { if (isCurrent()) setStatus(caught instanceof Error ? caught.message : 'Local teacher generation failed.'); }
    finally {
      if (activeTeacher.current === controller) {
        activeTeacher.current = null;
        if (mounted.current) setTeacherBusy(false);
      }
    }
  };
  const importSelected = () => {
    try {
      const imported = parseScopedDatasetImport(importFormat, importText, `local-selected-${importFormat}`,
        importFormat === 'csv' ? { inputColumn: 'input', outputColumn: 'output', typeColumn: 'exampleType' } : undefined);
      appendDrafts(imported); setImportText(''); setStatus(`${imported.length} explicitly selected examples staged for review.`);
    } catch (caught) { setStatus(caught instanceof Error ? caught.message : 'Import failed.'); }
  };
  const createVersion = async () => {
    if (activeBuild.current) return;
    const attempt = Symbol('dataset-build'); activeBuild.current = attempt;
    const revision = buildRevision.current;
    const isCurrent = () => mounted.current && activeBuild.current === attempt && buildRevision.current === revision;
    setBuilding(true);
    try {
      const result = await buildDatasetVersion(drafts, { projectId, datasetId: 'vibecoder-dataset', version, parentVersionId, actorId: 'local-owner', consentApproved: consent, consentPurpose: 'Approved local specialist training and evaluation.', now: now(), seed: 7 });
      if (!isCurrent()) return;
      onVersion(result.manifest); setLocked(true); setStatus(`Immutable dataset v${version} created with ${result.manifest.examples.length} approved examples.`);
    } catch (caught) { if (isCurrent()) setStatus(caught instanceof Error ? caught.message : 'Dataset version creation failed.'); }
    finally {
      if (activeBuild.current === attempt) {
        activeBuild.current = null;
        if (mounted.current) setBuilding(false);
      }
    }
  };

  return <Card className="border-violet-500/20"><CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-violet-400" /> Dataset Studio</CardTitle><CardDescription>Only explicitly selected, consented, clean examples enter an immutable dataset version.</CardDescription></CardHeader><CardContent className="space-y-5">
    {locked ? <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-emerald-200"><CheckCircle2 className="h-5 w-5" /> {status}</div> : <>
      <div className="grid gap-4 md:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="dataset-input">Input</Label><Textarea id="dataset-input" value={draft.input} onChange={(event) => changeDraft((current) => ({ ...current, input: event.target.value }))} placeholder="Paste only the selected prompt, patch, failure, or source material." /></div><div className="space-y-1.5"><Label htmlFor="dataset-output">Expected output</Label><Textarea id="dataset-output" value={draft.expectedOutput} onChange={(event) => changeDraft((current) => ({ ...current, expectedOutput: event.target.value }))} placeholder="The approved target, fix, classification, or response." /></div></div>
      <div className="grid gap-3 md:grid-cols-3"><div><Label htmlFor="dataset-type">Example type</Label><select id="dataset-type" className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-secondary" value={draft.exampleType} onChange={(event) => changeDraft((current) => ({ ...current, exampleType: event.target.value as DatasetDraft['exampleType'] }))}><option value="prompt_completion">Prompt / completion</option><option value="code_patch">Code patch</option><option value="bug_fix">Bug / fix</option><option value="test_failure_fix">Test failure / fix</option><option value="preference">Preference pair</option><option value="evaluation">Evaluation only</option></select></div><div><Label htmlFor="dataset-source">Source reference</Label><Input id="dataset-source" value={draft.sourceReference} onChange={(event) => changeDraft((current) => ({ ...current, sourceReference: event.target.value }))} /></div><div><Label htmlFor="dataset-license">License</Label><Input id="dataset-license" value={draft.license} onChange={(event) => changeDraft((current) => ({ ...current, license: event.target.value }))} /></div></div>
      <div className="flex flex-wrap gap-2"><Button onClick={scan}><ScanSearch /> Scan example</Button>{findingCount > 0 && <Button variant="outline" onClick={redact}><AlertTriangle /> Redact {findingCount} findings</Button>}<Button variant="outline" onClick={stageSyntheticVariation}>Stage local synthetic variation</Button><Button variant="accent" onClick={addDraft}><Plus /> Add approved example</Button></div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3"><div><div className="text-ui-strong">Local teacher draft</div><p className="text-metadata text-muted-foreground">Uses this project’s promoted adapter only. It never leaves VibeSpace and still requires review, scanning, and explicit approval.</p></div><label className="flex items-start gap-2 text-secondary"><input type="checkbox" aria-label="Approve local teacher draft" checked={teacherApproval} onChange={(event) => changeTeacherApproval(event.target.checked)} /><span>I approve local teacher generation for this seed.</span></label><Button variant="outline" disabled={!teacherApproval || teacherBusy} onClick={() => void generateWithLocalTeacher()}>{teacherBusy ? 'Drafting locally…' : 'Draft with promoted adapter'}</Button></div>
      <div className="rounded-lg border border-border p-3"><div className="mb-2 flex items-center gap-2 text-ui-strong"><FileJson2 className="h-4 w-4" /> Scoped import</div><div className="grid gap-2 md:grid-cols-[140px_1fr_auto]"><select aria-label="Import format" className="h-8 rounded-md border border-input bg-background px-2 text-secondary" value={importFormat} onChange={(event) => setImportFormat(event.target.value as DatasetImportFormat)}><option value="jsonl">JSONL</option><option value="json">JSON</option><option value="csv">CSV mapping</option><option value="markdown">Markdown</option></select><Textarea aria-label="Selected import content" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="Paste only the explicitly selected records." /><Button onClick={importSelected} disabled={!importText.trim()}>Stage import</Button></div></div>
      <section aria-label="Review queue" className="space-y-3 rounded-lg border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-ui-strong">Review queue <Badge variant="outline">{drafts.length}</Badge></div><div className="text-metadata text-muted-foreground">Exact and normalized duplicates are removed when the version is built.</div></div><label className="flex items-start gap-2 text-secondary"><input type="checkbox" aria-label="Approve dataset consent" checked={consent} onChange={(event) => changeConsent(event.target.checked)} className="mt-0.5" /><span>I approve these selected examples for local training and evaluation.</span></label><Button variant="accent" disabled={!consent || drafts.length === 0 || building} onClick={() => void createVersion()}>{building ? 'Building version…' : `Create immutable dataset v${version}`}</Button></div><DatasetExamplePreview examples={drafts} /></section>
      {status && <p role="status" className="text-secondary text-muted-foreground">{status}</p>}
    </>}
  </CardContent></Card>;
}
