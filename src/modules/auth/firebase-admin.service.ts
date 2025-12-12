import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import admin from 'firebase-admin';

@Injectable()
export class FirebaseAdminService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseAdminService.name);
  private app: admin.app.App;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const projectId = this.configService.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.configService.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKey = this.configService.get<string>('FIREBASE_PRIVATE_KEY');

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn(
        'Firebase Admin SDK credentials not fully configured. Authentication will not work.',
      );
      return;
    }

    try {
      this.app = admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, '\n'),
        }),
      });
      this.logger.log('Firebase Admin SDK initialized successfully');
    } catch (error) {
      if (error.code === 'app/duplicate-app') {
        this.app = admin.app();
        this.logger.log('Firebase Admin SDK already initialized');
      } else {
        this.logger.error('Failed to initialize Firebase Admin SDK', error);
        throw error;
      }
    }
  }

  async verifyToken(token: string): Promise<admin.auth.DecodedIdToken> {
    if (!this.app) {
      throw new Error('Firebase Admin SDK not initialized');
    }
    return this.app.auth().verifyIdToken(token);
  }

  async getUser(uid: string): Promise<admin.auth.UserRecord> {
    if (!this.app) {
      throw new Error('Firebase Admin SDK not initialized');
    }
    return this.app.auth().getUser(uid);
  }
}
