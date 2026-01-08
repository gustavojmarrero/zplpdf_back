function _ts_decorate(decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for(var i = decorators.length - 1; i >= 0; i--)if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
}
function _ts_metadata(k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
}
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsNumber, Min, Max, IsEnum, IsDateString, IsNotEmpty, MaxLength } from "class-validator";
import { Type } from "class-transformer";
export class GetUsersQueryDto {
    constructor(){
        this.page = 1;
        this.limit = 50;
        this.sortBy = 'createdAt';
        this.sortOrder = 'desc';
    }
}
_ts_decorate([
    ApiPropertyOptional({
        default: 1
    }),
    IsOptional(),
    Type(()=>Number),
    IsNumber(),
    Min(1),
    _ts_metadata("design:type", Number)
], GetUsersQueryDto.prototype, "page", void 0);
_ts_decorate([
    ApiPropertyOptional({
        default: 50,
        maximum: 100
    }),
    IsOptional(),
    Type(()=>Number),
    IsNumber(),
    Min(1),
    Max(100),
    _ts_metadata("design:type", Number)
], GetUsersQueryDto.prototype, "limit", void 0);
_ts_decorate([
    ApiPropertyOptional({
        enum: [
            'free',
            'pro',
            'enterprise'
        ]
    }),
    IsOptional(),
    IsString(),
    _ts_metadata("design:type", String)
], GetUsersQueryDto.prototype, "plan", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'Search by email or name'
    }),
    IsOptional(),
    IsString(),
    _ts_metadata("design:type", String)
], GetUsersQueryDto.prototype, "search", void 0);
_ts_decorate([
    ApiPropertyOptional({
        enum: [
            'createdAt',
            'lastActiveAt',
            'pdfCount'
        ],
        default: 'createdAt'
    }),
    IsOptional(),
    IsString(),
    _ts_metadata("design:type", String)
], GetUsersQueryDto.prototype, "sortBy", void 0);
_ts_decorate([
    ApiPropertyOptional({
        enum: [
            'asc',
            'desc'
        ],
        default: 'desc'
    }),
    IsOptional(),
    IsEnum([
        'asc',
        'desc'
    ]),
    _ts_metadata("design:type", String)
], GetUsersQueryDto.prototype, "sortOrder", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'Filter by registration date from (ISO 8601)'
    }),
    IsOptional(),
    IsDateString(),
    _ts_metadata("design:type", String)
], GetUsersQueryDto.prototype, "dateFrom", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'Filter by registration date to (ISO 8601)'
    }),
    IsOptional(),
    IsDateString(),
    _ts_metadata("design:type", String)
], GetUsersQueryDto.prototype, "dateTo", void 0);
let UserUsageDto = class UserUsageDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], UserUsageDto.prototype, "pdfCount", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], UserUsageDto.prototype, "labelCount", void 0);
let AdminUserDto = class AdminUserDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], AdminUserDto.prototype, "id", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], AdminUserDto.prototype, "email", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", String)
], AdminUserDto.prototype, "displayName", void 0);
_ts_decorate([
    ApiProperty({
        enum: [
            'free',
            'pro',
            'enterprise'
        ]
    }),
    _ts_metadata("design:type", String)
], AdminUserDto.prototype, "plan", void 0);
_ts_decorate([
    ApiProperty({
        type: UserUsageDto
    }),
    _ts_metadata("design:type", typeof UserUsageDto === "undefined" ? Object : UserUsageDto)
], AdminUserDto.prototype, "usage", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", typeof Date === "undefined" ? Object : Date)
], AdminUserDto.prototype, "createdAt", void 0);
_ts_decorate([
    ApiProperty({
        required: false
    }),
    _ts_metadata("design:type", typeof Date === "undefined" ? Object : Date)
], AdminUserDto.prototype, "lastActiveAt", void 0);
let PaginationDto = class PaginationDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], PaginationDto.prototype, "page", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], PaginationDto.prototype, "limit", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], PaginationDto.prototype, "total", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Number)
], PaginationDto.prototype, "totalPages", void 0);
let AdminUsersDataDto = class AdminUsersDataDto {
};
_ts_decorate([
    ApiProperty({
        type: [
            AdminUserDto
        ]
    }),
    _ts_metadata("design:type", Array)
], AdminUsersDataDto.prototype, "users", void 0);
_ts_decorate([
    ApiProperty({
        type: PaginationDto
    }),
    _ts_metadata("design:type", typeof PaginationDto === "undefined" ? Object : PaginationDto)
], AdminUsersDataDto.prototype, "pagination", void 0);
export class AdminUsersResponseDto {
}
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Boolean)
], AdminUsersResponseDto.prototype, "success", void 0);
_ts_decorate([
    ApiProperty({
        type: AdminUsersDataDto
    }),
    _ts_metadata("design:type", typeof AdminUsersDataDto === "undefined" ? Object : AdminUsersDataDto)
], AdminUsersResponseDto.prototype, "data", void 0);
// ==================== User Detail DTOs ====================
let UserUsageDetailDto = class UserUsageDetailDto {
};
_ts_decorate([
    ApiProperty({
        description: 'PDFs generated in current period'
    }),
    _ts_metadata("design:type", Number)
], UserUsageDetailDto.prototype, "pdfCount", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Labels generated in current period'
    }),
    _ts_metadata("design:type", Number)
], UserUsageDetailDto.prototype, "labelCount", void 0);
_ts_decorate([
    ApiProperty({
        description: 'PDF limit for the plan'
    }),
    _ts_metadata("design:type", Number)
], UserUsageDetailDto.prototype, "pdfLimit", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Percentage of limit used'
    }),
    _ts_metadata("design:type", Number)
], UserUsageDetailDto.prototype, "percentUsed", void 0);
let UsageHistoryItemDto = class UsageHistoryItemDto {
};
_ts_decorate([
    ApiProperty({
        description: 'Date (YYYY-MM-DD)'
    }),
    _ts_metadata("design:type", String)
], UsageHistoryItemDto.prototype, "date", void 0);
_ts_decorate([
    ApiProperty({
        description: 'PDFs generated that day'
    }),
    _ts_metadata("design:type", Number)
], UsageHistoryItemDto.prototype, "pdfs", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Labels generated that day'
    }),
    _ts_metadata("design:type", Number)
], UsageHistoryItemDto.prototype, "labels", void 0);
let SubscriptionInfoDto = class SubscriptionInfoDto {
};
_ts_decorate([
    ApiProperty({
        description: 'Subscription status',
        enum: [
            'active',
            'canceled',
            'past_due',
            'unpaid',
            'trialing',
            'incomplete'
        ]
    }),
    _ts_metadata("design:type", String)
], SubscriptionInfoDto.prototype, "status", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Current period start date'
    }),
    _ts_metadata("design:type", String)
], SubscriptionInfoDto.prototype, "currentPeriodStart", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Current period end date'
    }),
    _ts_metadata("design:type", String)
], SubscriptionInfoDto.prototype, "currentPeriodEnd", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'Stripe customer ID'
    }),
    _ts_metadata("design:type", String)
], SubscriptionInfoDto.prototype, "stripeCustomerId", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'Will cancel at period end'
    }),
    _ts_metadata("design:type", Boolean)
], SubscriptionInfoDto.prototype, "cancelAtPeriodEnd", void 0);
let UserDetailDataDto = class UserDetailDataDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], UserDetailDataDto.prototype, "id", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], UserDetailDataDto.prototype, "email", void 0);
_ts_decorate([
    ApiPropertyOptional(),
    _ts_metadata("design:type", String)
], UserDetailDataDto.prototype, "displayName", void 0);
_ts_decorate([
    ApiProperty({
        enum: [
            'free',
            'pro',
            'enterprise'
        ]
    }),
    _ts_metadata("design:type", String)
], UserDetailDataDto.prototype, "plan", void 0);
_ts_decorate([
    ApiProperty({
        type: UserUsageDetailDto
    }),
    _ts_metadata("design:type", typeof UserUsageDetailDto === "undefined" ? Object : UserUsageDetailDto)
], UserDetailDataDto.prototype, "usage", void 0);
_ts_decorate([
    ApiProperty({
        type: [
            UsageHistoryItemDto
        ],
        description: 'Usage history for the last 30 days'
    }),
    _ts_metadata("design:type", Array)
], UserDetailDataDto.prototype, "usageHistory", void 0);
_ts_decorate([
    ApiPropertyOptional({
        type: SubscriptionInfoDto
    }),
    _ts_metadata("design:type", typeof SubscriptionInfoDto === "undefined" ? Object : SubscriptionInfoDto)
], UserDetailDataDto.prototype, "subscription", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], UserDetailDataDto.prototype, "createdAt", void 0);
_ts_decorate([
    ApiPropertyOptional(),
    _ts_metadata("design:type", String)
], UserDetailDataDto.prototype, "lastActiveAt", void 0);
export class AdminUserDetailResponseDto {
}
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Boolean)
], AdminUserDetailResponseDto.prototype, "success", void 0);
_ts_decorate([
    ApiProperty({
        type: UserDetailDataDto
    }),
    _ts_metadata("design:type", typeof UserDetailDataDto === "undefined" ? Object : UserDetailDataDto)
], AdminUserDetailResponseDto.prototype, "data", void 0);
// ==================== Update Plan DTOs ====================
export class UpdateUserPlanDto {
}
_ts_decorate([
    ApiProperty({
        enum: [
            'free',
            'pro',
            'enterprise'
        ],
        description: 'New plan to assign'
    }),
    IsEnum([
        'free',
        'pro',
        'enterprise'
    ], {
        message: 'Plan must be: free, pro, or enterprise'
    }),
    IsNotEmpty(),
    _ts_metadata("design:type", String)
], UpdateUserPlanDto.prototype, "newPlan", void 0);
_ts_decorate([
    ApiProperty({
        description: 'Reason for the plan change',
        maxLength: 500
    }),
    IsString(),
    IsNotEmpty(),
    MaxLength(500),
    _ts_metadata("design:type", String)
], UpdateUserPlanDto.prototype, "reason", void 0);
let UpdatePlanResultDto = class UpdatePlanResultDto {
};
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], UpdatePlanResultDto.prototype, "userId", void 0);
_ts_decorate([
    ApiProperty({
        enum: [
            'free',
            'pro',
            'enterprise'
        ]
    }),
    _ts_metadata("design:type", String)
], UpdatePlanResultDto.prototype, "previousPlan", void 0);
_ts_decorate([
    ApiProperty({
        enum: [
            'free',
            'pro',
            'enterprise'
        ]
    }),
    _ts_metadata("design:type", String)
], UpdatePlanResultDto.prototype, "newPlan", void 0);
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", String)
], UpdatePlanResultDto.prototype, "effectiveAt", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'Whether Stripe subscription was canceled'
    }),
    _ts_metadata("design:type", Boolean)
], UpdatePlanResultDto.prototype, "stripeCanceled", void 0);
_ts_decorate([
    ApiPropertyOptional({
        description: 'Warnings during the process',
        type: [
            String
        ]
    }),
    _ts_metadata("design:type", Array)
], UpdatePlanResultDto.prototype, "warnings", void 0);
export class UpdateUserPlanResponseDto {
}
_ts_decorate([
    ApiProperty(),
    _ts_metadata("design:type", Boolean)
], UpdateUserPlanResponseDto.prototype, "success", void 0);
_ts_decorate([
    ApiProperty({
        type: UpdatePlanResultDto
    }),
    _ts_metadata("design:type", typeof UpdatePlanResultDto === "undefined" ? Object : UpdatePlanResultDto)
], UpdateUserPlanResponseDto.prototype, "data", void 0);

//# sourceMappingURL=admin-users.dto.js.map