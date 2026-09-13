import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js';

const SLEEP_MINUTES = 20;
const STEP_COUNT = 5;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface StepResult {
  step: number;
  startedAt: string;
  finishedAt: string;
}

/**
 * Verification 3: durable function with 5 steps, each sleeping 20 minutes
 * (100 minutes of work in total, exceeding the 90-minute single-invocation limit).
 *
 * After each step, context.wait() checkpoints the execution and suspends it,
 * ending the current invocation cleanly. The execution resumes in a new
 * invocation when the wait elapses, skipping completed steps (replay).
 *
 * This demonstrates:
 * - a single invocation running longer than 15 minutes (each step sleeps 20 min)
 * - a multi-step durable execution running longer than 90 minutes in total,
 *   spanning multiple invocations via checkpoint & replay
 *
 * Note: we intentionally avoid relying on invocation timeouts to split the
 * execution. LMI does not forcibly terminate code on timeout, so a
 * timeout-driven design would leave zombie invocations racing with replays.
 */
export const handler = withDurableExecution(
  async (event: unknown, context: DurableContext) => {
    context.logger.info('execution started', { event });

    const results: StepResult[] = [];
    for (let i = 1; i <= STEP_COUNT; i++) {
      const result = await context.step<StepResult>(`sleep-${i}`, async () => {
        const startedAt = new Date().toISOString();
        await sleep(SLEEP_MINUTES * 60 * 1000);
        return { step: i, startedAt, finishedAt: new Date().toISOString() };
      });
      // logger is replay-aware: completed steps do not log again on replay
      context.logger.info(`step ${i} completed`, { result });
      results.push(result);

      // Suspend the execution between steps so each invocation ends cleanly
      // after ~20 minutes instead of being cut off by the function timeout.
      if (i < STEP_COUNT) {
        await context.wait(`suspend-after-${i}`, { minutes: 1 });
      }
    }

    context.logger.info('all steps completed', { results });
    return { event, results };
  },
);
