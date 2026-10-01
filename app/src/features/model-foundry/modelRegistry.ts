export interface FoundryModelSnapshotFile {
  readonly path: string;
  readonly url: string;
  readonly expectedSha256: string;
  readonly approvedMaximumBytes: number;
}

export interface FoundryModelCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: 'fixture' | 'downloadable';
  readonly publisher: string;
  readonly sourceUri: string;
  readonly revision: string;
  readonly license: string;
  readonly parameterCount: number;
  readonly displaySize: string;
  readonly minimumRamBytes: number;
  readonly recommendedRamBytes: number;
  readonly format: 'fixture' | 'safetensors';
  readonly remoteCode: false;
  readonly download?: {
    readonly files: readonly FoundryModelSnapshotFile[];
    readonly approvedMaximumBytes: number;
  };
}

const SMOLLM2_REVISION = 'a91318be21aeaf0879874faa161dcb40c68847e9';
const smolLm2Url = (path: string) => `https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct/resolve/${SMOLLM2_REVISION}/${path}`;

export const FOUNDRY_MODEL_CATALOG: readonly FoundryModelCatalogEntry[] = [
  {
    id: 'fixture-base', name: 'Fixture Base', kind: 'fixture', publisher: 'VibeSpace',
    sourceUri: 'fixture://models/base', revision: 'fixture-r1', license: 'Apache-2.0',
    parameterCount: 1_000_000, displaySize: '1 KB metadata', minimumRamBytes: 2_048,
    recommendedRamBytes: 2_048, format: 'fixture', remoteCode: false,
  },
  {
    id: 'smollm2-135m-instruct', name: 'SmolLM2 135M Instruct', kind: 'downloadable', publisher: 'Hugging FaceTB',
    sourceUri: 'https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct',
    revision: SMOLLM2_REVISION, license: 'Apache-2.0',
    parameterCount: 135_000_000, displaySize: '272 MB verified snapshot', minimumRamBytes: 4 * 1024 ** 3,
    recommendedRamBytes: 8 * 1024 ** 3, format: 'safetensors', remoteCode: false,
    download: {
      approvedMaximumBytes: 303_000_000,
      files: [
        { path: 'config.json', url: smolLm2Url('config.json'), expectedSha256: '8eb740e8bbe4cff95ea7b4588d17a2432deb16e8075bc5828ff7ba9be94d982a', approvedMaximumBytes: 861 },
        { path: 'generation_config.json', url: smolLm2Url('generation_config.json'), expectedSha256: '87b916edaaab66b3899b9d0dd0752727dff6666686da0504d89ae0a6e055a013', approvedMaximumBytes: 132 },
        { path: 'model.safetensors', url: smolLm2Url('model.safetensors'), expectedSha256: '5af571cbf074e6d21a03528d2330792e532ca608f24ac70a143f6b369968ab8c', approvedMaximumBytes: 300_000_000 },
        { path: 'special_tokens_map.json', url: smolLm2Url('special_tokens_map.json'), expectedSha256: '2b7379f3ae813529281a5c602bc5a11c1d4e0a99107aaa597fe936c1e813ca52', approvedMaximumBytes: 655 },
        { path: 'tokenizer.json', url: smolLm2Url('tokenizer.json'), expectedSha256: '9ca9acddb6525a194ec8ac7a87f24fbba7232a9a15ffa1af0c1224fcd888e47c', approvedMaximumBytes: 2_104_556 },
        { path: 'tokenizer_config.json', url: smolLm2Url('tokenizer_config.json'), expectedSha256: '4ec77d44f62efeb38d7e044a1db318f6a939438425312dfa333b8382dbad98df', approvedMaximumBytes: 3_764 },
      ],
    },
  },
] as const;

export function modelCompatibility(model: FoundryModelCatalogEntry, ramBytes: number | null): 'compatible' | 'constrained' | 'unknown' {
  if (model.kind === 'fixture') return 'compatible';
  if (ramBytes === null) return 'unknown';
  return ramBytes >= model.recommendedRamBytes ? 'compatible' : ramBytes >= model.minimumRamBytes ? 'constrained' : 'unknown';
}
