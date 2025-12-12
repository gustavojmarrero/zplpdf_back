import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../cache/firestore.service.js';
import { EnterpriseContactDto, EnterpriseContactResponseDto } from './dto/enterprise-contact.dto.js';

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);

  constructor(private readonly firestoreService: FirestoreService) {}

  async submitEnterpriseContact(
    dto: EnterpriseContactDto,
  ): Promise<EnterpriseContactResponseDto> {
    try {
      await this.firestoreService.saveEnterpriseContact({
        companyName: dto.companyName,
        contactName: dto.contactName,
        email: dto.email,
        phone: dto.phone,
        estimatedLabelsPerMonth: dto.estimatedLabelsPerMonth,
        message: dto.message,
      });

      this.logger.log(`Enterprise contact submitted: ${dto.email}`);

      return {
        success: true,
        message: 'Your request has been submitted. We will contact you soon.',
      };
    } catch (error) {
      this.logger.error(`Error submitting enterprise contact: ${error.message}`);
      throw error;
    }
  }
}
