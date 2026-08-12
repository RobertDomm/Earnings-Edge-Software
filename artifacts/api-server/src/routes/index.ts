import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import marketRouter from "./market";
import { createScannerRouter } from "./scanner.js";
import stocksRouter from "./stocks";
import { createScreenerRouter } from "./screener";
import { marketDataProvider } from "../services";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(marketRouter);
router.use(createScannerRouter());
router.use(stocksRouter);
router.use(createScreenerRouter(marketDataProvider));

export default router;
