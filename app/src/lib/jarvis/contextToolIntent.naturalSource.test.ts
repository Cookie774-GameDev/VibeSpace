import { describe, expect, it } from 'vitest';
import { requestsReadOnlyContextTool } from './contextToolIntent';

describe('automatic read-only tools for natural project facts', () => {
  it.each([
    'Who owns BLUE KITE? Ground the answer in project records.',
    'Which depot is current? Ground the answer in project records.',
    'What was the earlier launch proposal and what is the signed launch date now? Use the mapped project records.',
    'How many usable unallocated units remain across the stock table? Ground the answer in project records.',
    'Which decision moved the depot and why? Ground the answer in project records.',
    'Trace the dependency chain before launch. Ground the answer in indexed records.',
    'Compare the planned start date with the signed launch date in mapped records.',
    'Find the signed launch date in the indexed source records.',
  ])('offers bounded evidence without requiring a tool name: %s', (prompt) => {
    expect(requestsReadOnlyContextTool(prompt)).toBe(true);
  });

  it.each([
    'Read the indexed records, then launch the server.',
    'Find the owner in project records and start a terminal.',
    'Which record is current? Then create a schedule with the answer.',
    'Who owns this project? Use the records to rename the chat.',
    'Start the job using mapped project records.',
    'Could you launch the app after reading indexed records?',
    'Read the mapped records and execute the command.',
    'Who owns this project? Do not use any tools.',
    'Who owns this company?',
    'What is two plus two?',
    'Review index.html and use the connected GitHub plugin.',
    'Read C:\\work\\records.txt with the native read tool.',
  ])('retains the requested native operation or ordinary control: %s', (prompt) => {
    expect(requestsReadOnlyContextTool(prompt)).toBe(false);
  });
});
