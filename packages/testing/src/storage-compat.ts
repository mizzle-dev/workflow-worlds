import { SPEC_VERSION_CURRENT, type Event, type Hook, type Storage, type Step, type WorkflowRun } from '@workflow/world';

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
  const result = await storage.events.create(runId, {
    eventType: 'step_retrying',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: stepId,
    eventData: {
      error,
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
  const result = await storage.events.create(runId, {
    eventType: 'step_failed',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: stepId,
    eventData: {
      error,
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
