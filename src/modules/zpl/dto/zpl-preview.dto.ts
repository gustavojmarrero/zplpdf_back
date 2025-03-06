export class ZplPreviewItemDto {
  img: string;  // Base64 de la imagen PNG
  qty: number;  // Cantidad de veces que se repite la etiqueta
}

export class ZplPreviewResponseDto {
  success: boolean;
  message: string;
  data: ZplPreviewItemDto[];
} 