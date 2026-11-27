import { Readable } from 'node:stream';
import type { Response } from 'express';
import { pool } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';

interface OrderCsvRow {
  id: string;
  item_id: string;
  quantity: number;
  amount: string;
  status: string;
  created_at: Date;
}

function escapeCsv(value: unknown): string {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function streamOrdersCsv(res: Response): Promise<void> {
  const batchSize = 500;
  let offset = 0;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="orders-export.csv"');

  const csvStream = new Readable({
    async read() {
      try {
        if (offset === 0) {
          this.push('id,item_id,quantity,amount,status,created_at\n');
        }

        const result = await pool.query<OrderCsvRow>(
          `SELECT id, item_id, quantity, amount, status, created_at
           FROM orders
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
          [batchSize, offset]
        );

        if (result.rows.length === 0) {
          this.push(null); // End stream
          return;
        }

        for (const row of result.rows) {
          const line =
            [
              escapeCsv(row.id),
              escapeCsv(row.item_id),
              escapeCsv(row.quantity),
              escapeCsv(row.amount),
              escapeCsv(row.status),
              escapeCsv(new Date(row.created_at).toISOString()),
            ].join(',') + '\n';
          this.push(line);
        }

        offset += result.rows.length;
      } catch (err) {
        logger.error({ err }, 'Error while streaming orders CSV');
        this.destroy(err instanceof Error ? err : new Error('CSV stream failed'));
      }
    },
  });

  csvStream.on('error', (err) => {
    logger.error({ err }, 'CSV stream error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to export CSV' });
    } else {
      res.end();
    }
  });

  csvStream.pipe(res);
}