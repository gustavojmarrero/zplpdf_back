import { IsEnum, IsOptional, IsNumber, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SimulatePlanDto {
  @ApiProperty({
    description: 'Plan a simular',
    enum: ['free', 'pro', 'promax', 'enterprise'],
    example: 'free',
  })
  @IsEnum(['free', 'pro', 'promax', 'enterprise'])
  plan: 'free' | 'pro' | 'promax' | 'enterprise';

  @ApiPropertyOptional({
    description: 'Duración de la simulación en horas (default: 24)',
    example: 24,
    minimum: 1,
    maximum: 168,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(168) // Máximo 7 días
  durationHours?: number;
}

export class StopSimulationDto {
  // No requiere campos, solo detiene la simulación activa
}

export class SimulationStatusResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  data: {
    isSimulating: boolean;
    simulatedPlan?: 'free' | 'pro' | 'promax' | 'enterprise';
    simulationExpiresAt?: string;
    originalPlan: 'free' | 'pro' | 'promax' | 'enterprise';
    role: 'user' | 'admin';
  };
}

export class SimulatePlanResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  data: {
    simulatedPlan: 'free' | 'pro' | 'promax' | 'enterprise';
    simulationExpiresAt: string;
    message: string;
  };
}

export class StopSimulationResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  data: {
    message: string;
    originalPlan: 'free' | 'pro' | 'promax' | 'enterprise';
  };
}
