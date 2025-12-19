import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AdminUserData {
  uid: string;
  email: string;
  name?: string;
}

export const AdminUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): AdminUserData => {
    const request = ctx.switchToHttp().getRequest();
    return request.adminUser;
  },
);
