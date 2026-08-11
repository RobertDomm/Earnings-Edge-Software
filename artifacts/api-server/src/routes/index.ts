import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import marketRouter from "./market";
import scannerRouter from "./scanner";
import stocksRouter from "./stocks";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(marketRouter);
router.use(scannerRouter);
router.use(stocksRouter);

export default router;
