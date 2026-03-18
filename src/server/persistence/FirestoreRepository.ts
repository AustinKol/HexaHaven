import type { Firestore } from 'firebase-admin/firestore';
import { getFirestore } from '../config/firebaseAdmin';

/**
 * Base class for all Firestore repositories.
 * Provides a `db` getter that throws if Firestore was never initialized.
 */
export class FirestoreRepository {
  protected get db(): Firestore {
    const db = getFirestore();
    if (!db) {
      throw new Error('Firestore is not initialized. Call initFirestore() at server startup.');
    }
    return db;
  }
}
