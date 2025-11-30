import { start } from 'workflow/api';
import { allWorkflows } from '../../_workflows.js';

export default async ({ req, url }: { req: Request; url: URL }) => {
  const workflowFile =
    url.searchParams.get('workflowFile') || 'workflows/bench.ts';
  if (!workflowFile) {
    return new Response('No workflowFile query parameter provided', {
      status: 400,
    });
  }
  const workflows = allWorkflows[workflowFile as keyof typeof allWorkflows];
  if (!workflows) {
    return new Response(`Workflow file "${workflowFile}" not found`, {
      status: 400,
    });
  }

  const workflowFn = url.searchParams.get('workflowFn') || 'noStepsWorkflow';
  if (!workflowFn) {
    return new Response('No workflow query parameter provided', {
      status: 400,
    });
  }
  const workflow = workflows[workflowFn as keyof typeof workflows];
  if (!workflow) {
    return new Response(`Workflow "${workflowFn}" not found`, { status: 400 });
  }

  let args: unknown[] = [];

  // Args from query string
  const argsParam = url.searchParams.get('args');
  if (argsParam) {
    args = argsParam.split(',').map((arg) => {
      const num = parseFloat(arg);
      return Number.isNaN(num) ? arg.trim() : num;
    });
  } else {
    // Args from body as plain JSON array
    const body = await req.text();
    if (body) {
      const parsed = JSON.parse(body);
      args = Array.isArray(parsed) ? parsed : [parsed];
    } else {
      args = [42];
    }
  }
  console.log(`Starting "${workflowFn}" workflow with args: ${args}`);

  try {
    const run = await start(workflow as Parameters<typeof start>[0], args as Parameters<typeof start>[1]);
    console.log('Run:', run.runId);
    return Response.json(run);
  } catch (err) {
    console.error(`Failed to start!!`, err);
    throw err;
  }
};
