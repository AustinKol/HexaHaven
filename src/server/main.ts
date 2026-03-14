import { buildServer } from './createServer';
import { ServerEnv } from './config/env';
import { initFirestore } from './config/firebaseAdmin';
import { logger } from './utils/logger';

// Initialize Firestore before the server starts accepting requests.
initFirestore();

const { httpServer } = buildServer();

httpServer.listen(ServerEnv.port, () => {
  logger.info(`Server listening on port ${ServerEnv.port}`);
});
