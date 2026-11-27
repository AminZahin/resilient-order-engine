import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from './config/env.js';
import { logger } from './shared/logger.js';
import { pool } from './shared/db.js';
import { redis, webhookQueue } from './shared/queue.js';
import { idempotencyMiddleware } from './shared/middleware/idempotency.js';
import { AppError, createOrderAtomic } from './modules/orders/order.service.js';
import { streamOrdersCsv } from './modules/orders/order.export.js';

const app = express();
app.use(express.json());

app.get('/health', async (_req, res) => {
  await pool.query('SELECT 1');
  await redis.ping();
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const CreateOrderSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().int().positive().max(100),
  amount: z.number().positive(),
  webhookUrl: z.string().url(),
});

app.post(
  '/orders',
  idempotencyMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CreateOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'Validation failed', details: parsed.error.flatten() });
      }

      const order = await createOrderAtomic(parsed.data);
      return res.status(202).json(order);
    } catch (err) {
      next(err);
    }
  }
);

app.get('/orders/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await streamOrdersCsv(res);
  } catch (err) {
    next(err);
  }
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  logger.error({ err }, 'Unhandled API error');
  return res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(env.PORT, () => {
  logger.info(`API Gatekeeper listening on http://localhost:${env.PORT}`);
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutdown signal received — draining connections...');
  server.close(async () => {
    await webhookQueue.close();
    await redis.quit();
    await pool.end();
    logger.info('All connections closed cleanly. Exiting.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));