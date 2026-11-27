import crypto from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import { env } from './config/env.js';
import { logger } from './shared/logger.js';
import { redis } from './shared/queue.js';
import type { OrderRecord } from './modules/orders/order.service.js';

function signPayload(rawBody: string): string {
  return crypto
    .createHmac('sha256', env.WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
}

const worker = new Worker<OrderRecord>(
  'webhook-deliveries',
  async (job: Job<OrderRecord>) => {
    const { id: orderId, webhookUrl } = job.data;
    const payload = JSON.stringify({
      event: 'order.accepted',
      order: job.data,
      deliveredAt: new Date().toISOString(),
    });
    const signature = signPayload(payload);

    logger.info(
      { jobId: job.id, orderId, attempt: job.attemptsMade + 1, webhookUrl },
      'Dispatching signed webhook'
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-HMAC-SHA256': signature,
        },
        body: payload,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Webhook endpoint returned HTTP ${response.status}`);
      }

      logger.info({ jobId: job.id, orderId }, 'Webhook delivered successfully');
    } finally {
      clearTimeout(timeout);
    }
  },
  {
    connection: redis,
    concurrency: 5,
  }
);

worker.on('failed', (job, err) => {
  const maxAttempts = job?.opts.attempts ?? 1;
  const isFinalFailure = job ? job.attemptsMade >= maxAttempts : true;

  if (isFinalFailure) {
    logger.error(
      { jobId: job?.id, orderId: job?.data.id, err: err.message },
      'Webhook job exhausted all retries — retained in failed set (DLQ)'
    );
  } else {
    logger.warn(
      { jobId: job?.id, orderId: job?.data.id, attempt: job?.attemptsMade, err: err.message },
      'Webhook delivery failed — scheduled for exponential backoff retry'
    );
  }
});

async function shutdownWorker(signal: string) {
  logger.info({ signal }, 'Worker shutdown signal received — closing worker...');
  await worker.close();
  await redis.quit();
  logger.info('Worker shut down cleanly.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdownWorker('SIGTERM'));
process.on('SIGINT', () => shutdownWorker('SIGINT'));

logger.info('Webhook background worker started');