import type { NextFunction, Request, Response } from 'express';
import { redis } from '../queue.js';
import { logger } from '../logger.js';

const IDEMPOTENCY_TTL_SECONDS = 86400; // 24 hours

export async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
  const key = req.header('Idempotency-Key');

  if (!key) {
    return res.status(400).json({ error: 'Missing required Idempotency-Key header' });
  }

  const cacheKey = `idem:response:${key}`;
  const lockKey = `idem:lock:${key}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.info({ idempotencyKey: key }, 'Duplicate request blocked — returning cached response');
      res.setHeader('X-Idempotent-Replay', 'true');
      return res.status(200).json(JSON.parse(cached));
    }

    const acquired = await redis.set(lockKey, 'PROCESSING', 'EX', 30, 'NX');
    if (!acquired) {
      return res.status(409).json({
        error: 'A request with this Idempotency-Key is currently in progress. Please retry shortly.',
      });
    }

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        redis
          .set(cacheKey, JSON.stringify(body), 'EX', IDEMPOTENCY_TTL_SECONDS)
          .catch((err) => logger.error({ err }, 'Failed to cache idempotency response'));
      }
      redis.del(lockKey).catch(() => {});
      return originalJson(body);
    };

    next();
  } catch (err) {
    logger.error({ err }, 'Idempotency middleware error');
    next(err);
  }
}