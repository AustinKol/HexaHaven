import { Router } from 'express';
import healthRouter from './routes/health';

const rootRouter = Router();
rootRouter.use(healthRouter);

export default rootRouter;
