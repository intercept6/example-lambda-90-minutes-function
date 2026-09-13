import type { Context } from 'aws-lambda';

const SLEEP_MINUTES = 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Verification 1 & 2: sleeps for 20 minutes, then echoes the received event.
 * Deployed with a 30-minute function timeout on Lambda Managed Instances.
 * Invoked asynchronously (direct async invoke, or S3 event notification).
 */
export const handler = async (event: unknown, context: Context) => {
  const startedAt = new Date().toISOString();
  console.log('received event:', JSON.stringify(event));
  console.log(`start: ${startedAt}, remaining time: ${context.getRemainingTimeInMillis()} ms`);

  await sleep(SLEEP_MINUTES * 60 * 1000);

  const finishedAt = new Date().toISOString();
  console.log(`sleep finished. start: ${startedAt}, end: ${finishedAt}`);
  console.log('returning event:', JSON.stringify(event));

  return {
    startedAt,
    finishedAt,
    sleepMinutes: SLEEP_MINUTES,
    event,
  };
};
