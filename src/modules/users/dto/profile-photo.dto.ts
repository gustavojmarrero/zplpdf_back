import { ApiProperty } from '@nestjs/swagger';

export class ProfilePhotoResponseDto {
  @ApiProperty({
    description:
      'URL pública de la foto ya normalizada. Incluye un parámetro de versión ' +
      '(`?v=`) porque el objeto se sobrescribe siempre en la misma ruta: sin él, ' +
      'el navegador seguiría mostrando la foto anterior desde su caché.',
    example:
      'https://storage.googleapis.com/zplpdf-public-assets/users/abc123/avatar.webp?v=1755600000000',
  })
  photoURL: string;
}
