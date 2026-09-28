import { Router, type IRouter } from "express";
import healthRouter from "./health";
import maintenanceRouter from "./maintenance";

const router: IRouter = Router();

router.use(healthRouter);
router.use(maintenanceRouter);

export default router;
