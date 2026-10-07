# Melochi

Mascota de escritorio tipo Tamagotchi para Windows. El diseño completo está en [docs/GDD.md](docs/GDD.md).

**Estado:** fase 1 (mascota viva). Spotify, el chat con IA y los minijuegos llegan en las siguientes fases.

## Requisitos

- Windows 10/11
- Node.js 22.12 o superior (recomendado: 24 LTS)

## Arrancar

```bash
npm install
npm run dev
```

`npm run dev` compila y abre el juego. La primera vez te pide idioma y nombre para la mascota.

Otros comandos:

| Comando | Qué hace |
|---|---|
| `npm run build` | Compila a `dist/` |
| `npm start` | Abre el juego ya compilado |
| `npm run watch` | Recompila al guardar (luego cierra y vuelve a abrir el juego) |
| `npm run typecheck` | Comprueba los tipos de TypeScript |
| `npm run gen:placeholder` | Regenera la skin provisional |

## Cómo se juega

- **Clic** en la mascota: te saluda. **Varios clics rápidos**: cosquillas.
- **Pasa el cursor de lado a lado** por encima: caricias.
- **Arrástrala** y suéltala con impulso para lanzarla (sin pasarte, que se marea).
- **Clic derecho**: inventario, estado, "No molestar", mandarla a casa, ajustes.
- Al jugar con ella **suelta objetos**: haz clic en ellos para recogerlos y dáselos desde el inventario (clic o arrastrando hasta ella).
- También hay un icono en la bandeja del sistema con el mismo menú.

## Personalizar

En desarrollo, todo se lee directamente de las carpetas del proyecto y se recarga al guardar:

| Carpeta | Contenido |
|---|---|
| `skins/<nombre>/` | Gráficos y sonidos. Copia `skins/placeholder` como plantilla; `skin.json` explica el formato. |
| `config/stats.json` | Velocidad a la que bajan las necesidades, efectos de cada interacción, mosqueo y afinidad. |
| `config/moods.json` | Estados de ánimo: condiciones, animaciones, comportamiento (y en la fase 2, playlists). |
| `config/items.json` | Objetos y sus efectos. |
| `config/loot.json` | Qué objetos suelta con cada actividad. |
| `locales/es.json`, `locales/en.json` | Textos y frases de los bocadillos. |

### Formato de las skins

Cada animación puede ser una **carpeta de PNG numerados** o una **sprite sheet** exportada desde Aseprite o TexturePacker (JSON en formato hash o array, sin rotación). Las variantes por mood se llaman `<mood>_<animación>` (por ejemplo `feliz_idle`); si no existen, se usa la genérica. La skin provisional incluye ejemplos de los tres casos.

Animaciones que usa el juego: `idle`, `walk`, `drag`, `fall`, `eat`, `drink`, `happy`, `angry`, `talk`, `petted`. Solo `idle` es obligatoria: el resto, si faltan, se sustituyen por la más parecida.

Los iconos de los objetos van en `skins/<nombre>/items/<id>.png`.

La partida se guarda en `%APPDATA%/Melochi/save.json` (borra ese archivo para empezar con una mascota nueva).

## Pruebas

Para probar sin tocar tu partida, usa otra carpeta de datos y activa los depuradores:

```bash
MELOCHI_USER_DATA=/ruta/a/partida-de-prueba ./node_modules/electron/dist/electron.exe . --remote-debugging-port=9333 --inspect=9334
```

En `tools/` hay scripts que se conectan a esos puertos:

| Script | Qué hace |
|---|---|
| `tools/cdp.mjs` | Lista ventanas, evalúa código, hace capturas y muestra la consola del renderer (`main` = proceso principal en el puerto 9334). |
| `tools/interact.mjs` | Simula toques, cosquillas, caricias, abrir paneles, dar objetos y recoger drops. |
| `tools/realmouse.mjs` | Prueba con el ratón real de Windows: clic a través, arrastrar, lanzar y menú contextual. Mueve tu cursor. |
| `tools/exstyle.mjs` | Muestra si la ventana deja pasar el ratón (`WS_EX_TRANSPARENT`). |
