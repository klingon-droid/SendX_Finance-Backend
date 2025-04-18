import { Request, Response } from 'express';
export declare function getUserBalance(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
export declare function updateUserBalance(req: Request, res: Response): Promise<Response<any, Record<string, any>>>;
