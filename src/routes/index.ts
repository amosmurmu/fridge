import { Router, type Request, type Response } from "express";
// import { userRouter } from './user.routes';
// import { productRouter } from './product.routes';

const router = Router();

router.get("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "success",
    message: "Server is healthy and routes are working!",
  });
});

// router.use('/users', userRouter);
// router.use('/products', productRouter);

export default router;
