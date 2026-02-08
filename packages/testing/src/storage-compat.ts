import { SPEC_VERSION_CURRENT, type Event, type Hook, type Storage, type Step, type WorkflowRun } from '@workflow/world';

type LegacyStorage = Storage & {
  runs: Storage['runs'] & {
    create?: (data: {
      deploymentId: string;
      workflowName: string;
      input: unknown[];
      executionContext?: Record<string, unknown>;
      specVersion?: number;
    }) => Promise<WorkflowRun>;
    update?: (
      runId: string,
      data: {
        status?: WorkflowRun['status'];
        output?: unknown;
        error?: { message: string; stack?: string; code?: string };
      }
    ) => Promise<WorkflowRun>;
    cancel?: (runId: string) => Promise<WorkflowRun>;
  };
  steps: Storage['steps'] & {
    create?: (
      runId: string,
      data: { stepId: string; stepName: string; input: unknown[] }
    ) => Promise<Step>;
    update?: (
      runId: string,
      stepId: string,
      data: {
        status?: Step['status'];
        output?: unknown;
        error?: { message: string; stack?: string; code?: string };
        attempt?: number;
        retryAfter?: Date;
      }
    ) => Promise<Step>;
  };
  hooks: Storage['hooks'] & {
    create?: (
      runId: string,
      data: { hookId: string; token: string; metadata?: unknown }
    ) => Promise<Hook>;
    dispose?: (hookId: string) => Promise<Hook>;
  };
};

function asLegacy(storage: Storage): LegacyStorage {
  return storage as LegacyStorage;
}

export interface CreateRunInput {
  deploymentId: string;
  workflowName: string;
  input: unknown[];
  executionContext?: Record<string, unknown>;
}

export async function createRun(
  storage: Storage,
  input: CreateRunInput
): Promise<WorkflowRun> {
  const legacy = asLegacy(storage);
  if (typeof legacy.runs.create === 'function') {
    return legacy.runs.create({ ...input, specVersion: SPEC_VERSION_CURRENT });
  }

  const result = await storage.events.create(null, {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: input.deploymentId,
      workflowName: input.workflowName,
      input: input.input,
      executionContext: input.executionContext,
    },
  });

  if (!result.run) {
    throw new Error('run_created did not return a run entity');
  }

  return result.run;
}

export async function completeRun(
  storage: Storage,
  runId: string,
  output: unknown
): Promise<WorkflowRun | undefined> {
  const legacy = asLegacy(storage);
  if (typeof legacy.runs.update === 'function') {
    return legacy.runs.update(runId, {
      status: 'completed',
      output,
    });
  }

  const result = await storage.events.create(runId, {
    eventType: 'run_completed',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: { output },
  });

  return result.run;
}

export async function failRun(
  storage: Storage,
  runId: string,
  error: { message: string; stack?: string; code?: string }
): Promise<WorkflowRun | undefined> {
  const legacy = asLegacy(storage);
  if (typeof legacy.runs.update === 'function') {
    return legacy.runs.update(runId, {
      status: 'failed',
      error,
    });
  }

  const result = await storage.events.create(runId, {
    eventType: 'run_failed',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      error,
      errorCode: error.code,
    },
  });

  return result.run;
}

export async function cancelRun(
  storage: Storage,
  runId: string
): Promise<WorkflowRun | undefined> {
  const legacy = asLegacy(storage);
  if (typeof legacy.runs.cancel === 'function') {
    return legacy.runs.cancel(runId);
  }

  const result = await storage.events.create(runId, {
    eventType: 'run_cancelled',
    specVersion: SPEC_VERSION_CURRENT,
  });

  return result.run;
}

export async function createStep(
  storage: Storage,
  runId: string,
  data: { stepId: string; stepName: string; input: unknown[] }
): Promise<Step> {
  const legacy = asLegacy(storage);
  if (typeof legacy.steps.create === 'function') {
    return legacy.steps.create(runId, data);
  }

  const result = await storage.events.create(runId, {
    eventType: 'step_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: data.stepId,
    eventData: {
      stepName: data.stepName,
      input: data.input,
    },
  });

  if (!result.step) {
    throw new Error('step_created did not return a step entity');
  }

  return result.step;
}

export async function startStep(
  storage: Storage,
  runId: string,
  stepId: string
): Promise<Step | undefined> {
  const legacy = asLegacy(storage);
  if (typeof legacy.steps.update === 'function') {
    const current = await storage.steps.get(runId, stepId);
    return legacy.steps.update(runId, stepId, {
      status: 'running',
      attempt: current.attempt + 1,
    });
  }

  const result = await storage.events.create(runId, {
    eventType: 'step_started',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: stepId,
  });

  return result.step;
}

export async function retryStep(
  storage: Storage,
  runId: string,
  stepId: string,
  error: { message: string; stack?: string },
  retryAfter?: Date
): Promise<Step | undefined> {
  const legacy = asLegacy(storage);
  if (typeof legacy.steps.update === 'function') {
    return legacy.steps.update(runId, stepId, {
      status: 'pending',
      error,
      retryAfter,
    });
  }

  const result = await storage.events.create(runId, {
    eventType: 'step_retrying',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: stepId,
    eventData: {
      error,
      stack: error.stack,
      retryAfter,
    },
  });

  return result.step;
}

export async function completeStep(
  storage: Storage,
  runId: string,
  stepId: string,
  output: unknown
): Promise<Step | undefined> {
  const legacy = asLegacy(storage);
  if (typeof legacy.steps.update === 'function') {
    return legacy.steps.update(runId, stepId, {
      status: 'completed',
      output,
    });
  }

  const result = await storage.events.create(runId, {
    eventType: 'step_completed',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: stepId,
    eventData: {
      result: output,
    },
  });

  return result.step;
}

export async function failStep(
  storage: Storage,
  runId: string,
  stepId: string,
  error: { message: string; stack?: string }
): Promise<Step | undefined> {
  const legacy = asLegacy(storage);
  if (typeof legacy.steps.update === 'function') {
    return legacy.steps.update(runId, stepId, {
      status: 'failed',
      error,
    });
  }

  const result = await storage.events.create(runId, {
    eventType: 'step_failed',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: stepId,
    eventData: {
      error,
      stack: error.stack,
    },
  });

  return result.step;
}

export interface HookCreateResult {
  hook?: Hook;
  event?: Event;
}

export async function createHook(
  storage: Storage,
  runId: string,
  data: { hookId: string; token: string; metadata?: unknown }
): Promise<HookCreateResult> {
  const legacy = asLegacy(storage);
  if (typeof legacy.hooks.create === 'function') {
    const hook = await legacy.hooks.create(runId, data);
    return { hook };
  }

  const result = await storage.events.create(runId, {
    eventType: 'hook_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: data.hookId,
    eventData: {
      token: data.token,
      metadata: data.metadata,
    },
  });

  return {
    hook: result.hook,
    event: result.event,
  };
}
