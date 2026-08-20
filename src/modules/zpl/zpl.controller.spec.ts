// Mockear dependencias pesadas/nativas que la cadena de imports del controller
// arrastra (zpl.service y firebase-admin) pero que estos tests no ejercitan.
jest.mock('sharp', () => jest.fn());
jest.mock('pdf-to-png-converter', () => ({ pdfToPng: jest.fn() }));
jest.mock('pdf-merger-js', () => jest.fn());
jest.mock('archiver', () => jest.fn());
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({
      exists: jest.fn().mockResolvedValue([true]),
      file: jest.fn(),
    }),
  })),
}));
jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  auth: jest.fn(),
}));

import { HttpException, HttpStatus } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import {
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants.js';
import { ZplController } from './zpl.controller.js';
import { LabelSize } from './enums/label-size.enum.js';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  PublicPreviewDto,
  PUBLIC_PREVIEW_MAX_UNIQUE_LABELS,
  PUBLIC_PREVIEW_MAX_ZPL_LENGTH,
} from './dto/public-preview.dto.js';
import { ErrorCodes } from '../../common/constants/error-codes.js';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard.js';

const ZPL_VALIDO = '^XA^FO20,20^FDHola^FS^XZ';

const buildController = () => {
  const getLabelsPreview = jest
    .fn()
    .mockResolvedValue([{ img: 'data:image/png;base64,AAA', qty: 1 }]);
  const zplService: any = { getLabelsPreview };
  const controller = new ZplController(zplService, {} as any);
  return { controller, getLabelsPreview };
};

const dto = (overrides: Partial<PublicPreviewDto> = {}): PublicPreviewDto =>
  Object.assign(new PublicPreviewDto(), { zplContent: ZPL_VALIDO }, overrides);

describe('ZplController — POST /zpl/public-preview (issue #108)', () => {
  it('responde con la misma forma que /zpl/preview', async () => {
    const { controller } = buildController();

    const res = await controller.publicPreview(dto());

    expect(res).toEqual({
      success: true,
      message: 'Vista previa generada correctamente',
      data: [{ img: 'data:image/png;base64,AAA', qty: 1 }],
    });
  });

  it('acota el render a las primeras etiquetas únicas', async () => {
    const { controller, getLabelsPreview } = buildController();

    await controller.publicPreview(dto());

    expect(getLabelsPreview).toHaveBeenCalledWith(
      ZPL_VALIDO,
      LabelSize.TWO_BY_ONE,
      { maxUniqueLabels: PUBLIC_PREVIEW_MAX_UNIQUE_LABELS },
    );
    expect(PUBLIC_PREVIEW_MAX_UNIQUE_LABELS).toBeLessThanOrEqual(2);
  });

  it('respeta el labelSize recibido', async () => {
    const { controller, getLabelsPreview } = buildController();

    await controller.publicPreview(dto({ labelSize: LabelSize.FOUR_BY_SIX }));

    expect(getLabelsPreview).toHaveBeenCalledWith(
      ZPL_VALIDO,
      LabelSize.FOUR_BY_SIX,
      expect.anything(),
    );
  });

  it('rechaza con 400 INVALID_ZPL si falta ^XA/^XZ, sin tocar Labelary', async () => {
    const { controller, getLabelsPreview } = buildController();

    await expect(
      controller.publicPreview(dto({ zplContent: 'esto no es ZPL' })),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      response: { error: ErrorCodes.INVALID_ZPL },
    });
    expect(getLabelsPreview).not.toHaveBeenCalled();
  });

  it('rechaza contenido vacío', async () => {
    const { controller } = buildController();

    await expect(
      controller.publicPreview(dto({ zplContent: '' })),
    ).rejects.toBeInstanceOf(HttpException);
  });

  // El tope de tamaño lo aplica el ValidationPipe global antes de llegar al
  // handler, así que se comprueba sobre el DTO.
  describe('límite de tamaño del zplContent', () => {
    it('acepta un ZPL dentro del tope', async () => {
      const errors = await validate(
        plainToInstance(PublicPreviewDto, {
          zplContent:
            '^XA' + 'X'.repeat(PUBLIC_PREVIEW_MAX_ZPL_LENGTH - 6) + '^XZ',
        }),
      );

      expect(errors).toHaveLength(0);
    });

    it('rechaza un ZPL que se pasa del tope', async () => {
      const errors = await validate(
        plainToInstance(PublicPreviewDto, {
          zplContent: 'X'.repeat(PUBLIC_PREVIEW_MAX_ZPL_LENGTH + 1),
        }),
      );

      expect(errors[0].constraints).toHaveProperty('maxLength');
    });

    it('rechaza un labelSize desconocido', async () => {
      const errors = await validate(
        plainToInstance(PublicPreviewDto, {
          zplContent: ZPL_VALIDO,
          labelSize: '9x9',
        }),
      );

      expect(errors[0].constraints).toHaveProperty('isEnum');
    });
  });

  describe('metadatos de la ruta', () => {
    const publicPreview = ZplController.prototype.publicPreview;

    it('no lleva guard de autenticación', () => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, publicPreview),
      ).toBeUndefined();
    });

    it('lleva rate limit por IP por minuto y por hora', () => {
      expect(
        Reflect.getMetadata(THROTTLER_LIMIT + 'default', publicPreview),
      ).toBe(10);
      expect(
        Reflect.getMetadata(THROTTLER_TTL + 'default', publicPreview),
      ).toBe(60000);
      expect(
        Reflect.getMetadata(THROTTLER_LIMIT + 'hourly', publicPreview),
      ).toBe(30);
      expect(Reflect.getMetadata(THROTTLER_TTL + 'hourly', publicPreview)).toBe(
        3600000,
      );
    });
  });

  // El endpoint público es uno nuevo a propósito: el de siempre no debe heredar
  // ni el guard menos ni el rate limit por IP de más.
  describe('POST /zpl/preview no cambia', () => {
    const previewZpl = ZplController.prototype.previewZpl;

    it('sigue exigiendo FirebaseAuthGuard', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, previewZpl)).toContain(
        FirebaseAuthGuard,
      );
    });

    it('sigue sin rate limit propio', () => {
      expect(
        Reflect.getMetadata(THROTTLER_LIMIT + 'default', previewZpl),
      ).toBeUndefined();
      expect(
        Reflect.getMetadata(THROTTLER_LIMIT + 'hourly', previewZpl),
      ).toBeUndefined();
    });
  });
});
