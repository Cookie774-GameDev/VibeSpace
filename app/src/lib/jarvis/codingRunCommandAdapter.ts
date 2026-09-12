import type { CodingRunCommandReceipt, CodingRunTestReceipt } from './codingRunManifest';
import type { CodingTestAuthority, CodingTestPlan } from './codingRunRuntime';
import {
  assertNativeTerminalCommand,
  assertNativeTerminalHostReceipt,
  hashNativeArguments,
  type NativeTerminalCommand,
  type NativeTerminalGitExecutionPort,
} from './nativeTerminalGitCapabilityBroker';

export interface CodingRunCommandCatalog {
  resolve(input: {
    accountId: string;
    projectId: string;
    runId: string;
    planId: string;
  }): Promise<NativeTerminalCommand | null>;
}

export function createCodingRunCommandAdapter(input: {
  port: Pick<NativeTerminalGitExecutionPort, 'executeTerminal'>;
  catalog: CodingRunCommandCatalog;
}): CodingTestAuthority {
  const authority: CodingTestAuthority = {
    async execute(authorityInput) {
      const { accountId, projectId, runId, plan, signal } = authorityInput;
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u.test(accountId) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u.test(projectId) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u.test(runId) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,151}$/u.test(plan.id) ||
        !plan.executable ||
        !/^sha256:[a-f0-9]{64}$/u.test(plan.argumentsHash) ||
        !plan.cwd
      ) {
        throw new Error('Invalid focused coding-test authority.');
      }
      if (signal.aborted) throw new Error('Focused coding-test execution was cancelled.');
      const command = await input.catalog.resolve({
        accountId,
        projectId,
        runId,
        planId: plan.id,
      });
      if (!command) throw new Error('Focused coding-test command is not registered.');
      assertNativeTerminalCommand(command, plan.cwd);
      if (
        command.executable !== plan.executable ||
        command.cwd !== plan.cwd ||
        (await hashNativeArguments(command.arguments)) !== plan.argumentsHash ||
        command.network !== 'denied' ||
        Object.keys(command.environment).length > 0
      ) {
        throw new Error('Focused coding-test command does not match its approved plan.');
      }
      const receipt = await input.port.executeTerminal({
        accountId,
        projectId,
        runId,
        command,
        signal,
      });
      if (signal.aborted) throw new Error('Focused coding-test execution was cancelled.');
      assertNativeTerminalHostReceipt(receipt, command.bounds);
      if (receipt.cancelled || receipt.timedOut || receipt.exitCode === null) {
        throw new Error('Focused coding-test execution did not produce an exit status.');
      }
      const commandReceipt: CodingRunCommandReceipt = Object.freeze({
        id: `command-${plan.id}`,
        executable: plan.executable,
        argumentsHash: plan.argumentsHash,
        cwd: plan.cwd,
        startedAt: receipt.startedAt,
        finishedAt: receipt.finishedAt,
        exitCode: receipt.exitCode,
        resultRef: receipt.resultRef,
      });
      const testReceipt: CodingRunTestReceipt = Object.freeze({
        id: plan.id,
        commandReceiptId: commandReceipt.id,
        status: receipt.exitCode === 0 ? 'passed' : 'failed',
        resultRef: receipt.resultRef,
      });
      return Object.freeze({ command: commandReceipt, test: testReceipt });
    },
  };
  return Object.freeze(authority);
}

export function codingTestPlanFor(input: {
  id: string;
  command: NativeTerminalCommand;
  argumentsHash: `sha256:${string}`;
}): CodingTestPlan {
  return Object.freeze({
    id: input.id,
    executable: input.command.executable,
    argumentsHash: input.argumentsHash,
    cwd: input.command.cwd,
  });
}
