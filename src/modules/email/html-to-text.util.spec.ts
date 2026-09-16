import { htmlToPlainText } from './html-to-text.util.js';

describe('htmlToPlainText', () => {
  it('convierte cada enlace en «texto (URL)»', () => {
    expect(
      htmlToPlainText(
        '<p>Ve a tus <a href="https://zplpdf.com/es">ajustes</a>.</p>',
      ),
    ).toBe('Ve a tus ajustes (https://zplpdf.com/es).');
  });

  it('no duplica la URL cuando el texto del enlace ya es la URL', () => {
    expect(
      htmlToPlainText('<a href="https://zplpdf.com">https://zplpdf.com</a>'),
    ).toBe('https://zplpdf.com');
  });

  it('quita las etiquetas anidadas dentro del texto del enlace', () => {
    expect(
      htmlToPlainText(
        '<a style="x" href="https://a.b"><strong>Ir</strong></a>',
      ),
    ).toBe('Ir (https://a.b)');
  });

  it('sin enlaces se comporta como antes: quita etiquetas y normaliza espacios', () => {
    expect(htmlToPlainText('<p>Hola</p>\n  <p>mundo</p>')).toBe('Hola mundo');
  });
});
