import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { FirebaseUser } from '../decorators/current-user.decorator.js';

interface ThrottlerRequest {
  user?: FirebaseUser;
  params?: { jobId?: string; batchId?: string };
  ip?: string;
}

// Detras del rewrite server-side de Vercel, todas las requests llegan desde
// las mismas IPs de edge lambdas, asi que la cuota por IP se llena con
// trafico ajeno. Priorizamos identidades estables presentes en la request.
//
// Nota: el storage in-memory de @nestjs/throttler (ThrottlerStorageService)
// nunca elimina keys del Map interno — solo expira sus contadores. Con
// jobId/batchId (UUIDs) como tracker, la cardinalidad crece con cada job
// nuevo. En Cloud Run el reciclo de contenedores lo mitiga; si el volumen
// sube significativamente, migrar a Redis storage o LRU custom.
@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: ThrottlerRequest): Promise<string> {
    if (req.user?.uid) return `user:${req.user.uid}`;
    if (req.params?.jobId) return `job:${req.params.jobId}`;
    if (req.params?.batchId) return `batch:${req.params.batchId}`;
    return `ip:${req.ip ?? 'anonymous'}`;
  }
}
