import * as admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../utils/logger';

let db: Firestore | null = null;

/**
 * Initializes Firebase Admin SDK and Firestore.
 *
 * Credential resolution order:
 *  1. FIREBASE_SERVICE_ACCOUNT env var — a JSON string of the service account key.
 *  2. GOOGLE_APPLICATION_CREDENTIALS env var — file path to the service account key.
 *  3. Application Default Credentials (ADC) — works automatically on GCP / Firebase Hosting.
 *
 * Call this once at server startup before any repository is used.
 */
export function initFirestore(): void {
  if (admin.apps.length > 0) {
    db = admin.firestore();
    return;
  }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountJson) {
    try {
      const serviceAccount = JSON.parse(serviceAccountJson) as admin.ServiceAccount;
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      logger.info('Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT env var.');
    } catch {
      logger.error('Failed to parse FIREBASE_SERVICE_ACCOUNT — must be a valid JSON string.');
      return;
    }
  } else {
    // Falls back to GOOGLE_APPLICATION_CREDENTIALS file path or ADC.
    try {
      admin.initializeApp();
      logger.info('Firebase Admin initialized via GOOGLE_APPLICATION_CREDENTIALS / ADC.');
    } catch (err) {
      logger.error('Firebase Admin initialization failed. Set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS.');
      logger.error(String(err));
      return;
    }
  }

  db = admin.firestore();
}

/** Returns the initialized Firestore instance, or null if not yet initialized. */
export function getFirestore(): Firestore | null {
  return db;
}
