import { keyValueStorage } from '@/lib/storage/key-value';
import {
  applyWorkflowInput,
  createWorkflow,
  deleteWorkflow,
  findWorkflow,
  loadWorkflows,
  renameWorkflow,
  saveWorkflows,
  workflowSummaryCopy,
  workflowsFromUnknown,
} from '@/lib/gateway/workflows';

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const mockGet = keyValueStorage.getItem as jest.Mock;
const mockSet = keyValueStorage.setItem as jest.Mock;

let counter = 0;
const makeId = () => `id-${(counter += 1)}`;

describe('a workflow is a named ordered list of steps', () => {
  test('createWorkflow trims, drops empty steps, and mints unique ids', () => {
    const workflows = createWorkflow(
      [],
      { name: '  Digest  ', steps: [' read mail ', '', 'summarize'] },
      makeId,
    );
    expect(workflows).toHaveLength(1);
    expect(workflows[0].name).toBe('Digest');
    expect(workflows[0].steps.map((step) => step.prompt)).toEqual(['read mail', 'summarize']);
    expect(new Set(workflows[0].steps.map((step) => step.id)).size).toBe(2);
  });

  test('an empty name or no steps is a no-op', () => {
    expect(createWorkflow([], { name: '  ', steps: ['x'] }, makeId)).toEqual([]);
    expect(createWorkflow([], { name: 'A', steps: ['', '  '] }, makeId)).toEqual([]);
  });

  test('findWorkflow matches a trimmed, case-insensitive name', () => {
    const workflows = createWorkflow([], { name: 'Digest', steps: ['x'] }, makeId);
    expect(findWorkflow(workflows, '  digest ')?.name).toBe('Digest');
    expect(findWorkflow(workflows, 'nope')).toBeUndefined();
  });

  test('applyWorkflowInput substitutes the placeholder only when there is input', () => {
    expect(applyWorkflowInput('Summarize {{input}} now', 'the mail')).toBe('Summarize the mail now');
    expect(applyWorkflowInput('Summarize {{input}} now', '   ')).toBe('Summarize {{input}} now');
    expect(applyWorkflowInput('No placeholder', 'x')).toBe('No placeholder');
  });

  test('rename and delete fold by id, and a junk store reads as none', () => {
    let workflows = createWorkflow([], { name: 'A', steps: ['x'] }, makeId);
    const id = workflows[0].id;
    workflows = renameWorkflow(workflows, id, ' B ');
    expect(workflows[0].name).toBe('B');
    expect(deleteWorkflow(workflows, id)).toEqual([]);

    expect(
      workflowsFromUnknown([
        { id: '1', name: 'empty', steps: [] },
        { id: '2', name: 'ok', steps: [{ id: 's', prompt: 'p' }] },
        'junk',
      ]),
    ).toHaveLength(1);
    expect(workflowsFromUnknown('nope')).toEqual([]);
    expect(workflowsFromUnknown(null)).toEqual([]);
  });

  test('load and save round-trip per gateway, best-effort', async () => {
    mockGet.mockResolvedValue(
      JSON.stringify([{ id: '1', name: 'A', steps: [{ id: 's', prompt: 'p' }] }]),
    );
    expect(await loadWorkflows('gw-1')).toHaveLength(1);

    await saveWorkflows('gw-1', []);
    expect(mockSet).toHaveBeenCalledWith('versutus:workflows:gw-1', '[]');

    mockGet.mockRejectedValue(new Error('offline'));
    expect(await loadWorkflows('gw-1')).toEqual([]);
  });

  test('the summary names the workflow and counts its steps', () => {
    expect(workflowSummaryCopy({ id: '1', name: 'A', steps: [{ id: 's', prompt: 'p' }] })).toBe(
      'A: 1 step',
    );
    expect(
      workflowSummaryCopy({
        id: '1',
        name: 'A',
        steps: [
          { id: 's1', prompt: 'p' },
          { id: 's2', prompt: 'q' },
        ],
      }),
    ).toBe('A: 2 steps');
  });
});
