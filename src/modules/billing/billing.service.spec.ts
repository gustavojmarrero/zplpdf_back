// Evitar la conexión real a Stripe al cargar el módulo.
jest.mock('stripe', () => jest.fn());

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BillingService } from './billing.service.js';
import type { UpdateTaxProfileDto } from './dto/tax-profile.dto.js';
import { CfdiErrorCodes } from '../facturama/facturama.constants.js';
import { FacturamaError } from '../facturama/interfaces/facturama.interface.js';

/**
 * El perfil fiscal es la entrada de datos que después se timbra ante el SAT.
 * Un régimen incompatible con el tipo de persona, o un uso de CFDI que solo
 * aplica a personas físicas, no fallan al guardar: fallan un mes más tarde, al
 * emitir el CFDI, cuando el cobro ya se hizo y el plazo fiscal corre.
 *
 * Por eso la validación es del backend aunque el frontend ya filtre los
 * catálogos: el catálogo del cliente es una ayuda de UX, no una garantía.
 */
describe('BillingService — perfil fiscal', () => {
  const RFC_MORAL = 'ABC010101AB1'; // 12 caracteres
  const RFC_FISICA = 'ABCD010101AB1'; // 13 caracteres

  /**
   * El constructor de BillingService abre la conexión con Stripe, que estos
   * tests no ejercitan. Se instancia por prototipo y se inyectan solo las
   * dependencias que toca cada método.
   */
  function buildService(overrides: {
    user?: Record<string, unknown> | null;
    profile?: Record<string, unknown> | null;
    customersUpdate?: jest.Mock;
    listTaxIds?: jest.Mock;
    createTaxId?: jest.Mock;
    deleteTaxId?: jest.Mock;
    withoutStripe?: boolean;
  }) {
    const saved: Record<string, unknown>[] = [];
    let storedProfile = overrides.profile ?? null;

    const firestoreService = {
      getUserById: jest
        .fn()
        .mockResolvedValue(
          overrides.user === undefined
            ? { id: 'uid-1', country: 'MX', stripeCustomerId: 'cus_123' }
            : overrides.user,
        ),
      getTaxProfile: jest.fn().mockImplementation(() => storedProfile),
      saveTaxProfile: jest
        .fn()
        .mockImplementation(
          (_userId: string, data: Record<string, unknown>) => {
            saved.push(data);
            storedProfile = {
              ...(storedProfile ?? {}),
              ...data,
              updatedAt: new Date('2026-08-04T12:00:00.000Z'),
            };
            return Promise.resolve();
          },
        ),
    };

    const stripe = overrides.withoutStripe
      ? undefined
      : {
          customers: {
            update:
              overrides.customersUpdate ?? jest.fn().mockResolvedValue({}),
            listTaxIds:
              overrides.listTaxIds ?? jest.fn().mockResolvedValue({ data: [] }),
            createTaxId:
              overrides.createTaxId ??
              jest.fn().mockResolvedValue({ id: 'txi_123' }),
            deleteTaxId:
              overrides.deleteTaxId ?? jest.fn().mockResolvedValue({}),
          },
        };

    const service = Object.create(BillingService.prototype) as BillingService;
    Object.assign(service, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      firestoreService,
      stripe,
    });

    return { service, firestoreService, stripe, saved };
  }

  function mxDto(overrides: Partial<UpdateTaxProfileDto> = {}) {
    return {
      type: 'mx',
      rfc: RFC_MORAL,
      legalName: 'EMPRESA DEMO',
      taxRegime: '601',
      postalCode: '97000',
      cfdiUse: 'G03',
      billingEmail: 'facturas@empresa.com',
      ...overrides,
    } as UpdateTaxProfileDto;
  }

  /** Extrae el mapa `errors` de la excepción, que es lo que pinta el frontend. */
  function fieldErrors(error: unknown): Record<string, string> {
    const response = (error as BadRequestException).getResponse() as {
      errors: Record<string, string>;
    };
    return response.errors;
  }

  async function expectFieldError(
    service: BillingService,
    dto: UpdateTaxProfileDto,
    field: string,
    code: string,
  ) {
    await expect(service.updateTaxProfile('uid-1', dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    try {
      await service.updateTaxProfile('uid-1', dto);
      throw new Error('Se esperaba un BadRequestException');
    } catch (error) {
      expect(fieldErrors(error)).toMatchObject({ [field]: code });
    }
  }

  describe('GET — nunca 404', () => {
    it('devuelve isComplete:false y el type derivado del país cuando no hay perfil', async () => {
      const { service } = buildService({ profile: null });

      const result = await service.getTaxProfile('uid-1');

      expect(result).toEqual({ type: 'mx', country: 'MX', isComplete: false });
    });

    it('trata como internacional al usuario sin país conocido', async () => {
      const { service } = buildService({
        user: { id: 'uid-1', country: undefined },
        profile: null,
      });

      const result = await service.getTaxProfile('uid-1');

      // Por defecto NO se timbra: es preferible una factura de Stripe de más que
      // un CFDI emitido a quien no lo necesita.
      expect(result.type).toBe('international');
    });

    it('pide recargar el perfil si el usuario cambió de país', async () => {
      const { service } = buildService({
        user: { id: 'uid-1', country: 'ES' },
        profile: { type: 'mx', rfc: RFC_MORAL, isComplete: true },
      });

      const result = await service.getTaxProfile('uid-1');

      expect(result).toEqual({
        type: 'international',
        country: 'ES',
        isComplete: false,
      });
      // El RFC guardado no debe filtrarse a un formulario internacional.
      expect(result).not.toHaveProperty('rfc');
    });
  });

  describe('PUT — validación de México', () => {
    it('rechaza un RFC con formato inválido', async () => {
      const { service } = buildService({});
      await expectFieldError(
        service,
        mxDto({ rfc: 'NO-ES-UN-RFC' }),
        'rfc',
        'rfc_invalid_format',
      );
    });

    it('rechaza el RFC genérico de público en general', async () => {
      const { service } = buildService({});
      // Tiene formato válido, pero una factura contra él no le sirve al usuario
      // para deducir: es siempre un error de captura.
      await expectFieldError(
        service,
        mxDto({ rfc: 'XAXX010101000', taxRegime: '616', cfdiUse: 'S01' }),
        'rfc',
        'rfc_generic_not_allowed',
      );
    });

    it('rechaza un régimen de persona moral en un RFC de persona física', async () => {
      const { service } = buildService({});
      // 601 es "General de Ley Personas Morales" y el RFC de 13 es de física.
      await expectFieldError(
        service,
        mxDto({ rfc: RFC_FISICA, taxRegime: '601' }),
        'taxRegime',
        'tax_regime_not_valid_for_person_type',
      );
    });

    it('rechaza un régimen de persona física en un RFC de persona moral', async () => {
      const { service } = buildService({});
      // 612 es "Personas Físicas con Actividades Empresariales".
      await expectFieldError(
        service,
        mxDto({ rfc: RFC_MORAL, taxRegime: '612' }),
        'taxRegime',
        'tax_regime_not_valid_for_person_type',
      );
    });

    it('distingue un régimen inexistente de uno que no aplica a la persona', async () => {
      const { service } = buildService({});
      // La acción del usuario es distinta en cada caso: elegir otro valor del
      // catálogo, o revisar el RFC que capturó.
      await expectFieldError(
        service,
        mxDto({ taxRegime: '999' }),
        'taxRegime',
        'tax_regime_unknown',
      );
    });

    it('rechaza un uso de CFDI inexistente en el catálogo', async () => {
      const { service } = buildService({});
      await expectFieldError(
        service,
        mxDto({ cfdiUse: 'ZZ99' }),
        'cfdiUse',
        'cfdi_use_unknown',
      );
    });

    it('rechaza un uso de CFDI deducible personal en una persona moral', async () => {
      const { service } = buildService({});
      // D10 (colegiaturas) solo lo puede usar una persona física.
      await expectFieldError(
        service,
        mxDto({ rfc: RFC_MORAL, cfdiUse: 'D10' }),
        'cfdiUse',
        'cfdi_use_not_valid_for_person_type',
      );
    });

    it('rechaza un código postal que no son 5 dígitos', async () => {
      const { service } = buildService({});
      await expectFieldError(
        service,
        mxDto({ postalCode: '9700' }),
        'postalCode',
        'postal_code_invalid',
      );
    });

    it('acepta el régimen 626 (RESICO) tanto en física como en moral', async () => {
      const { service } = buildService({});

      await expect(
        service.updateTaxProfile('uid-1', mxDto({ taxRegime: '626' })),
      ).resolves.toBeDefined();
      await expect(
        service.updateTaxProfile(
          'uid-1',
          mxDto({ rfc: RFC_FISICA, taxRegime: '626' }),
        ),
      ).resolves.toBeDefined();
    });

    it('rechaza el perfil cuyo type no coincide con el país del usuario', async () => {
      const { service } = buildService({
        user: { id: 'uid-1', country: 'ES' },
      });
      // Si el cliente pudiera elegir el type, un usuario mexicano se saltaría el
      // CFDI declarándose internacional.
      await expectFieldError(
        service,
        mxDto(),
        'type',
        'type_does_not_match_country',
      );
    });

    it('normaliza la razón social a mayúsculas y sin acentos', async () => {
      const { service, saved } = buildService({});

      await service.updateTaxProfile(
        'uid-1',
        mxDto({ legalName: '  Construcción   Peña  ' }),
      );

      // El SAT guarda la razón social en mayúsculas y sin acentos; normalizarla
      // evita un rechazo por una diferencia puramente ortográfica.
      expect(saved[0].legalName).toBe('CONSTRUCCION PENA');
    });

    it('invalida el cliente de Facturama cuando cambia el RFC', async () => {
      const { service, saved } = buildService({
        profile: {
          type: 'mx',
          rfc: 'XYZ010101AB1',
          facturamaClientId: 'client_viejo',
          isComplete: true,
        },
      });

      await service.updateTaxProfile('uid-1', mxDto({ rfc: RFC_MORAL }));

      // El cliente dado de alta en Facturama pertenece al RFC anterior.
      expect(saved[0].facturamaClientId).toBeNull();
    });
  });

  describe('PUT — validación internacional', () => {
    function intlDto(overrides: Partial<UpdateTaxProfileDto> = {}) {
      return {
        type: 'international',
        legalName: 'Acme S.L.',
        billingEmail: 'billing@acme.com',
        taxIdType: 'eu_vat',
        taxIdValue: 'ESB12345678',
        address: {
          line1: 'Calle Mayor 1',
          city: 'Madrid',
          postalCode: '28001',
          country: 'ES',
        },
        ...overrides,
      } as UpdateTaxProfileDto;
    }

    it('rechaza un tax ID con tipo pero sin valor', async () => {
      const { service } = buildService({
        user: { id: 'uid-1', country: 'ES' },
      });
      await expectFieldError(
        service,
        intlDto({ taxIdValue: null }),
        'taxIdValue',
        'tax_id_value_required',
      );
    });

    it('rechaza un tax ID con valor pero sin tipo', async () => {
      const { service } = buildService({
        user: { id: 'uid-1', country: 'ES' },
      });
      await expectFieldError(
        service,
        intlDto({ taxIdType: null }),
        'taxIdType',
        'tax_id_type_required',
      );
    });

    it('acepta un perfil sin tax ID', async () => {
      const { service } = buildService({
        user: { id: 'uid-1', country: 'ES' },
      });

      // No todos los países emiten un tax ID al consumidor final.
      await expect(
        service.updateTaxProfile(
          'uid-1',
          intlDto({ taxIdType: null, taxIdValue: null }),
        ),
      ).resolves.toBeDefined();
    });

    it('rechaza un país que no es ISO alpha-2', async () => {
      const { service } = buildService({
        user: { id: 'uid-1', country: 'ES' },
      });
      await expectFieldError(
        service,
        intlDto({
          address: {
            line1: 'Calle Mayor 1',
            city: 'Madrid',
            postalCode: '28001',
            country: 'ESP',
          },
        }),
        'address',
        'address_country_invalid',
      );
    });
  });

  describe('propagación a Stripe', () => {
    it('manda razón social, email y domicilio al customer', async () => {
      const customersUpdate = jest.fn().mockResolvedValue({});
      const { service } = buildService({
        user: { id: 'uid-1', country: 'ES', stripeCustomerId: 'cus_123' },
        customersUpdate,
      });

      await service.updateTaxProfile('uid-1', {
        type: 'international',
        legalName: 'Acme S.L.',
        billingEmail: 'billing@acme.com',
        taxIdType: 'eu_vat',
        taxIdValue: 'ESB12345678',
        address: {
          line1: 'Calle Mayor 1',
          city: 'Madrid',
          postalCode: '28001',
          country: 'ES',
        },
      } as UpdateTaxProfileDto);

      expect(customersUpdate).toHaveBeenCalledWith(
        'cus_123',
        expect.objectContaining({
          name: 'Acme S.L.',
          email: 'billing@acme.com',
          address: expect.objectContaining({
            line1: 'Calle Mayor 1',
            city: 'Madrid',
            postal_code: '28001',
            country: 'ES',
          }),
        }),
      );
    });

    it('registra el RFC como tax ID mx_rfc', async () => {
      const createTaxId = jest.fn().mockResolvedValue({ id: 'txi_123' });
      const { service } = buildService({ createTaxId });

      await service.updateTaxProfile('uid-1', mxDto());

      expect(createTaxId).toHaveBeenCalledWith('cus_123', {
        type: 'mx_rfc',
        value: RFC_MORAL,
      });
    });

    it('no duplica el tax ID si ya está registrado con el mismo valor', async () => {
      const createTaxId = jest.fn();
      const deleteTaxId = jest.fn();
      const { service } = buildService({
        listTaxIds: jest.fn().mockResolvedValue({
          data: [{ id: 'txi_existente', type: 'mx_rfc', value: RFC_MORAL }],
        }),
        createTaxId,
        deleteTaxId,
      });

      await service.updateTaxProfile('uid-1', mxDto());

      expect(createTaxId).not.toHaveBeenCalled();
      expect(deleteTaxId).not.toHaveBeenCalled();
    });

    it('borra el tax ID anterior cuando cambia el RFC', async () => {
      const deleteTaxId = jest.fn().mockResolvedValue({});
      const createTaxId = jest.fn().mockResolvedValue({ id: 'txi_nuevo' });
      const { service } = buildService({
        listTaxIds: jest.fn().mockResolvedValue({
          data: [{ id: 'txi_viejo', type: 'mx_rfc', value: 'XYZ010101AB1' }],
        }),
        deleteTaxId,
        createTaxId,
      });

      await service.updateTaxProfile('uid-1', mxDto());

      // Stripe no permite modificar un tax ID: si no se borra el anterior, el
      // PDF sale con dos.
      expect(deleteTaxId).toHaveBeenCalledWith('cus_123', 'txi_viejo');
      expect(createTaxId).toHaveBeenCalled();
    });

    it('guarda el perfil aunque Stripe falle', async () => {
      const { service, saved } = buildService({
        customersUpdate: jest.fn().mockRejectedValue(new Error('Stripe caído')),
      });

      // El dato que el usuario acaba de escribir no se pierde por un fallo en un
      // paso que solo afecta a cómo se imprime el PDF de Stripe.
      await expect(
        service.updateTaxProfile('uid-1', mxDto()),
      ).resolves.toBeDefined();
      expect(saved[0].isComplete).toBe(true);
    });

    it('no llama a Stripe si el usuario todavía no tiene customer', async () => {
      const customersUpdate = jest.fn();
      const { service } = buildService({
        user: { id: 'uid-1', country: 'MX', stripeCustomerId: undefined },
        customersUpdate,
      });

      await service.updateTaxProfile('uid-1', mxDto());

      // Se propagará al completarse el checkout, cuando el customer exista.
      expect(customersUpdate).not.toHaveBeenCalled();
    });

    it('syncTaxProfileToStripe no hace nada con un perfil incompleto', async () => {
      const customersUpdate = jest.fn();
      const { service } = buildService({
        profile: { type: 'mx', isComplete: false },
        customersUpdate,
      });

      await service.syncTaxProfileToStripe('uid-1');

      expect(customersUpdate).not.toHaveBeenCalled();
    });
  });

  /**
   * El reintento toca un documento fiscal ya emitido y por eso vigila dos
   * cosas: que la factura sea de quien la pide, y que no se timbre lo que ya
   * está timbrado —un CFDI duplicado solo se deshace cancelándolo ante el SAT.
   */
  describe('retryCfdi', () => {
    function buildRetryService(overrides: {
      user?: Record<string, unknown> | null;
      invoice?: Record<string, unknown>;
      retrieveError?: unknown;
      cfdi?: Record<string, unknown> | null;
      retry?: jest.Mock;
      profile?: Record<string, unknown> | null;
    }) {
      const retrieve = overrides.retrieveError
        ? jest.fn().mockRejectedValue(overrides.retrieveError)
        : jest
            .fn()
            .mockResolvedValue(
              overrides.invoice ?? { id: 'in_123', customer: 'cus_123' },
            );

      const service = Object.create(BillingService.prototype) as BillingService;
      Object.assign(service, {
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        stripe: { invoices: { retrieve } },
        firestoreService: {
          getUserById: jest
            .fn()
            .mockResolvedValue(
              overrides.user === undefined
                ? { id: 'uid-1', country: 'MX', stripeCustomerId: 'cus_123' }
                : overrides.user,
            ),
          getCfdiByInvoiceId: jest
            .fn()
            .mockResolvedValue(overrides.cfdi ?? null),
          getTaxProfile: jest
            .fn()
            .mockResolvedValue(
              overrides.profile === undefined
                ? { type: 'mx', isComplete: true }
                : overrides.profile,
            ),
        },
        storageService: {
          generateSignedUrlForPath: jest
            .fn()
            .mockResolvedValue('https://signed.example/file'),
        },
        cfdiService: {
          retry:
            overrides.retry ??
            jest.fn().mockResolvedValue({
              status: 'stamped',
              uuid: 'UUID-1',
              stampedAt: new Date('2026-08-04T12:00:00.000Z'),
              pdfPath: 'cfdis/uid-1/in_123.pdf',
              xmlPath: 'cfdis/uid-1/in_123.xml',
            }),
        },
      });

      return service;
    }

    it('403 si la factura es de otro cliente', async () => {
      const service = buildRetryService({
        invoice: { id: 'in_123', customer: 'cus_de_otro' },
      });

      await expect(service.retryCfdi('uid-1', 'in_123')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('403 si el usuario no tiene customer en Stripe', async () => {
      const service = buildRetryService({
        user: { id: 'uid-1', country: 'MX' },
      });

      await expect(service.retryCfdi('uid-1', 'in_123')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('404 si la factura no existe en Stripe', async () => {
      const service = buildRetryService({
        retrieveError: { code: 'resource_missing' },
      });

      await expect(service.retryCfdi('uid-1', 'in_123')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('400 si el CFDI ya está timbrado', async () => {
      const service = buildRetryService({
        cfdi: { status: 'stamped', uuid: 'UUID-1' },
      });

      // Reintentarlo emitiría un duplicado.
      await expect(service.retryCfdi('uid-1', 'in_123')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('400, no 422, si el perfil fiscal está incompleto', async () => {
      const service = buildRetryService({
        cfdi: { status: 'failed' },
        profile: null,
      });

      // Es una precondición que el usuario no ha cumplido, no un rechazo del
      // PAC: un 422 le diría que su RFC está mal cuando lo que falta es
      // cargarlo.
      await expect(service.retryCfdi('uid-1', 'in_123')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('422 con el mismo código estable cuando el PAC vuelve a rechazar', async () => {
      const service = buildRetryService({
        cfdi: { status: 'failed' },
        retry: jest
          .fn()
          .mockRejectedValue(
            new FacturamaError(CfdiErrorCodes.RFC_NOT_FOUND, 'RFC no inscrito'),
          ),
      });

      try {
        await service.retryCfdi('uid-1', 'in_123');
        throw new Error('Se esperaba un UnprocessableEntityException');
      } catch (error) {
        expect(error).toBeInstanceOf(UnprocessableEntityException);
        const body = (error as UnprocessableEntityException).getResponse() as {
          cfdiError: { code: string };
        };
        // El reintento fallido se explica con el mismo diccionario que el fallo
        // original.
        expect(body.cfdiError.code).toBe(CfdiErrorCodes.RFC_NOT_FOUND);
      }
    });

    it('devuelve el CFDI con URLs firmadas al timbrar bien', async () => {
      const service = buildRetryService({ cfdi: { status: 'failed' } });

      const result = await service.retryCfdi('uid-1', 'in_123');

      expect(result.status).toBe('stamped');
      expect(result.uuid).toBe('UUID-1');
      expect(result.pdfUrl).toBe('https://signed.example/file');
      expect(result.xmlUrl).toBe('https://signed.example/file');
    });

    it('permite reintentar cuando no hay registro previo de CFDI', async () => {
      const service = buildRetryService({ cfdi: null });

      // Una factura de antes de que el usuario cargara su perfil fiscal no tiene
      // documento, y debe poder facturarse.
      await expect(service.retryCfdi('uid-1', 'in_123')).resolves.toMatchObject(
        {
          status: 'stamped',
        },
      );
    });
  });

  /**
   * El listado de facturas es la pantalla donde el usuario descubre si tiene
   * factura o no, así que el estado que devuelve tiene que distinguir «no te
   * toca» de «falló».
   */
  describe('getInvoices — bloque cfdi', () => {
    function buildInvoicesService(overrides: {
      country?: string;
      cfdis?: Map<string, unknown>;
    }) {
      const service = Object.create(BillingService.prototype) as BillingService;
      Object.assign(service, {
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        stripe: {
          invoices: {
            list: jest.fn().mockResolvedValue({
              data: [{ id: 'in_1' }, { id: 'in_2' }],
              has_more: false,
            }),
          },
        },
        firestoreService: {
          getUserById: jest.fn().mockResolvedValue({
            id: 'uid-1',
            country: overrides.country ?? 'MX',
            stripeCustomerId: 'cus_123',
          }),
          getCfdisByInvoiceIds: jest
            .fn()
            .mockResolvedValue(overrides.cfdis ?? new Map()),
        },
        storageService: {
          generateSignedUrlForPath: jest
            .fn()
            .mockResolvedValue('https://signed.example/file'),
        },
      });

      return service;
    }

    it('devuelve cfdi null para un usuario no mexicano', async () => {
      const service = buildInvoicesService({ country: 'ES' });

      const { invoices } = await service.getInvoices('uid-1');

      // Es como el frontend sabe que no debe pintar la columna.
      expect(invoices.every((invoice) => invoice.cfdi === null)).toBe(true);
    });

    it('marca not_applicable una factura mexicana sin registro', async () => {
      const service = buildInvoicesService({ country: 'MX' });

      const { invoices } = await service.getInvoices('uid-1');

      // Típicamente una factura anterior a que cargara su perfil fiscal.
      expect(invoices[0].cfdi.status).toBe('not_applicable');
      expect(invoices[0].cfdi.uuid).toBeNull();
    });

    it('expone el estado real y las descargas de un CFDI timbrado', async () => {
      const service = buildInvoicesService({
        country: 'MX',
        cfdis: new Map([
          [
            'in_1',
            {
              status: 'stamped',
              uuid: 'UUID-1',
              stampedAt: new Date('2026-08-04T12:00:00.000Z'),
              pdfPath: 'cfdis/uid-1/in_1.pdf',
              xmlPath: 'cfdis/uid-1/in_1.xml',
            },
          ],
        ]),
      });

      const { invoices } = await service.getInvoices('uid-1');

      expect(invoices[0].cfdi).toMatchObject({
        status: 'stamped',
        uuid: 'UUID-1',
        stampedAt: '2026-08-04T12:00:00.000Z',
        pdfUrl: 'https://signed.example/file',
      });
      // La segunda factura no tiene CFDI y no debe heredar el de la primera.
      expect(invoices[1].cfdi.status).toBe('not_applicable');
    });

    it('expone el código de error de un CFDI fallido', async () => {
      const service = buildInvoicesService({
        country: 'MX',
        cfdis: new Map([
          [
            'in_1',
            {
              status: 'failed',
              error: { code: 'rfc_not_found', message: 'RFC no inscrito' },
            },
          ],
        ]),
      });

      const { invoices } = await service.getInvoices('uid-1');

      expect(invoices[0].cfdi).toMatchObject({
        status: 'failed',
        error: { code: 'rfc_not_found' },
        pdfUrl: null,
      });
    });
  });
});
