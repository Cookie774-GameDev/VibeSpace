# RLM reliability, diagnostics, and native latency implementation plan

> Execute inline with executing-plans. No subagents; preserve the assigned C1 native instance and all peer work.

**Goal:** Diagnose and fix delayed native delivery and Context/RLM/SiYuan failures, with 10 unique human-worded questions, exact ground truth and one durable diagnostic timeline.
**Architecture:** Retain native transports, scoped Context Gateway, RLM coordinator, existing activity recorder, and preview store. Extend the existing recording/export path with bounded asynchronous persistence and summarized lifecycle metadata; do not add a second agent loop. Fix only measured blocking.
**Tech stack:** Tauri/Rust, WebView2, React/TypeScript, Playwright CDP9251, Vitest.
**Spec:** User request September13 for ten hard messy human prompts, parallel Codex/OpenCode Go chats, >99percent tool success, 120second target, under10ms local UI delivery, context/tool completeness and durable diagnostics.

## Global constraints
- Only C1 PID33932/profile-c initially; verify every replacement. No standalone browser, CUA, subagents, global credential changes or peer process control.
- Source9e28f304; continue integration/UnifiedChungus-final. Claim exact files before each change.
- Ten unique prompts, five per backend initially, with frozen expected facts and source citations. Codex gpt-5.6-luna low; OpenCode Go deepseek-v4-flash-vision-exp normal/auto. Additional matched Luna Go checks if needed; log exact effective identity.
- Deadline120000ms: preserve late results as correctness evidence but fail time target. No silent retries; attempt1 and recovery results separate. All10mustanswercorrectly. Tenpasses do not statistically certify >99percentgeneralreliability.
- Toolfailure numerator includes failed/timedout/incomplete requested operations; denominator explicit for top-level and internal calls. Absence of fabricatedextra tool calls is notfailure. Audit real search/open/expand/query/investigate/SiYuan operations separately.
- Native->JS and JS->publication/DOM measured withcorrelatedsequence/request/revision. Reportp50/p95/maxandclockuncertainty. Screenpresentation separate; neverequate modelwalltimewithlocaldelivery.
- No heavybuilds during timingcomparison. Runindependenttestchatsparallel,butsourceHMRonlybetweenrounds.
- Stopat20percentremaining;usagecheckabout30minutes. Ponytail5percentexcluded.

## Task1: Baseline and prompt ground truth
Files: work/rlm-latency-20260913-R19/prompts.json,ground-truth.json,baseline-identity.json,baseline.jsonl.
- Read user-created active corpus source/root/hash; reuse11,409,453-tokenlosslesscorpus.
- Reconstruct originals read-only frommanifest tochoose exactboundary/middle/EOFandcrossformatfacts;persistanswerkeyoutsidecorpus/modelscope.
- Create2ownednativechats;setexactbackend/model/effort;attachcurrentloadedpreviewmoduleprobeandrendererCPUprofile.
- Sendfirst2questionsandrecordnativeevents,toolresults,UIcommitcorrelationandfinalanswerswhileinspectingexistinglogs.

## Task2: Unified bounded diagnostic logging
Candidatefiles aftertrace/ownershipcheck: app/src/lib/diagnostics/appActivityLog.ts/test.ts; existingnative logwriter/exportmodule discoveredfromsource; ContextGateway/RLMstageproduceronlyifmissing.
- Reproduce actualrecordingoverhead/omittedstagefailurewithfocusedtests. Requirestart/end/status/duration,backendmodelscope,counts,truncation,errorcodesandrequestcorrelation; nosecret/fullcorpuslogging.
- Addbounded nonblocking nativepersistence through existingbridge, batches/backpressure/rotation; writefailureneverbreakschat. Preserve diagnosticdropcountsandavoidperdeltasecretscan/fullhistoryserialization.
- Tests: failure/endcorrelation,oversizedinputboundedwork,redaction,cancellation,writerfailure,rotatedlogandcorrectdroppedcounts.

## Task3: Fix measured delivery and tool failures
Candidatefiles aftercausaltrace: currentnativeadapters,streamingPreviewStore,actualexpensiveUIprojection;gatewaystageonlyiffailureobserved.
- Profilebaseline;writeREDregressionfortheexactblocking/incorrectnessmechanism.
- Applysmallestfix;focusedGREENplusaffectedintegrationtests;noUIvisualredesign.
- Rebuildonlyifnativechangesrequireit;gracefullyrestartC1afterownedturnsendandverifyidentity.

## Task4: Native ten-prompt acceptance and SiYuan integration
- Runremaininguniquequestionsinparallelpairsafterfix, thenrepeatfailedcaseswithoutdroppingoriginalfailures.
- Includecontrolledmapopen/reloadwhilebothchatswork;inspectactualtoolargument/result/citationandpartiallabelsinthefrontend.
- Recordeachfinalanswercorrectness,citationprovenance,effectivemodel/effort,calls,partialstatusandtimingsinoneJSONL;exporthumanreadablescorecard.
- Inspectofficialexternalbenchmarkmethodologies; compareonlymatchinglatencydefinitions/workload, markunmatchednumbersincomparable.

## Task5: Verification and own-only commits
- FocusedVitest/nativechecks, typecheck, build, cargo/releasecheckswhenaffected;reusepriorcompletedbroadcoverageandrerunaffectedfailedfiles,neverhidefailure.
- Commitonlyclaimedverifiedsource;appendledger+exactcommit/evidence/limits;restoreuserUIandreleaseonlyownlockswhenfinishedorrequiredcutoff.
