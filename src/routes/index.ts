import { Router, type Request, type Response } from "express";

const router = Router();

router.get("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "success",
    message: "Server is healthy and routes are working!",
  });
});

export default router;
