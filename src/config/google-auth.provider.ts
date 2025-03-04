import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const GoogleAuthProvider: Provider = {
  provide: 'GOOGLE_AUTH_OPTIONS',
  useFactory: (configService: ConfigService) => {
    // Obtener las credenciales del archivo .env
    const credentials = configService.get<string>('GOOGLE_CREDENTIALS');
    
    // Si las credenciales existen, convertirlas de string a objeto
    if (credentials) {
      try {
        return { credentials: JSON.parse(credentials) };
      } catch (error) {
        console.error('Error al parsear GOOGLE_CREDENTIALS:', error);
      }
    }
    
    // Si no hay credenciales o hay un error, retornar objeto vacío
    // (se usará la autenticación por defecto de Google Cloud)
    return {};
  },
  inject: [ConfigService],
}; 