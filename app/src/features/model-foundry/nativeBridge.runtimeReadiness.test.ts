import {it,expect,vi,beforeEach} from 'vitest';
const {invokeMock}=vi.hoisted(()=>({invokeMock:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:invokeMock}));
vi.mock('@/lib/utils',()=>({isTauri:true}));
import {getFoundryTrainingRuntimeStatus} from './nativeBridge';
beforeEach(()=>invokeMock.mockReset());
it.each([
 ['integrity failed',true,false,[],false],
 ['core dependencies missing',true,true,[],false],
 ['only optional method without core',true,true,['lora'],false],
 ['attested full runtime',true,true,['full','lora'],true],
 ['missing worker',false,false,[],false],
] as const)('reports recoverable readiness for %s',async(_case,installed,attested,methods,expected)=>{invokeMock.mockResolvedValue({installed,attested,methods,reason:'Verified runtime diagnostic',protocol:1,sourceSha256:'a'.repeat(64),python:'private/python.exe'});expect(await getFoundryTrainingRuntimeStatus()).toMatchObject({installed:expected,detail:'Verified runtime diagnostic'});expect(invokeMock).toHaveBeenCalledTimes(1);expect(invokeMock.mock.calls[0]?.[0]).toBe('model_foundry_training_worker_status');expect(invokeMock.mock.calls[0]?.[1]).toBeUndefined();});
it('never advertises QLoRA from an unattested worker',async()=>{invokeMock.mockResolvedValue({installed:true,attested:false,methods:['full','qlora'],reason:'Integrity failure'});expect(await getFoundryTrainingRuntimeStatus()).toMatchObject({installed:false,qloraInstalled:false});});

it('does not advertise Studio LoRA readiness from a Full-only probe', async () => {
  invokeMock.mockResolvedValue({ installed: true, attested: true, methods: ['full'],
    modalities: ['text'], precisions: ['fp32'], reason: 'Full ready; LoRA unavailable.' });
  expect(await getFoundryTrainingRuntimeStatus()).toMatchObject({ installed: false, qloraInstalled: false });
});

it('does not advertise QLoRA unless the core and LoRA probes also succeeded', async () => {
  invokeMock.mockResolvedValue({ installed: true, attested: true, methods: ['full', 'qlora'],
    modalities: ['text'], precisions: ['int4'], reason: 'Inconsistent optional probe.' });
  expect(await getFoundryTrainingRuntimeStatus()).toMatchObject({ installed: false, qloraInstalled: false });
});
