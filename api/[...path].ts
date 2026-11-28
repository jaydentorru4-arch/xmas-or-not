import type { Express, Request, Response } from 'express';
import { createApp } from '../server';

// Cache the Express application for the lifetime of a warm serverless instance.
// All /api/* endpoints continue to use the same existing route handlers.
let appPromise: Promise<Express> | null = null;

export default async function handler(req: Request, res: Response): Promise<void> {
  try {
    appPromise ??= createApp();
    const app = await appPromise;
    app(req, res);
  } catch (error) {
    console.error('Failed to initialize the API server:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'The API server could not be initialized.' });
    } else {
      res.end();
    }
  }
}
