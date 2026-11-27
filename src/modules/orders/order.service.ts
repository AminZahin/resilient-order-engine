import crypto from 'node:crypto';
import { pool } from '../../shared/db.js';
import { webhookQueue } from '../../shared/queue.js';
import { logger } from '../../shared/logger.js';

export interface CreateOrderInput {
  itemId: string;
  quantity: number;
  amount: number;
  webhookUrl: string;
}

export interface OrderRecord {
  id: string;
  itemId: string;
  quantity: number;
  amount: string;
  webhookUrl: string;
  status: string;
  createdAt: string;
}

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export async function createOrderAtomic(input: CreateOrderInput): Promise<OrderRecord> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const stockRes = await client.query<{ stock: number; name: string }>(
      'SELECT stock, name FROM inventory WHERE item_id = $1 FOR UPDATE',
      [input.itemId]
    );

    const item = stockRes.rows[0];
    if (!item) {
      throw new AppError(404, `Item '${input.itemId}' not found`);
    }

    if (item.stock < input.quantity) {
      throw new AppError(409, `Insufficient stock for ${item.name}. Available: ${item.stock}`);
    }

    await client.query('UPDATE inventory SET stock = stock - $1 WHERE item_id = $2', [
      input.quantity,
      input.itemId,
    ]);

    const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`;
    const orderRes = await client.query<OrderRecord>(
      `INSERT INTO orders (id, item_id, quantity, amount, webhook_url, status)
       VALUES ($1, $2, $3, $4, $5, 'ACCEPTED')
       RETURNING
         id,
         item_id AS "itemId",
         quantity,
         amount,
         webhook_url AS "webhookUrl",
         status,
         created_at AS "createdAt"`,
      [orderId, input.itemId, input.quantity, input.amount, input.webhookUrl]
    );

    await client.query('COMMIT');

    const createdOrder = orderRes.rows[0];
    if (!createdOrder) {
      throw new AppError(500, 'Order insert returned no row');
    }

    logger.info(
      { orderId, itemId: input.itemId, quantity: input.quantity },
      'Order committed to PostgreSQL'
    );

    await webhookQueue.add('deliver-webhook', createdOrder, {
      attempts: 4,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: false, // Retained in failed set (DLQ inspection)
    });

    return createdOrder;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}